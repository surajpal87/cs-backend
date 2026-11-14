import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { PresenceService } from '../common/redis/presence.service';
import { pair } from '../common/utils/ids';

export const PUBLIC_USER_SELECT = {
  id: true,
  csId: true,
  username: true,
  createdAt: true,
  profile: { select: { displayName: true, avatarPreset: true, avatarUrl: true, country: true, showOnlineStatus: true } },
} satisfies Prisma.UserSelect;

export type PublicUserRow = Prisma.UserGetPayload<{ select: typeof PUBLIC_USER_SELECT }>;

export function publicUser(u: PublicUserRow, online?: boolean) {
  return {
    id: u.id,
    csId: u.csId,
    username: u.username,
    displayName: u.profile?.displayName ?? u.username,
    avatarPreset: u.profile?.avatarPreset ?? 'royal-1',
    avatarUrl: u.profile?.avatarUrl ?? null,
    country: u.profile?.country ?? null,
    online: u.profile?.showOnlineStatus === false ? null : (online ?? null),
  };
}

export interface UpdateProfileInput {
  displayName?: string;
  bio?: string | null;
  country?: string | null;
  avatarPreset?: string;
  showOnlineStatus?: boolean;
  allowFriendRequests?: boolean;
  allowRoomInvites?: boolean;
  tableTheme?: string;
  preferences?: Record<string, unknown>;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly audit: AuditService,
  ) {}

  async blockedEitherWay(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.userBlock.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    });
    return new Set(rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)));
  }

  async isBlocked(a: string, b: string): Promise<boolean> {
    const n = await this.prisma.userBlock.count({
      where: {
        OR: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
    });
    return n > 0;
  }

  async search(viewerId: string, q: string) {
    const term = q.trim();
    if (term.length < 2) return { items: [] };
    const blocked = await this.blockedEitherWay(viewerId);
    const rows = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        id: { not: viewerId, notIn: [...blocked] },
        OR: [
          { username: { startsWith: term } },
          { csId: term.toUpperCase() },
          { profile: { displayName: { contains: term } } },
        ],
      },
      select: PUBLIC_USER_SELECT,
      take: 20,
      orderBy: { username: 'asc' },
    });
    const online = await this.presence.onlineAmong(rows.map((r) => r.id));
    const rel = await this.relationships(
      viewerId,
      rows.map((r) => r.id),
    );
    return { items: rows.map((r) => ({ ...publicUser(r, online.has(r.id)), relationship: rel.get(r.id) ?? 'NONE' })) };
  }

  /** Friendship status between viewer and each target. */
  async relationships(viewerId: string, ids: string[]): Promise<Map<string, 'FRIEND' | 'REQUEST_SENT' | 'REQUEST_RECEIVED' | 'NONE'>> {
    const out = new Map<string, 'FRIEND' | 'REQUEST_SENT' | 'REQUEST_RECEIVED' | 'NONE'>();
    if (!ids.length) return out;
    const friends = await this.prisma.friendship.findMany({
      where: {
        OR: [
          { userAId: viewerId, userBId: { in: ids } },
          { userBId: viewerId, userAId: { in: ids } },
        ],
      },
    });
    for (const f of friends) out.set(f.userAId === viewerId ? f.userBId : f.userAId, 'FRIEND');
    const reqs = await this.prisma.friendRequest.findMany({
      where: {
        status: 'PENDING',
        OR: [
          { senderId: viewerId, receiverId: { in: ids } },
          { receiverId: viewerId, senderId: { in: ids } },
        ],
      },
    });
    for (const r of reqs) {
      const other = r.senderId === viewerId ? r.receiverId : r.senderId;
      if (!out.has(other)) out.set(other, r.senderId === viewerId ? 'REQUEST_SENT' : 'REQUEST_RECEIVED');
    }
    return out;
  }

  async stats(userId: string) {
    const rows = await this.prisma.gameHistory.groupBy({
      by: ['gameId', 'outcome'],
      where: { userId },
      _count: { _all: true },
      _sum: { pointsDelta: true },
    });
    const games = await this.prisma.game.findMany({ select: { id: true, code: true, name: true } });
    const byGame = new Map<string, { code: string; name: string; played: number; wins: number; net: number }>();
    let played = 0;
    let wins = 0;
    let net = 0;
    for (const r of rows) {
      const g = games.find((x) => x.id === r.gameId);
      if (!g) continue;
      const e = byGame.get(g.code) ?? { code: g.code, name: g.name, played: 0, wins: 0, net: 0 };
      e.played += r._count._all;
      if (r.outcome === 'WIN') e.wins += r._count._all;
      e.net += r._sum.pointsDelta ?? 0;
      byGame.set(g.code, e);
      played += r._count._all;
      if (r.outcome === 'WIN') wins += r._count._all;
      net += r._sum.pointsDelta ?? 0;
    }
    return { played, wins, winRate: played ? Math.round((wins / played) * 1000) / 10 : 0, net, byGame: [...byGame.values()] };
  }

  async publicProfile(viewerId: string, idOrCsId: string) {
    const where = /^CS\d+$/i.test(idOrCsId) ? { csId: idOrCsId.toUpperCase() } : { id: idOrCsId };
    const u = await this.prisma.user.findFirst({
      where: { ...where, status: { in: ['ACTIVE', 'SUSPENDED'] } },
      select: { ...PUBLIC_USER_SELECT, profile: { select: { ...PUBLIC_USER_SELECT.profile.select, bio: true } } },
    });
    if (!u) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Player not found' });
    if (u.id !== viewerId && (await this.isBlocked(viewerId, u.id)))
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Player not found' });
    const [online, rel, stats, achievements, associations, friendCount, blockedByMe] = await Promise.all([
      this.presence.isOnline(u.id),
      this.relationships(viewerId, [u.id]),
      this.stats(u.id),
      this.prisma.userAchievement.findMany({ where: { userId: u.id }, include: { achievement: true }, orderBy: { unlockedAt: 'desc' } }),
      this.prisma.associationMember.findMany({
        where: { userId: u.id, status: 'ACTIVE', association: { deletedAt: null } },
        include: { association: { select: { id: true, publicId: true, name: true, emblem: true, visibility: true } } },
      }),
      this.prisma.friendship.count({ where: { OR: [{ userAId: u.id }, { userBId: u.id }] } }),
      this.prisma.userBlock.count({ where: { blockerId: viewerId, blockedId: u.id } }),
    ]);
    return {
      ...publicUser(u, online),
      bio: u.profile?.bio ?? null,
      registeredAt: u.createdAt,
      relationship: u.id === viewerId ? 'SELF' : (rel.get(u.id) ?? 'NONE'),
      blockedByMe: blockedByMe > 0,
      friendCount,
      stats,
      achievements: achievements.map((a) => ({
        code: a.achievement.code,
        name: a.achievement.name,
        icon: a.achievement.icon,
        unlockedAt: a.unlockedAt,
      })),
      associations: associations
        .filter((a) => a.association.visibility === 'PUBLIC' || u.id === viewerId)
        .map((a) => ({ ...a.association, role: a.role })),
    };
  }

  async updateProfile(userId: string, input: UpdateProfileInput) {
    const data: Prisma.ProfileUpdateInput = { ...input, preferences: input.preferences as Prisma.InputJsonValue | undefined };
    await this.prisma.profile.update({ where: { userId }, data });
    return this.prisma.profile.findUniqueOrThrow({ where: { userId } });
  }

  async block(userId: string, targetId: string) {
    if (userId === targetId) throw new BadRequestException('You cannot block yourself');
    await this.prisma.user.findUniqueOrThrow({ where: { id: targetId } });
    const [a, b] = pair(userId, targetId);
    await this.prisma.$transaction([
      this.prisma.userBlock.upsert({
        where: { blockerId_blockedId: { blockerId: userId, blockedId: targetId } },
        create: { blockerId: userId, blockedId: targetId },
        update: {},
      }),
      this.prisma.friendship.deleteMany({ where: { userAId: a, userBId: b } }),
      this.prisma.friendRequest.updateMany({
        where: {
          status: 'PENDING',
          OR: [
            { senderId: userId, receiverId: targetId },
            { senderId: targetId, receiverId: userId },
          ],
        },
        data: { status: 'CANCELLED', respondedAt: new Date() },
      }),
    ]);
    return { ok: true };
  }

  async unblock(userId: string, targetId: string) {
    await this.prisma.userBlock.deleteMany({ where: { blockerId: userId, blockedId: targetId } });
    return { ok: true };
  }

  async blocked(userId: string) {
    const rows = await this.prisma.userBlock.findMany({
      where: { blockerId: userId },
      include: { blocked: { select: PUBLIC_USER_SELECT } },
    });
    return { items: rows.map((r) => ({ ...publicUser(r.blocked), blockedAt: r.createdAt })) };
  }

  async report(userId: string, targetId: string, reason: string, details?: string, messageId?: string) {
    if (userId === targetId) throw new BadRequestException('You cannot report yourself');
    await this.prisma.user.findUniqueOrThrow({ where: { id: targetId } });
    const recent = await this.prisma.userReport.count({
      where: { reporterId: userId, reportedId: targetId, createdAt: { gt: new Date(Date.now() - 86_400_000) } },
    });
    if (recent >= 3) throw new BadRequestException({ code: 'REPORT_LIMIT', message: 'You have already reported this player today' });
    const r = await this.prisma.userReport.create({ data: { reporterId: userId, reportedId: targetId, reason, details, messageId } });
    return { id: r.id, status: r.status };
  }

  /** GDPR-style deletion: anonymise PII, revoke sessions, leave social graph. Game history is kept anonymised. */
  async deleteAccount(userId: string, password: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await argon2.verify(user.passwordHash, password)))
      throw new ForbiddenException({ code: 'INVALID_PASSWORD', message: 'Password is incorrect' });
    const owned = await this.prisma.association.count({ where: { ownerId: userId, deletedAt: null } });
    if (owned > 0)
      throw new BadRequestException({
        code: 'OWNS_ASSOCIATION',
        message: 'Transfer or delete your associations before deleting your account',
      });
    const seated = await this.prisma.roomPlayer.count({ where: { userId, status: 'SEATED' } });
    if (seated > 0) throw new BadRequestException({ code: 'SEATED', message: 'Leave all game tables before deleting your account' });
    const tag = userId.slice(0, 8);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          status: 'DELETED',
          deletedAt: new Date(),
          email: `deleted+${userId}@deleted.invalid`,
          username: `deleted_${tag}`,
          passwordHash: '!',
        },
      }),
      this.prisma.profile.update({ where: { userId }, data: { displayName: 'Deleted Player', bio: null, avatarUrl: null, country: null } }),
      this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.friendship.deleteMany({ where: { OR: [{ userAId: userId }, { userBId: userId }] } }),
      this.prisma.friendRequest.deleteMany({ where: { OR: [{ senderId: userId }, { receiverId: userId }] } }),
      this.prisma.associationMember.deleteMany({ where: { userId } }),
      this.prisma.deviceToken.deleteMany({ where: { userId } }),
      this.prisma.otpVerification.deleteMany({ where: { userId } }),
    ]);
    await this.audit.record({ actorType: 'USER', actorId: userId, action: 'account.deleted' });
    return { ok: true };
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AssociationJoinPolicy, AssociationRole, AssociationVisibility, Prisma } from '@prisma/client';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { PresenceService } from '../common/redis/presence.service';
import { publicId } from '../common/utils/ids';
import { ChatService, sanitizeText } from '../chat/chat.service';
import { AchievementsService } from '../leaderboard/achievements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PUBLIC_USER_SELECT, publicUser } from '../users/users.service';

const MAX_OWNED = 3;
const ROLE_RANK: Record<AssociationRole, number> = { OWNER: 3, ADMIN: 2, MEMBER: 1 };

export interface AssociationInput {
  name: string;
  description?: string;
  visibility?: AssociationVisibility;
  joinPolicy?: AssociationJoinPolicy;
  emblem?: string;
  maxMembers?: number;
}

@Injectable()
export class AssociationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    private readonly presence: PresenceService,
    private readonly achievements: AchievementsService,
    private readonly audit: AuditService,
  ) {}

  private async find(idOrPublic: string) {
    const where = /^AS\d+$/i.test(idOrPublic) ? { publicId: idOrPublic.toUpperCase() } : { id: idOrPublic };
    const a = await this.prisma.association.findFirst({ where: { ...where, deletedAt: null } });
    if (!a) throw new NotFoundException({ code: 'ASSOCIATION_NOT_FOUND', message: 'Association not found' });
    return a;
  }

  private async member(associationId: string, userId: string) {
    return this.prisma.associationMember.findUnique({ where: { associationId_userId: { associationId, userId } } });
  }

  /** Throws unless the user is an ACTIVE member with at least `min` role. */
  async requireRole(associationId: string, userId: string, min: AssociationRole) {
    const m = await this.member(associationId, userId);
    if (!m || m.status !== 'ACTIVE' || ROLE_RANK[m.role] < ROLE_RANK[min]) {
      throw new ForbiddenException({ code: 'ASSOCIATION_FORBIDDEN', message: `This action requires ${min.toLowerCase()} rights` });
    }
    return m;
  }

  async create(userId: string, input: AssociationInput) {
    const owned = await this.prisma.association.count({ where: { ownerId: userId, deletedAt: null } });
    if (owned >= MAX_OWNED)
      throw new BadRequestException({ code: 'ASSOCIATION_LIMIT', message: `You can own at most ${MAX_OWNED} associations` });
    const name = sanitizeText(input.name, 48);
    const clash = await this.prisma.association.findFirst({ where: { name: { equals: name }, deletedAt: null } });
    if (clash) throw new ConflictException({ code: 'NAME_TAKEN', message: 'An association with this name already exists' });
    const a = await this.prisma.$transaction(async (tx) => {
      const created = await tx.association.create({
        data: {
          publicId: publicId('AS', 7),
          name,
          description: input.description ? sanitizeText(input.description, 500) : null,
          visibility: input.visibility ?? 'PUBLIC',
          joinPolicy: input.joinPolicy ?? 'APPROVAL',
          emblem: input.emblem ?? 'crown',
          maxMembers: input.maxMembers ?? 200,
          ownerId: userId,
          members: { create: { userId, role: 'OWNER' } },
        },
      });
      await this.chat.createLinkedRoom(tx, 'ASSOCIATION', created.id, created.name, [userId]);
      return created;
    });
    await this.achievements.evaluate(userId);
    return this.details(userId, a.id);
  }

  async discover(userId: string, q?: string) {
    const rows = await this.prisma.association.findMany({
      where: {
        deletedAt: null,
        visibility: 'PUBLIC',
        ...(q ? { OR: [{ name: { contains: q } }, { publicId: q.toUpperCase() }] } : {}),
      },
      orderBy: [{ memberCount: 'desc' }, { createdAt: 'desc' }],
      take: 30,
      include: { owner: { select: PUBLIC_USER_SELECT } },
    });
    const mine = await this.prisma.associationMember.findMany({ where: { userId, associationId: { in: rows.map((r) => r.id) } } });
    const status = new Map(mine.map((m) => [m.associationId, m.status]));
    return { items: rows.map((a) => ({ ...this.card(a), owner: publicUser(a.owner), myStatus: status.get(a.id) ?? null })) };
  }

  async mine(userId: string) {
    const rows = await this.prisma.associationMember.findMany({
      where: { userId, association: { deletedAt: null } },
      include: { association: true },
      orderBy: { joinedAt: 'desc' },
    });
    return { items: rows.map((m) => ({ ...this.card(m.association), myRole: m.role, myStatus: m.status })) };
  }

  private card(a: Prisma.AssociationGetPayload<object>) {
    return {
      id: a.id,
      publicId: a.publicId,
      name: a.name,
      description: a.description,
      emblem: a.emblem,
      visibility: a.visibility,
      joinPolicy: a.joinPolicy,
      memberCount: a.memberCount,
      maxMembers: a.maxMembers,
      createdAt: a.createdAt,
    };
  }

  async details(userId: string, idOrPublic: string) {
    const a = await this.find(idOrPublic);
    const me = await this.member(a.id, userId);
    const invited = await this.prisma.associationInvitation.findFirst({
      where: { associationId: a.id, inviteeId: userId, status: 'PENDING' },
    });
    const isMember = me?.status === 'ACTIVE';
    if (a.visibility === 'PRIVATE' && !isMember && !invited)
      throw new NotFoundException({ code: 'ASSOCIATION_NOT_FOUND', message: 'Association not found' });
    const [owner, chatRoom, rooms, pendingCount] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: a.ownerId }, select: PUBLIC_USER_SELECT }),
      isMember ? this.prisma.chatRoom.findUnique({ where: { associationId: a.id }, select: { id: true } }) : null,
      isMember
        ? this.prisma.room.findMany({
            where: { associationId: a.id, status: { not: 'CLOSED' } },
            include: { game: { select: { code: true, name: true } }, _count: { select: { players: { where: { status: 'SEATED' } } } } },
          })
        : [],
      me && ROLE_RANK[me.role] >= ROLE_RANK.ADMIN
        ? this.prisma.associationMember.count({ where: { associationId: a.id, status: 'PENDING' } })
        : 0,
    ]);
    return {
      ...this.card(a),
      owner: publicUser(owner),
      myRole: isMember ? me!.role : null,
      myStatus: me?.status ?? null,
      invitationId: invited?.id ?? null,
      chatRoomId: chatRoom?.id ?? null,
      pendingRequests: pendingCount,
      rooms: rooms.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        status: r.status,
        game: r.game,
        players: r._count.players,
        maxPlayers: r.maxPlayers,
      })),
    };
  }

  async update(userId: string, id: string, input: Partial<AssociationInput>) {
    const a = await this.find(id);
    await this.requireRole(a.id, userId, 'ADMIN');
    if (input.name && input.name !== a.name) {
      const clash = await this.prisma.association.findFirst({
        where: { name: { equals: input.name }, deletedAt: null, NOT: { id: a.id } },
      });
      if (clash) throw new ConflictException({ code: 'NAME_TAKEN', message: 'An association with this name already exists' });
    }
    if (input.maxMembers !== undefined && input.maxMembers < a.memberCount)
      throw new BadRequestException('Max members cannot be below the current member count');
    await this.prisma.association.update({
      where: { id: a.id },
      data: {
        name: input.name ? sanitizeText(input.name, 48) : undefined,
        description: input.description !== undefined ? sanitizeText(input.description, 500) : undefined,
        visibility: input.visibility,
        joinPolicy: input.joinPolicy,
        emblem: input.emblem,
        maxMembers: input.maxMembers,
      },
    });
    return this.details(userId, a.id);
  }

  async remove(userId: string, id: string) {
    const a = await this.find(id);
    await this.requireRole(a.id, userId, 'OWNER');
    await this.prisma.association.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
    await this.audit.record({
      actorType: 'USER',
      actorId: userId,
      action: 'association.deleted',
      targetType: 'association',
      targetId: a.id,
    });
    return { ok: true };
  }

  private async activate(associationId: string, userId: string) {
    await this.prisma.$transaction(async (tx) => {
      const a = await tx.association.findUniqueOrThrow({ where: { id: associationId } });
      if (a.memberCount >= a.maxMembers) throw new BadRequestException({ code: 'ASSOCIATION_FULL', message: 'This association is full' });
      await tx.associationMember.upsert({
        where: { associationId_userId: { associationId, userId } },
        create: { associationId, userId, status: 'ACTIVE' },
        update: { status: 'ACTIVE', role: 'MEMBER', joinedAt: new Date() },
      });
      await tx.association.update({ where: { id: associationId }, data: { memberCount: { increment: 1 } } });
      const chat = await tx.chatRoom.findUnique({ where: { associationId } });
      if (chat) await this.chat.addMember(chat.id, userId, tx);
    });
    const chat = await this.prisma.chatRoom.findUnique({ where: { associationId } });
    if (chat) await this.chat.systemMessage(chat.id, 'A new member joined the association');
    await this.achievements.evaluate(userId);
  }

  async join(userId: string, id: string) {
    const a = await this.find(id);
    const m = await this.member(a.id, userId);
    if (m?.status === 'ACTIVE') throw new BadRequestException({ code: 'ALREADY_MEMBER', message: 'You are already a member' });
    if (m?.status === 'BANNED') throw new ForbiddenException({ code: 'BANNED', message: 'You are banned from this association' });
    if (m?.status === 'PENDING') return { status: 'PENDING' };
    const invite = await this.prisma.associationInvitation.findFirst({
      where: { associationId: a.id, inviteeId: userId, status: 'PENDING' },
    });
    if (invite) return this.respondInvitation(userId, invite.id, true);
    if (a.visibility === 'PRIVATE' || a.joinPolicy === 'INVITE_ONLY') {
      throw new ForbiddenException({ code: 'INVITE_ONLY', message: 'This association is invite only' });
    }
    if (a.joinPolicy === 'OPEN') {
      await this.activate(a.id, userId);
      return { status: 'ACTIVE' };
    }
    await this.prisma.associationMember.create({ data: { associationId: a.id, userId, status: 'PENDING' } });
    const admins = await this.prisma.associationMember.findMany({
      where: { associationId: a.id, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
    });
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: PUBLIC_USER_SELECT });
    for (const ad of admins) {
      await this.notifications.notify(
        ad.userId,
        'ASSOCIATION_REQUEST',
        `Join request: ${a.name}`,
        `${publicUser(me).displayName} wants to join`,
        { associationId: a.id, userId },
      );
    }
    return { status: 'PENDING' };
  }

  async leave(userId: string, id: string) {
    const a = await this.find(id);
    const m = await this.member(a.id, userId);
    if (!m) throw new NotFoundException({ code: 'NOT_MEMBER', message: 'You are not a member' });
    if (m.role === 'OWNER') throw new BadRequestException({ code: 'OWNER_CANNOT_LEAVE', message: 'Transfer ownership before leaving' });
    await this.detach(a.id, userId, m.status === 'ACTIVE');
    return { ok: true };
  }

  private async detach(associationId: string, userId: string, wasActive: boolean) {
    await this.prisma.$transaction(async (tx) => {
      await tx.associationMember.delete({ where: { associationId_userId: { associationId, userId } } });
      if (wasActive) await tx.association.update({ where: { id: associationId }, data: { memberCount: { decrement: 1 } } });
      const chat = await tx.chatRoom.findUnique({ where: { associationId } });
      if (chat) await this.chat.removeMember(chat.id, userId, tx);
    });
  }

  async members(userId: string, id: string, status: 'ACTIVE' | 'PENDING' | 'BANNED' = 'ACTIVE') {
    const a = await this.find(id);
    const me = await this.member(a.id, userId);
    if (status !== 'ACTIVE') await this.requireRole(a.id, userId, 'ADMIN');
    else if (a.visibility === 'PRIVATE' && me?.status !== 'ACTIVE') throw new ForbiddenException('Members only');
    const rows = await this.prisma.associationMember.findMany({
      where: { associationId: a.id, status },
      include: { user: { select: PUBLIC_USER_SELECT } },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    });
    const online = await this.presence.onlineAmong(rows.map((r) => r.userId));
    return {
      items: rows
        .map((r) => ({
          ...publicUser(r.user, online.has(r.userId)),
          role: r.role,
          status: r.status,
          joinedAt: r.joinedAt,
          lastActiveAt: r.lastActiveAt,
        }))
        .sort((x, y) => ROLE_RANK[y.role] - ROLE_RANK[x.role]),
    };
  }

  async decideRequest(userId: string, id: string, targetId: string, approve: boolean) {
    const a = await this.find(id);
    await this.requireRole(a.id, userId, 'ADMIN');
    const m = await this.member(a.id, targetId);
    if (!m || m.status !== 'PENDING') throw new NotFoundException({ code: 'REQUEST_NOT_FOUND', message: 'No pending request' });
    if (approve) {
      await this.activate(a.id, targetId);
      await this.notifications.notify(targetId, 'ASSOCIATION_APPROVED', `Welcome to ${a.name}`, 'Your join request was approved', {
        associationId: a.id,
      });
    } else {
      await this.prisma.associationMember.delete({ where: { associationId_userId: { associationId: a.id, userId: targetId } } });
    }
    return { status: approve ? 'ACTIVE' : 'REJECTED' };
  }

  async invite(userId: string, id: string, inviteeId: string) {
    const a = await this.find(id);
    await this.requireRole(a.id, userId, a.joinPolicy === 'OPEN' ? 'MEMBER' : 'ADMIN');
    const invitee = await this.prisma.user.findFirst({ where: { id: inviteeId, status: 'ACTIVE' } });
    if (!invitee) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Player not found' });
    const existing = await this.member(a.id, inviteeId);
    if (existing?.status === 'ACTIVE') throw new BadRequestException({ code: 'ALREADY_MEMBER', message: 'Player is already a member' });
    if (existing?.status === 'BANNED') throw new BadRequestException({ code: 'BANNED', message: 'Player is banned from this association' });
    const pending = await this.prisma.associationInvitation.findFirst({ where: { associationId: a.id, inviteeId, status: 'PENDING' } });
    if (pending) return { id: pending.id, status: 'PENDING' };
    const inv = await this.prisma.associationInvitation.create({ data: { associationId: a.id, inviterId: userId, inviteeId } });
    await this.notifications.notify(
      inviteeId,
      'ASSOCIATION_INVITE',
      `Invitation to ${a.name}`,
      'You have been invited to join an association',
      {
        associationId: a.id,
        invitationId: inv.id,
      },
    );
    return { id: inv.id, status: 'PENDING' };
  }

  async myInvitations(userId: string) {
    const rows = await this.prisma.associationInvitation.findMany({
      where: { inviteeId: userId, status: 'PENDING', association: { deletedAt: null } },
      include: { association: true, inviter: { select: PUBLIC_USER_SELECT } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      items: rows.map((r) => ({ id: r.id, createdAt: r.createdAt, association: this.card(r.association), inviter: publicUser(r.inviter) })),
    };
  }

  async sentInvitations(userId: string, id: string) {
    const a = await this.find(id);
    await this.requireRole(a.id, userId, 'ADMIN');
    const rows = await this.prisma.associationInvitation.findMany({
      where: { associationId: a.id, status: 'PENDING' },
      include: { invitee: { select: PUBLIC_USER_SELECT } },
    });
    return { items: rows.map((r) => ({ id: r.id, createdAt: r.createdAt, invitee: publicUser(r.invitee) })) };
  }

  async respondInvitation(userId: string, invitationId: string, accept: boolean) {
    const inv = await this.prisma.associationInvitation.findUnique({ where: { id: invitationId } });
    if (!inv || inv.inviteeId !== userId || inv.status !== 'PENDING')
      throw new NotFoundException({ code: 'INVITATION_NOT_FOUND', message: 'Invitation not found' });
    await this.prisma.associationInvitation.update({
      where: { id: inv.id },
      data: { status: accept ? 'ACCEPTED' : 'REJECTED', respondedAt: new Date() },
    });
    if (accept) {
      const m = await this.member(inv.associationId, userId);
      if (m?.status === 'BANNED') throw new ForbiddenException({ code: 'BANNED', message: 'You are banned from this association' });
      if (m?.status !== 'ACTIVE') await this.activate(inv.associationId, userId);
    }
    return { status: accept ? 'ACTIVE' : 'REJECTED' };
  }

  async cancelInvitation(userId: string, id: string, invitationId: string) {
    const a = await this.find(id);
    await this.requireRole(a.id, userId, 'ADMIN');
    const res = await this.prisma.associationInvitation.updateMany({
      where: { id: invitationId, associationId: a.id, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    if (!res.count) throw new NotFoundException({ code: 'INVITATION_NOT_FOUND', message: 'Invitation not found' });
    return { ok: true };
  }

  async setRole(userId: string, id: string, targetId: string, role: 'ADMIN' | 'MEMBER') {
    const a = await this.find(id);
    await this.requireRole(a.id, userId, 'OWNER');
    const m = await this.member(a.id, targetId);
    if (!m || m.status !== 'ACTIVE' || m.role === 'OWNER') throw new BadRequestException('Cannot change this member');
    await this.prisma.associationMember.update({
      where: { associationId_userId: { associationId: a.id, userId: targetId } },
      data: { role },
    });
    return { ok: true, role };
  }

  async kick(userId: string, id: string, targetId: string, ban = false) {
    const a = await this.find(id);
    const me = await this.requireRole(a.id, userId, 'ADMIN');
    const m = await this.member(a.id, targetId);
    if (!m) throw new NotFoundException({ code: 'NOT_MEMBER', message: 'Not a member' });
    if (targetId === userId || ROLE_RANK[m.role] >= ROLE_RANK[me.role]) throw new ForbiddenException('You cannot remove this member');
    if (ban) {
      await this.prisma.$transaction(async (tx) => {
        await tx.associationMember.update({
          where: { associationId_userId: { associationId: a.id, userId: targetId } },
          data: { status: 'BANNED', role: 'MEMBER' },
        });
        if (m.status === 'ACTIVE') await tx.association.update({ where: { id: a.id }, data: { memberCount: { decrement: 1 } } });
        const chat = await tx.chatRoom.findUnique({ where: { associationId: a.id } });
        if (chat) await this.chat.removeMember(chat.id, targetId, tx);
      });
    } else await this.detach(a.id, targetId, m.status === 'ACTIVE');
    return { ok: true };
  }

  async unban(userId: string, id: string, targetId: string) {
    const a = await this.find(id);
    await this.requireRole(a.id, userId, 'ADMIN');
    await this.prisma.associationMember.deleteMany({ where: { associationId: a.id, userId: targetId, status: 'BANNED' } });
    return { ok: true };
  }

  async transfer(userId: string, id: string, targetId: string) {
    const a = await this.find(id);
    await this.requireRole(a.id, userId, 'OWNER');
    const m = await this.member(a.id, targetId);
    if (!m || m.status !== 'ACTIVE') throw new BadRequestException('New owner must be an active member');
    await this.prisma.$transaction([
      this.prisma.associationMember.update({ where: { associationId_userId: { associationId: a.id, userId } }, data: { role: 'ADMIN' } }),
      this.prisma.associationMember.update({
        where: { associationId_userId: { associationId: a.id, userId: targetId } },
        data: { role: 'OWNER' },
      }),
      this.prisma.association.update({ where: { id: a.id }, data: { ownerId: targetId } }),
    ]);
    await this.audit.record({
      actorType: 'USER',
      actorId: userId,
      action: 'association.transferred',
      targetType: 'association',
      targetId: a.id,
      metadata: { to: targetId },
    });
    return { ok: true };
  }

  async activity(userId: string, id: string) {
    const a = await this.find(id);
    await this.requireRole(a.id, userId, 'MEMBER');
    const memberIds = (
      await this.prisma.associationMember.findMany({ where: { associationId: a.id, status: 'ACTIVE' }, select: { userId: true } })
    ).map((m) => m.userId);
    const [games, joins] = await Promise.all([
      this.prisma.gameHistory.findMany({
        where: { userId: { in: memberIds } },
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: { user: { select: PUBLIC_USER_SELECT }, game: { select: { code: true, name: true } } },
      }),
      this.prisma.associationMember.findMany({
        where: { associationId: a.id, status: 'ACTIVE' },
        orderBy: { joinedAt: 'desc' },
        take: 10,
        include: { user: { select: PUBLIC_USER_SELECT } },
      }),
    ]);
    const items = [
      ...games.map((g) => ({
        type: 'GAME' as const,
        at: g.createdAt,
        user: publicUser(g.user),
        game: g.game,
        outcome: g.outcome,
        pointsDelta: g.pointsDelta,
      })),
      ...joins.map((j) => ({ type: 'JOINED' as const, at: j.joinedAt, user: publicUser(j.user) })),
    ].sort((x, y) => +y.at - +x.at);
    return { items: items.slice(0, 40) };
  }
}

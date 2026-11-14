import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PresenceService } from '../common/redis/presence.service';
import { pair } from '../common/utils/ids';
import { AchievementsService } from '../leaderboard/achievements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PUBLIC_USER_SELECT, publicUser, UsersService } from '../users/users.service';

const MAX_FRIENDS = 500;

@Injectable()
export class FriendsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    private readonly achievements: AchievementsService,
  ) {}

  async friendIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.friendship.findMany({ where: { OR: [{ userAId: userId }, { userBId: userId }] } });
    return rows.map((r) => (r.userAId === userId ? r.userBId : r.userAId));
  }

  async list(userId: string) {
    const rows = await this.prisma.friendship.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
      include: { userA: { select: PUBLIC_USER_SELECT }, userB: { select: PUBLIC_USER_SELECT } },
    });
    const friends = rows.map((r) => ({ user: r.userAId === userId ? r.userB : r.userA, since: r.createdAt }));
    const online = await this.presence.onlineAmong(friends.map((f) => f.user.id));
    const items = friends
      .map((f) => ({ ...publicUser(f.user, online.has(f.user.id)), since: f.since }))
      .sort((a, b) => Number(b.online === true) - Number(a.online === true) || a.displayName.localeCompare(b.displayName));
    return { items, onlineCount: items.filter((i) => i.online).length };
  }

  async requests(userId: string) {
    const [incoming, outgoing] = await Promise.all([
      this.prisma.friendRequest.findMany({
        where: { receiverId: userId, status: 'PENDING' },
        include: { sender: { select: PUBLIC_USER_SELECT } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.friendRequest.findMany({
        where: { senderId: userId, status: 'PENDING' },
        include: { receiver: { select: PUBLIC_USER_SELECT } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      incoming: incoming.map((r) => ({ id: r.id, createdAt: r.createdAt, user: publicUser(r.sender) })),
      outgoing: outgoing.map((r) => ({ id: r.id, createdAt: r.createdAt, user: publicUser(r.receiver) })),
    };
  }

  async send(userId: string, targetId: string) {
    if (userId === targetId) throw new BadRequestException('You cannot add yourself');
    const target = await this.prisma.user.findFirst({ where: { id: targetId, status: 'ACTIVE' }, include: { profile: true } });
    if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Player not found' });
    if (await this.users.isBlocked(userId, targetId))
      throw new ForbiddenException({ code: 'BLOCKED', message: 'You cannot send a request to this player' });
    const [a, b] = pair(userId, targetId);
    if (await this.prisma.friendship.findUnique({ where: { userAId_userBId: { userAId: a, userBId: b } } })) {
      throw new BadRequestException({ code: 'ALREADY_FRIENDS', message: 'You are already friends' });
    }
    // If they already asked us, accept instead.
    const reverse = await this.prisma.friendRequest.findFirst({ where: { senderId: targetId, receiverId: userId, status: 'PENDING' } });
    if (reverse) return this.accept(userId, reverse.id);
    if (target.profile && !target.profile.allowFriendRequests) {
      throw new ForbiddenException({ code: 'REQUESTS_DISABLED', message: 'This player is not accepting friend requests' });
    }
    const pending = await this.prisma.friendRequest.findFirst({ where: { senderId: userId, receiverId: targetId, status: 'PENDING' } });
    if (pending) return { id: pending.id, status: 'PENDING' };
    const count = await this.prisma.friendship.count({ where: { OR: [{ userAId: userId }, { userBId: userId }] } });
    if (count >= MAX_FRIENDS) throw new BadRequestException({ code: 'FRIEND_LIMIT', message: `Friend limit of ${MAX_FRIENDS} reached` });
    const req = await this.prisma.friendRequest.create({ data: { senderId: userId, receiverId: targetId } });
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: PUBLIC_USER_SELECT });
    await this.notifications.notify(
      targetId,
      'FRIEND_REQUEST',
      'New friend request',
      `${publicUser(me).displayName} wants to be your friend`,
      {
        requestId: req.id,
        userId,
      },
    );
    this.realtime.toUser(targetId, 'friends:request', { id: req.id, user: publicUser(me) });
    return { id: req.id, status: 'PENDING' };
  }

  async accept(userId: string, requestId: string) {
    const req = await this.prisma.friendRequest.findUnique({ where: { id: requestId } });
    if (!req || req.receiverId !== userId || req.status !== 'PENDING')
      throw new NotFoundException({ code: 'REQUEST_NOT_FOUND', message: 'Request not found' });
    const [a, b] = pair(req.senderId, req.receiverId);
    await this.prisma.$transaction([
      this.prisma.friendRequest.update({ where: { id: requestId }, data: { status: 'ACCEPTED', respondedAt: new Date() } }),
      this.prisma.friendship.upsert({
        where: { userAId_userBId: { userAId: a, userBId: b } },
        create: { userAId: a, userBId: b },
        update: {},
      }),
    ]);
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: PUBLIC_USER_SELECT });
    await this.notifications.notify(
      req.senderId,
      'FRIEND_ACCEPTED',
      'Friend request accepted',
      `${publicUser(me).displayName} accepted your request`,
      { userId },
    );
    this.realtime.toUsers([req.senderId, userId], 'friends:changed', { type: 'added', users: [req.senderId, userId] });
    await Promise.all([this.achievements.evaluate(userId), this.achievements.evaluate(req.senderId)]);
    return { id: requestId, status: 'ACCEPTED' };
  }

  async reject(userId: string, requestId: string) {
    const res = await this.prisma.friendRequest.updateMany({
      where: { id: requestId, receiverId: userId, status: 'PENDING' },
      data: { status: 'REJECTED', respondedAt: new Date() },
    });
    if (!res.count) throw new NotFoundException({ code: 'REQUEST_NOT_FOUND', message: 'Request not found' });
    return { id: requestId, status: 'REJECTED' };
  }

  async cancel(userId: string, requestId: string) {
    const res = await this.prisma.friendRequest.updateMany({
      where: { id: requestId, senderId: userId, status: 'PENDING' },
      data: { status: 'CANCELLED', respondedAt: new Date() },
    });
    if (!res.count) throw new NotFoundException({ code: 'REQUEST_NOT_FOUND', message: 'Request not found' });
    return { id: requestId, status: 'CANCELLED' };
  }

  async remove(userId: string, friendId: string) {
    const [a, b] = pair(userId, friendId);
    const res = await this.prisma.friendship.deleteMany({ where: { userAId: a, userBId: b } });
    if (!res.count) throw new NotFoundException({ code: 'NOT_FRIENDS', message: 'Not in your friends list' });
    this.realtime.toUsers([userId, friendId], 'friends:changed', { type: 'removed', users: [userId, friendId] });
    return { ok: true };
  }
}

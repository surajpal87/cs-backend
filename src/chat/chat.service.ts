import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ChatRoomType, MessageType, Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import { PresenceService } from '../common/redis/presence.service';
import { pair } from '../common/utils/ids';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PUBLIC_USER_SELECT, publicUser, UsersService } from '../users/users.service';

const MAX_GROUP_MEMBERS = 50;

/** Strip control characters (except newline) and trim. Clients render text, never HTML. */
export function sanitizeText(input: string, max = 1000): string {
  // eslint-disable-next-line no-control-regex
  const s = input.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
  return s.slice(0, max);
}

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
    private readonly presence: PresenceService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Room provisioning (also used by associations & game rooms) ──

  async ensureDirect(userId: string, otherId: string) {
    if (userId === otherId) throw new BadRequestException('Cannot chat with yourself');
    const other = await this.prisma.user.findFirst({ where: { id: otherId, status: 'ACTIVE' } });
    if (!other) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Player not found' });
    if (await this.users.isBlocked(userId, otherId))
      throw new ForbiddenException({ code: 'BLOCKED', message: 'You cannot message this player' });
    const [a, b] = pair(userId, otherId);
    const key = `${a}:${b}`;
    const room = await this.prisma.chatRoom.upsert({
      where: { directKey: key },
      create: { type: 'DIRECT', directKey: key, createdById: userId, members: { create: [{ userId: a }, { userId: b }] } },
      update: {},
    });
    return this.roomSummary(userId, room.id);
  }

  async createGroup(userId: string, name: string, memberIds: string[]) {
    const ids = [...new Set(memberIds.filter((id) => id !== userId))];
    if (ids.length < 1) throw new BadRequestException('Add at least one friend');
    if (ids.length + 1 > MAX_GROUP_MEMBERS) throw new BadRequestException(`Groups are limited to ${MAX_GROUP_MEMBERS} members`);
    const friends = await this.prisma.friendship.findMany({ where: { OR: [{ userAId: userId }, { userBId: userId }] } });
    const friendSet = new Set(friends.map((f) => (f.userAId === userId ? f.userBId : f.userAId)));
    if (ids.some((id) => !friendSet.has(id)))
      throw new ForbiddenException({ code: 'NOT_FRIENDS', message: 'You can only add friends to a group' });
    const room = await this.prisma.chatRoom.create({
      data: {
        type: 'GROUP',
        name: sanitizeText(name, 60),
        createdById: userId,
        members: { create: [{ userId, isAdmin: true }, ...ids.map((id) => ({ userId: id }))] },
      },
    });
    await this.systemMessage(room.id, 'Group created');
    this.realtime.toUsers([userId, ...ids], 'chat:room', { roomId: room.id });
    return this.roomSummary(userId, room.id);
  }

  async createLinkedRoom(
    tx: Tx,
    type: Extract<ChatRoomType, 'ASSOCIATION' | 'GAME_ROOM'>,
    linkId: string,
    name: string,
    memberIds: string[],
  ) {
    return tx.chatRoom.create({
      data: {
        type,
        name,
        ...(type === 'ASSOCIATION' ? { associationId: linkId } : { gameRoomId: linkId }),
        members: { create: memberIds.map((userId) => ({ userId })) },
      },
    });
  }

  async addMember(chatRoomId: string, userId: string, tx: Tx = this.prisma) {
    await tx.chatMember.upsert({ where: { chatRoomId_userId: { chatRoomId, userId } }, create: { chatRoomId, userId }, update: {} });
  }

  async removeMember(chatRoomId: string, userId: string, tx: Tx = this.prisma) {
    await tx.chatMember.deleteMany({ where: { chatRoomId, userId } });
  }

  // ── Reading ───────────────────────────────────────────────────

  private async membership(userId: string, roomId: string) {
    const m = await this.prisma.chatMember.findUnique({
      where: { chatRoomId_userId: { chatRoomId: roomId, userId } },
      include: { chatRoom: true },
    });
    if (!m) throw new NotFoundException({ code: 'CHAT_NOT_FOUND', message: 'Conversation not found' });
    return m;
  }

  async roomSummary(userId: string, roomId: string) {
    const list = await this.listRooms(userId, [roomId]);
    return list.items[0];
  }

  async listRooms(userId: string, only?: string[]) {
    const memberships = await this.prisma.chatMember.findMany({
      where: { userId, ...(only ? { chatRoomId: { in: only } } : {}) },
      include: {
        chatRoom: {
          include: {
            members: { include: { user: { select: PUBLIC_USER_SELECT } }, take: 6 },
            messages: { orderBy: { createdAt: 'desc' }, take: 1, where: { deletedAt: null } },
            association: { select: { name: true, emblem: true, publicId: true } },
            _count: { select: { members: true } },
          },
        },
      },
    });
    const unreadRows = memberships.length
      ? await this.prisma.$queryRaw<{ chatRoomId: string; n: bigint }[]>`
          SELECT m.chatRoomId, COUNT(msg.id) AS n
          FROM \`ChatMember\` m
          JOIN \`Message\` msg ON msg.chatRoomId = m.chatRoomId AND msg.createdAt > m.lastReadAt
               AND msg.deletedAt IS NULL AND (msg.senderId IS NULL OR msg.senderId <> m.userId)
          WHERE m.userId = ${userId}
          GROUP BY m.chatRoomId`
      : [];
    const unread = new Map(unreadRows.map((r) => [r.chatRoomId, Number(r.n)]));
    const directOthers = memberships
      .filter((m) => m.chatRoom.type === 'DIRECT')
      .map((m) => m.chatRoom.members.find((x) => x.userId !== userId)?.userId)
      .filter((x): x is string => !!x);
    const online = await this.presence.onlineAmong(directOthers);
    const items = memberships
      .map((m) => {
        const r = m.chatRoom;
        const other = r.type === 'DIRECT' ? r.members.find((x) => x.userId !== userId)?.user : null;
        const last = r.messages[0];
        return {
          id: r.id,
          type: r.type,
          title:
            r.type === 'DIRECT'
              ? other
                ? publicUser(other).displayName
                : 'Player'
              : r.type === 'ASSOCIATION'
                ? (r.association?.name ?? r.name)
                : (r.name ?? 'Chat'),
          peer: other ? publicUser(other, online.has(other.id)) : null,
          memberCount: r._count.members,
          lastMessage: last
            ? { id: last.id, content: last.content, type: last.type, senderId: last.senderId, createdAt: last.createdAt }
            : null,
          unread: unread.get(r.id) ?? 0,
          mutedUntil: m.mutedUntil,
          updatedAt: r.lastMessageAt ?? r.createdAt,
        };
      })
      .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
    return { items, totalUnread: items.reduce((t, i) => t + i.unread, 0) };
  }

  async messages(userId: string, roomId: string, before?: string, take = 40) {
    await this.membership(userId, roomId);
    const where: Prisma.MessageWhereInput = { chatRoomId: roomId };
    if (before) {
      const pivot = await this.prisma.message.findUnique({ where: { id: before } });
      if (pivot) where.createdAt = { lt: pivot.createdAt };
    }
    const rows = await this.prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 100),
      include: { sender: { select: PUBLIC_USER_SELECT } },
    });
    return { items: rows.map((m) => this.serialize(m)).reverse(), hasMore: rows.length === Math.min(take, 100) };
  }

  serialize(m: Prisma.MessageGetPayload<{ include: { sender: { select: typeof PUBLIC_USER_SELECT } } }>) {
    return {
      id: m.id,
      chatRoomId: m.chatRoomId,
      type: m.type,
      content: m.deletedAt ? '' : m.content,
      deleted: !!m.deletedAt,
      meta: m.meta,
      clientMsgId: m.clientMsgId,
      createdAt: m.createdAt,
      sender: m.sender ? publicUser(m.sender) : null,
    };
  }

  // ── Writing ───────────────────────────────────────────────────

  async send(
    userId: string,
    roomId: string,
    content: string,
    clientMsgId?: string,
    type: MessageType = 'TEXT',
    meta?: Record<string, unknown>,
  ) {
    const m = await this.membership(userId, roomId);
    const text = sanitizeText(content);
    if (!text) throw new BadRequestException({ code: 'EMPTY_MESSAGE', message: 'Message is empty' });
    const members = await this.prisma.chatMember.findMany({ where: { chatRoomId: roomId }, select: { userId: true } });
    if (m.chatRoom.type === 'DIRECT') {
      const other = members.find((x) => x.userId !== userId);
      if (other && (await this.users.isBlocked(userId, other.userId)))
        throw new ForbiddenException({ code: 'BLOCKED', message: 'You cannot message this player' });
    }
    if (clientMsgId) {
      const dup = await this.prisma.message.findUnique({
        where: { senderId_clientMsgId: { senderId: userId, clientMsgId } },
        include: { sender: { select: PUBLIC_USER_SELECT } },
      });
      if (dup) return this.serialize(dup);
    }
    const msg = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: { chatRoomId: roomId, senderId: userId, content: text, clientMsgId, type, meta: meta as Prisma.InputJsonValue | undefined },
        include: { sender: { select: PUBLIC_USER_SELECT } },
      });
      await tx.chatRoom.update({ where: { id: roomId }, data: { lastMessageAt: created.createdAt } });
      await tx.chatMember.update({ where: { chatRoomId_userId: { chatRoomId: roomId, userId } }, data: { lastReadAt: created.createdAt } });
      return created;
    });
    const out = this.serialize(msg);
    const recipients = members.map((x) => x.userId);
    this.realtime.toUsers(recipients, 'chat:message', out);
    if (m.chatRoom.type === 'DIRECT') {
      const other = recipients.find((id) => id !== userId);
      if (other && !(await this.presence.isOnline(other))) {
        await this.notifications.notify(
          other,
          'MESSAGE',
          out.sender?.displayName ?? 'New message',
          text.slice(0, 120),
          { chatRoomId: roomId },
          { persist: false },
        );
      }
    }
    return out;
  }

  async systemMessage(roomId: string, content: string) {
    const msg = await this.prisma.message.create({
      data: { chatRoomId: roomId, type: 'SYSTEM', content },
      include: { sender: { select: PUBLIC_USER_SELECT } },
    });
    await this.prisma.chatRoom.update({ where: { id: roomId }, data: { lastMessageAt: msg.createdAt } });
    const members = await this.prisma.chatMember.findMany({ where: { chatRoomId: roomId }, select: { userId: true } });
    this.realtime.toUsers(
      members.map((x) => x.userId),
      'chat:message',
      this.serialize(msg),
    );
  }

  async markRead(userId: string, roomId: string) {
    await this.membership(userId, roomId);
    await this.prisma.chatMember.update({ where: { chatRoomId_userId: { chatRoomId: roomId, userId } }, data: { lastReadAt: new Date() } });
    return { ok: true };
  }

  async deleteMessage(userId: string, messageId: string) {
    const msg = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!msg || msg.senderId !== userId) throw new NotFoundException({ code: 'MESSAGE_NOT_FOUND', message: 'Message not found' });
    await this.prisma.message.update({ where: { id: messageId }, data: { deletedAt: new Date(), deletedBy: userId } });
    const members = await this.prisma.chatMember.findMany({ where: { chatRoomId: msg.chatRoomId }, select: { userId: true } });
    this.realtime.toUsers(
      members.map((x) => x.userId),
      'chat:deleted',
      { id: messageId, chatRoomId: msg.chatRoomId },
    );
    return { ok: true };
  }

  async mute(userId: string, roomId: string, hours: number) {
    await this.membership(userId, roomId);
    await this.prisma.chatMember.update({
      where: { chatRoomId_userId: { chatRoomId: roomId, userId } },
      data: { mutedUntil: hours > 0 ? new Date(Date.now() + hours * 3600_000) : null },
    });
    return { ok: true };
  }

  async leaveGroup(userId: string, roomId: string) {
    const m = await this.membership(userId, roomId);
    if (m.chatRoom.type !== 'GROUP') throw new BadRequestException('Only group chats can be left');
    await this.removeMember(roomId, userId);
    await this.systemMessage(roomId, 'A member left the group');
    return { ok: true };
  }

  async addToGroup(userId: string, roomId: string, memberId: string) {
    const m = await this.membership(userId, roomId);
    if (m.chatRoom.type !== 'GROUP') throw new BadRequestException('Only group chats accept new members');
    if (!m.isAdmin) throw new ForbiddenException('Only group admins can add members');
    const count = await this.prisma.chatMember.count({ where: { chatRoomId: roomId } });
    if (count >= MAX_GROUP_MEMBERS) throw new BadRequestException('Group is full');
    const [a, b] = pair(userId, memberId);
    if (!(await this.prisma.friendship.findUnique({ where: { userAId_userBId: { userAId: a, userBId: b } } }))) {
      throw new ForbiddenException({ code: 'NOT_FRIENDS', message: 'You can only add friends' });
    }
    await this.addMember(roomId, memberId);
    this.realtime.toUser(memberId, 'chat:room', { roomId });
    await this.systemMessage(roomId, 'A new member joined the group');
    return { ok: true };
  }
}

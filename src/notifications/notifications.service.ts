import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PushService } from './push.service';

export type NotificationType =
  | 'FRIEND_REQUEST'
  | 'FRIEND_ACCEPTED'
  | 'ASSOCIATION_INVITE'
  | 'ASSOCIATION_REQUEST'
  | 'ASSOCIATION_APPROVED'
  | 'ROOM_INVITE'
  | 'GIFT_RECEIVED'
  | 'ACHIEVEMENT'
  | 'SUPPORT_REPLY'
  | 'SYSTEM'
  | 'MESSAGE';

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly push: PushService,
  ) {}

  async notify(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    data: Record<string, string> = {},
    opts: { persist?: boolean } = {},
  ) {
    let id: string | null = null;
    if (opts.persist !== false) {
      const n = await this.prisma.notification.create({ data: { userId, type, title, body, data: data as Prisma.InputJsonValue } });
      id = n.id;
      this.realtime.toUser(userId, 'notification:new', n);
    }
    this.push.sendToUser(userId, title, body, { type, ...data }).catch((e) => this.log.warn(`push failed: ${e.message}`));
    return id;
  }

  async list(userId: string, cursor?: string, take = 30) {
    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const unread = await this.prisma.notification.count({ where: { userId, readAt: null } });
    return { items: rows.slice(0, take), nextCursor: rows.length > take ? rows[take - 1].id : null, unread };
  }

  async markRead(userId: string, ids?: string[]) {
    const res = await this.prisma.notification.updateMany({
      where: { userId, readAt: null, ...(ids?.length ? { id: { in: ids } } : {}) },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  }

  async registerDevice(userId: string, token: string, platform: string) {
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
    return { ok: true };
  }

  async unregisterDevice(userId: string, token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
    return { ok: true };
  }
}

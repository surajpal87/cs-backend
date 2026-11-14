import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { AchievementsService } from '../leaderboard/achievements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PointsService } from '../points/points.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PUBLIC_USER_SELECT, publicUser, UsersService } from '../users/users.service';
import { sanitizeText } from '../chat/chat.service';

/**
 * Virtual gifts are cosmetic: the sender spends points, the receiver gets an animation and
 * a record - never points. This keeps points non-transferable.
 */
@Injectable()
export class GiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly points: PointsService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
    private readonly achievements: AchievementsService,
  ) {}

  catalog() {
    return this.prisma.gift
      .findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { pricePoints: 'asc' }] })
      .then((items) => ({ items }));
  }

  async send(
    senderId: string,
    receiverId: string,
    giftCode: string,
    opts: { roomId?: string; message?: string; idempotencyKey?: string } = {},
  ) {
    if (senderId === receiverId) throw new BadRequestException('You cannot send a gift to yourself');
    const gift = await this.prisma.gift.findFirst({ where: { code: giftCode, isActive: true } });
    if (!gift) throw new NotFoundException({ code: 'GIFT_NOT_FOUND', message: 'Gift not available' });
    const receiver = await this.prisma.user.findFirst({ where: { id: receiverId, status: 'ACTIVE' }, select: PUBLIC_USER_SELECT });
    if (!receiver) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Player not found' });
    if (await this.users.isBlocked(senderId, receiverId))
      throw new BadRequestException({ code: 'BLOCKED', message: 'You cannot send gifts to this player' });
    const key = opts.idempotencyKey ?? randomUUID();
    const tx = await this.prisma.$transaction(async (db) => {
      const existing = await db.pointsLedger.findUnique({ where: { idempotencyKey: `gift:${senderId}:${key}` } });
      if (existing) return db.giftTransaction.findFirstOrThrow({ where: { id: existing.refId! } });
      const t = await db.giftTransaction.create({
        data: {
          giftId: gift.id,
          senderId,
          receiverId,
          roomId: opts.roomId,
          pointsSpent: gift.pricePoints,
          message: opts.message ? sanitizeText(opts.message, 140) : null,
        },
      });
      await this.points.apply(db, {
        userId: senderId,
        amount: -gift.pricePoints,
        type: 'GIFT_SENT',
        idempotencyKey: `gift:${senderId}:${key}`,
        refType: 'gift',
        refId: t.id,
      });
      return t;
    });
    const sender = await this.prisma.user.findUniqueOrThrow({ where: { id: senderId }, select: PUBLIC_USER_SELECT });
    const payload = {
      id: tx.id,
      gift: { code: gift.code, name: gift.name, icon: gift.icon, animation: gift.animation },
      from: publicUser(sender),
      to: publicUser(receiver),
      roomId: opts.roomId ?? null,
      message: tx.message,
      createdAt: tx.createdAt,
    };
    await this.notifications.notify(
      receiverId,
      'GIFT_RECEIVED',
      `${publicUser(sender).displayName} sent you a ${gift.name}`,
      tx.message ?? 'Tap to see your gift',
      { giftTransactionId: tx.id },
    );
    this.realtime.toUser(receiverId, 'gift:received', payload);
    this.achievements.evaluate(senderId).catch(() => undefined);
    return payload;
  }

  async history(userId: string) {
    const [received, sent] = await Promise.all([
      this.prisma.giftTransaction.findMany({
        where: { receiverId: userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { gift: true, sender: { select: PUBLIC_USER_SELECT } },
      }),
      this.prisma.giftTransaction.findMany({
        where: { senderId: userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { gift: true, receiver: { select: PUBLIC_USER_SELECT } },
      }),
    ]);
    return {
      received: received.map((r) => ({ id: r.id, gift: r.gift, from: publicUser(r.sender), message: r.message, createdAt: r.createdAt })),
      sent: sent.map((r) => ({
        id: r.id,
        gift: r.gift,
        to: publicUser(r.receiver),
        message: r.message,
        createdAt: r.createdAt,
        pointsSpent: r.pointsSpent,
      })),
    };
  }
}

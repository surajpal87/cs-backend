import { BadRequestException, Injectable } from '@nestjs/common';
import { LedgerType } from '@prisma/client';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import { SettingsService } from '../common/settings.service';
import { dayKey } from '../common/utils/ids';

export interface LedgerInput {
  userId: string;
  amount: number;
  type: LedgerType;
  idempotencyKey: string;
  refType?: string;
  refId?: string;
  note?: string;
}

/**
 * Virtual points: free-to-play, non-redeemable, non-transferable for value.
 * Every balance change is an append-only ledger row written in the same DB transaction as
 * the balance update. Idempotency keys make retries safe (e.g. a hand settled twice).
 */
@Injectable()
export class PointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Must be called inside a transaction. Returns the resulting balance. */
  async apply(tx: Tx, input: LedgerInput): Promise<number> {
    if (!Number.isInteger(input.amount)) throw new BadRequestException('Amount must be an integer');
    const existing = await tx.pointsLedger.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return existing.balanceAfter;
    if (input.amount < 0) {
      const res = await tx.user.updateMany({
        where: { id: input.userId, pointsBalance: { gte: -input.amount } },
        data: { pointsBalance: { increment: input.amount } },
      });
      if (res.count === 0) throw new BadRequestException({ code: 'INSUFFICIENT_POINTS', message: 'Not enough points' });
    } else if (input.amount > 0) {
      await tx.user.update({ where: { id: input.userId }, data: { pointsBalance: { increment: input.amount } } });
    }
    const { pointsBalance } = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { pointsBalance: true } });
    await tx.pointsLedger.create({
      data: {
        userId: input.userId,
        type: input.type,
        amount: input.amount,
        balanceAfter: pointsBalance,
        idempotencyKey: input.idempotencyKey,
        refType: input.refType,
        refId: input.refId,
        note: input.note,
      },
    });
    return pointsBalance;
  }

  async balance(userId: string): Promise<number> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { pointsBalance: true } });
    return u.pointsBalance;
  }

  async ledger(userId: string, cursor?: string, take = 30) {
    const rows = await this.prisma.pointsLedger.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return { items: rows.slice(0, take), nextCursor: rows.length > take ? rows[take - 1].id : null };
  }

  async dailyStatus(userId: string) {
    const rewards = await this.settings.get('points.dailyRewards');
    const today = dayKey();
    const yesterday = dayKey(new Date(Date.now() - 86_400_000));
    const last = await this.prisma.dailyRewardClaim.findFirst({ where: { userId }, orderBy: { day: 'desc' } });
    const claimedToday = last?.day === today;
    const streak = claimedToday ? last!.streak : last?.day === yesterday ? last.streak : 0;
    const nextIndex = claimedToday ? streak % rewards.length : streak % rewards.length;
    return { claimedToday, streak, nextReward: rewards[nextIndex], schedule: rewards };
  }

  async claimDaily(userId: string) {
    const rewards = await this.settings.get('points.dailyRewards');
    const today = dayKey();
    const yesterday = dayKey(new Date(Date.now() - 86_400_000));
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.dailyRewardClaim.findFirst({ where: { userId }, orderBy: { day: 'desc' } });
      if (last?.day === today) throw new BadRequestException({ code: 'ALREADY_CLAIMED', message: 'Daily reward already claimed today' });
      const streak = last?.day === yesterday ? last.streak + 1 : 1;
      const points = rewards[(streak - 1) % rewards.length];
      await tx.dailyRewardClaim.create({ data: { userId, day: today, streak, points } });
      const balance = await this.apply(tx, {
        userId,
        amount: points,
        type: 'DAILY_REWARD',
        idempotencyKey: `daily:${userId}:${today}`,
        note: `Day ${streak} streak`,
      });
      return { points, streak, balance };
    });
  }
}

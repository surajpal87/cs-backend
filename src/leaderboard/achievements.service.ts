import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PointsService } from '../points/points.service';

/**
 * Achievements are defined in the database (metric + threshold) and evaluated server-side
 * after relevant events (hand settled, friend added, association joined).
 */
@Injectable()
export class AchievementsService {
  private readonly log = new Logger(AchievementsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly points: PointsService,
    private readonly notifications: NotificationsService,
  ) {}

  private async metric(userId: string, metric: string, gameCode: string | null): Promise<number> {
    const gameFilter = gameCode ? { game: { code: gameCode as never } } : {};
    switch (metric) {
      case 'games_played':
        return this.prisma.gameHistory.count({ where: { userId, ...gameFilter } });
      case 'games_won':
        return this.prisma.gameHistory.count({ where: { userId, outcome: 'WIN', ...gameFilter } });
      case 'friends_count':
        return this.prisma.friendship.count({ where: { OR: [{ userAId: userId }, { userBId: userId }] } });
      case 'associations_joined':
        return this.prisma.associationMember.count({ where: { userId, status: 'ACTIVE' } });
      case 'daily_streak': {
        const last = await this.prisma.dailyRewardClaim.findFirst({ where: { userId }, orderBy: { day: 'desc' } });
        return last?.streak ?? 0;
      }
      case 'gifts_sent':
        return this.prisma.giftTransaction.count({ where: { senderId: userId } });
      default:
        return 0;
    }
  }

  async evaluate(userId: string): Promise<string[]> {
    try {
      const owned = new Set(
        (await this.prisma.userAchievement.findMany({ where: { userId }, select: { achievementId: true } })).map((a) => a.achievementId),
      );
      const candidates = await this.prisma.achievement.findMany({ where: { isActive: true, id: { notIn: [...owned] } } });
      const unlocked: string[] = [];
      for (const a of candidates) {
        const value = await this.metric(userId, a.metric, a.gameCode);
        if (value < a.threshold) continue;
        const created = await this.prisma.$transaction(async (tx) => {
          const res = await tx.userAchievement.createMany({ data: [{ userId, achievementId: a.id }], skipDuplicates: true });
          if (!res.count) return false;
          if (a.rewardPoints > 0) {
            await this.points.apply(tx, {
              userId,
              amount: a.rewardPoints,
              type: 'ACHIEVEMENT_REWARD',
              idempotencyKey: `ach:${userId}:${a.id}`,
              refType: 'achievement',
              refId: a.id,
            });
          }
          return true;
        });
        if (created) {
          unlocked.push(a.code);
          await this.notifications.notify(
            userId,
            'ACHIEVEMENT',
            `Achievement unlocked: ${a.name}`,
            a.rewardPoints ? `${a.description} (+${a.rewardPoints} points)` : a.description,
            {
              code: a.code,
            },
          );
        }
      }
      return unlocked;
    } catch (e) {
      this.log.warn(`achievement evaluation failed for ${userId}: ${(e as Error).message}`);
      return [];
    }
  }

  async list(userId: string) {
    const [all, mine] = await Promise.all([
      this.prisma.achievement.findMany({ where: { isActive: true }, orderBy: [{ metric: 'asc' }, { threshold: 'asc' }] }),
      this.prisma.userAchievement.findMany({ where: { userId } }),
    ]);
    const unlocked = new Map(mine.map((m) => [m.achievementId, m.unlockedAt]));
    const progress = new Map<string, number>();
    for (const a of all) {
      const k = `${a.metric}:${a.gameCode ?? ''}`;
      if (!progress.has(k)) progress.set(k, await this.metric(userId, a.metric, a.gameCode));
    }
    return {
      items: all.map((a) => ({
        code: a.code,
        name: a.name,
        description: a.description,
        icon: a.icon,
        threshold: a.threshold,
        rewardPoints: a.rewardPoints,
        progress: Math.min(a.threshold, progress.get(`${a.metric}:${a.gameCode ?? ''}`) ?? 0),
        unlockedAt: unlocked.get(a.id) ?? null,
      })),
    };
  }
}

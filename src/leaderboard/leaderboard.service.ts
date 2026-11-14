import { BadRequestException, Injectable } from '@nestjs/common';
import { LeaderboardPeriod } from '@prisma/client';
import { PrismaService, Tx } from '../common/prisma/prisma.service';
import { isoWeekKey, monthKey } from '../common/utils/ids';
import { GAME_CODES } from '../games/registry';
import { PUBLIC_USER_SELECT, publicUser } from '../users/users.service';

export function periodKey(period: LeaderboardPeriod, d = new Date()): string {
  return period === 'WEEKLY' ? isoWeekKey(d) : period === 'MONTHLY' ? monthKey(d) : 'all';
}

/**
 * Leaderboards are aggregated from validated, server-settled hands only. The aggregation is
 * written in the same transaction that records GameHistory, so rankings can never diverge
 * from history.
 */
@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  async recordHand(tx: Tx, gameCode: string, results: { userId: string; delta: number; won: boolean }[], at = new Date()) {
    for (const period of ['WEEKLY', 'MONTHLY', 'ALL_TIME'] as LeaderboardPeriod[]) {
      const key = periodKey(period, at);
      for (const scope of ['ALL', gameCode]) {
        for (const r of results) {
          await tx.leaderboardEntry.upsert({
            where: { period_periodKey_scope_userId: { period, periodKey: key, scope, userId: r.userId } },
            create: { period, periodKey: key, scope, userId: r.userId, score: r.delta, wins: r.won ? 1 : 0, played: 1 },
            update: { score: { increment: r.delta }, wins: { increment: r.won ? 1 : 0 }, played: { increment: 1 } },
          });
        }
      }
    }
  }

  private validate(period: string, scope: string): { period: LeaderboardPeriod; scope: string } {
    const p = period.toUpperCase() as LeaderboardPeriod;
    if (!['WEEKLY', 'MONTHLY', 'ALL_TIME'].includes(p)) throw new BadRequestException('period must be weekly, monthly or all_time');
    const s = scope.toUpperCase();
    if (s !== 'ALL' && !GAME_CODES.includes(s as never)) throw new BadRequestException('Unknown game scope');
    return { period: p, scope: s };
  }

  async top(viewerId: string, periodIn: string, scopeIn: string, limit = 50) {
    const { period, scope } = this.validate(periodIn, scopeIn);
    const key = periodKey(period);
    const rows = await this.prisma.leaderboardEntry.findMany({
      where: { period, periodKey: key, scope, user: { status: 'ACTIVE' } },
      orderBy: [{ score: 'desc' }, { wins: 'desc' }, { updatedAt: 'asc' }],
      take: Math.min(limit, 100),
      include: { user: { select: PUBLIC_USER_SELECT } },
    });
    const mine = await this.prisma.leaderboardEntry.findUnique({
      where: { period_periodKey_scope_userId: { period, periodKey: key, scope, userId: viewerId } },
    });
    let myRank: number | null = null;
    if (mine) {
      myRank = (await this.prisma.leaderboardEntry.count({ where: { period, periodKey: key, scope, score: { gt: mine.score } } })) + 1;
    }
    return {
      period,
      periodKey: key,
      scope,
      items: rows.map((r, i) => ({ rank: i + 1, score: r.score, wins: r.wins, played: r.played, user: publicUser(r.user) })),
      me: mine ? { rank: myRank, score: mine.score, wins: mine.wins, played: mine.played } : null,
    };
  }

  async associations(periodIn: string, limit = 50) {
    const { period } = this.validate(periodIn, 'ALL');
    const key = periodKey(period);
    const rows = await this.prisma.$queryRaw<
      { id: string; publicId: string; name: string; emblem: string; memberCount: number; score: bigint; wins: bigint }[]
    >`
      SELECT a.id, a.publicId, a.name, a.emblem, a.memberCount,
             COALESCE(SUM(l.score), 0) AS score, COALESCE(SUM(l.wins), 0) AS wins
      FROM \`Association\` a
      JOIN \`AssociationMember\` m ON m.associationId = a.id AND m.status = 'ACTIVE'
      LEFT JOIN \`LeaderboardEntry\` l ON l.userId = m.userId AND l.period = ${period}
           AND l.periodKey = ${key} AND l.scope = 'ALL'
      WHERE a.deletedAt IS NULL
      GROUP BY a.id, a.publicId, a.name, a.emblem, a.memberCount
      ORDER BY score DESC, wins DESC
      LIMIT ${Math.min(limit, 100)}`;
    return {
      period,
      periodKey: key,
      items: rows.map((r, i) => ({ rank: i + 1, ...r, score: Number(r.score), wins: Number(r.wins) })),
    };
  }
}

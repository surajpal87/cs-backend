import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/guards/jwt-auth.guard';
import { PointsService } from '../points/points.service';
import { AchievementsService } from './achievements.service';
import { LeaderboardService } from './leaderboard.service';

@ApiTags('leaderboard & rewards')
@ApiBearerAuth()
@Controller()
export class LeaderboardController {
  constructor(
    private readonly lb: LeaderboardService,
    private readonly achievements: AchievementsService,
    private readonly points: PointsService,
  ) {}

  @Get('leaderboard')
  top(@CurrentUser() u: AuthUser, @Query('period') period = 'weekly', @Query('game') game = 'ALL') {
    return this.lb.top(u.id, period, game);
  }

  @Get('leaderboard/associations')
  associations(@Query('period') period = 'weekly') {
    return this.lb.associations(period);
  }

  @Get('achievements')
  list(@CurrentUser() u: AuthUser) {
    return this.achievements.list(u.id);
  }

  @Get('points')
  async balance(@CurrentUser() u: AuthUser) {
    return { balance: await this.points.balance(u.id), daily: await this.points.dailyStatus(u.id) };
  }

  @Get('points/ledger')
  ledger(@CurrentUser() u: AuthUser, @Query('cursor') cursor?: string) {
    return this.points.ledger(u.id, cursor);
  }

  @Post('points/daily-reward')
  @HttpCode(200)
  async claim(@CurrentUser() u: AuthUser) {
    const r = await this.points.claimDaily(u.id);
    await this.achievements.evaluate(u.id);
    return r;
  }
}

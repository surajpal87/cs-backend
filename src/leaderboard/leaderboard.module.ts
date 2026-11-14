import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { VirtualPointsModule } from '../points/points.module';
import { AchievementsService } from './achievements.service';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardService } from './leaderboard.service';

@Module({
  imports: [VirtualPointsModule, NotificationsModule],
  controllers: [LeaderboardController],
  providers: [LeaderboardService, AchievementsService],
  exports: [LeaderboardService, AchievementsService],
})
export class LeaderboardModule {}

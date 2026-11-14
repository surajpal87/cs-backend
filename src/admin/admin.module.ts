import { Module } from '@nestjs/common';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { MultiplayerModule } from '../multiplayer/multiplayer.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VirtualPointsModule } from '../points/points.module';
import { SupportModule } from '../support/support.module';
import { AdminAuthController } from './admin-auth.controller';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';

@Module({
  imports: [MultiplayerModule, VirtualPointsModule, LeaderboardModule, NotificationsModule, SupportModule],
  controllers: [AdminAuthController, AdminController],
  providers: [AdminGuard],
})
export class AdminModule {}

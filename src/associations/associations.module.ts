import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AssociationsController } from './associations.controller';
import { AssociationsService } from './associations.service';

@Module({
  imports: [ChatModule, NotificationsModule, LeaderboardModule],
  controllers: [AssociationsController],
  providers: [AssociationsService],
  exports: [AssociationsService],
})
export class AssociationsModule {}

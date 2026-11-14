import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { FriendsModule } from '../friends/friends.module';
import { GiftsModule } from '../gifts/gifts.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { VirtualPointsModule } from '../points/points.module';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { MultiplayerService } from './multiplayer.service';

@Module({
  imports: [VirtualPointsModule, LeaderboardModule, ChatModule, FriendsModule, GiftsModule],
  providers: [MultiplayerService, RealtimeGateway],
  exports: [MultiplayerService],
})
export class MultiplayerModule {}

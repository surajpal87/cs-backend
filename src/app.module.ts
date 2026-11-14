import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AssociationsModule } from './associations/associations.module';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { CommonModule } from './common/common.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { FriendsModule } from './friends/friends.module';
import { GamesModule } from './games/games.module';
import { GiftsModule } from './gifts/gifts.module';
import { HealthModule } from './health/health.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { MultiplayerModule } from './multiplayer/multiplayer.module';
import { NotificationsModule } from './notifications/notifications.module';
import { VirtualPointsModule } from './points/points.module';
import { SupportModule } from './support/support.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    CommonModule,
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    AuthModule,
    UsersModule,
    VirtualPointsModule,
    NotificationsModule,
    LeaderboardModule,
    FriendsModule,
    ChatModule,
    AssociationsModule,
    GiftsModule,
    SupportModule,
    GamesModule,
    MultiplayerModule,
    AdminModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { RoomsService } from '../rooms/rooms.service';
import { GamesController } from './games.controller';
import { GamesService } from './games.service';

/** GamesModule + GameRoomsModule + GameHistoryModule REST surface. */
@Module({
  imports: [ChatModule],
  controllers: [GamesController],
  providers: [GamesService, RoomsService],
  exports: [GamesService, RoomsService],
})
export class GamesModule {}

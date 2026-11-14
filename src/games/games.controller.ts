import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GameCode, RoomVisibility } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/guards/jwt-auth.guard';
import { PrismaService } from '../common/prisma/prisma.service';
import { RoomsService } from '../rooms/rooms.service';
import { GamesService } from './games.service';

class BuyInDto {
  @IsOptional() @IsInt() @Min(1) min?: number;
  @IsOptional() @IsInt() @Min(1) max?: number;
}

class CreateRoomDto {
  @IsEnum(GameCode) gameCode: GameCode;
  @IsOptional() @IsString() @Length(3, 60) name?: string;
  @IsOptional() @IsEnum(RoomVisibility) visibility?: RoomVisibility;
  @IsOptional() @IsString() @Length(4, 32) password?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10) maxPlayers?: number;
  @IsOptional() @IsUUID() associationId?: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @ValidateNested() @Type(() => BuyInDto) buyIn?: BuyInDto;
}

@ApiTags('games & rooms')
@ApiBearerAuth()
@Controller()
export class GamesController {
  constructor(
    private readonly games: GamesService,
    private readonly rooms: RoomsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('games')
  list() {
    return this.games.list();
  }

  @Get('games/:code')
  details(@Param('code') code: string) {
    return this.games.details(code);
  }

  @Get('banners')
  banners() {
    return this.games.banners();
  }

  @Post('rooms')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateRoomDto) {
    return this.rooms.create(u.id, dto);
  }

  @Get('rooms')
  listRooms(@CurrentUser() u: AuthUser, @Query('game') game?: string) {
    return this.rooms.list(u.id, game);
  }

  @Get('rooms/mine')
  mine(@CurrentUser() u: AuthUser) {
    return this.rooms.mySeats(u.id);
  }

  @Get('rooms/:idOrCode')
  room(@CurrentUser() u: AuthUser, @Param('idOrCode') id: string) {
    return this.rooms.details(u.id, id);
  }

  // ── Game history ──
  @Get('history')
  async history(@CurrentUser() u: AuthUser, @Query('game') game?: string, @Query('cursor') cursor?: string) {
    const rows = await this.prisma.gameHistory.findMany({
      where: { userId: u.id, ...(game ? { game: { code: game.toUpperCase() as GameCode } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 31,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        game: { select: { code: true, name: true } },
        session: { select: { id: true, handNumber: true, roomId: true, room: { select: { name: true, code: true } } } },
      },
    });
    return {
      items: rows.slice(0, 30).map((r) => ({
        id: r.id,
        sessionId: r.gameSessionId,
        game: r.game,
        room: r.session.room,
        handNumber: r.session.handNumber,
        outcome: r.outcome,
        pointsDelta: r.pointsDelta,
        details: r.details,
        createdAt: r.createdAt,
      })),
      nextCursor: rows.length > 30 ? rows[29].id : null,
    };
  }

  @Get('history/sessions/:id')
  async session(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const s = await this.prisma.gameSession.findFirst({
      where: { id, history: { some: { userId: u.id } } },
      include: {
        game: { select: { code: true, name: true } },
        room: { select: { name: true, code: true } },
        history: { include: { user: { select: { id: true, username: true, profile: { select: { displayName: true } } } } } },
      },
    });
    if (!s) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Hand not found' });
    return {
      id: s.id,
      game: s.game,
      room: s.room,
      handNumber: s.handNumber,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      fairness: {
        seedCommit: s.seedCommit,
        seedReveal: s.seedReveal,
        algorithm: 'HMAC-SHA256(seed, counter) stream, Fisher-Yates; commit = SHA256(seed)',
      },
      summary: s.summary,
      players: s.history.map((h) => ({
        userId: h.userId,
        name: h.user.profile?.displayName ?? h.user.username,
        outcome: h.outcome,
        pointsDelta: h.pointsDelta,
        details: h.details,
      })),
    };
  }
}

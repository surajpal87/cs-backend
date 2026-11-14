import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { GameCode, Prisma, RoomVisibility } from '@prisma/client';
import * as argon2 from 'argon2';
import { ARGON_OPTS } from '../auth/auth.service';
import { ChatService, sanitizeText } from '../chat/chat.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { SettingsService } from '../common/settings.service';
import { roomCode } from '../common/utils/ids';
import { GameRuleError } from '../games/core/engine';
import { getEngine } from '../games/registry';
import { PUBLIC_USER_SELECT, publicUser } from '../users/users.service';

export interface CreateRoomInput {
  gameCode: GameCode;
  name?: string;
  visibility?: RoomVisibility;
  password?: string;
  maxPlayers?: number;
  associationId?: string;
  config?: Record<string, unknown>;
  buyIn?: { min?: number; max?: number };
}

export interface RoomRuntimeConfig {
  game: Record<string, unknown>;
  buyIn: { min: number; max: number };
}

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
    private readonly settings: SettingsService,
  ) {}

  async create(userId: string, input: CreateRoomInput) {
    const game = await this.prisma.game.findFirst({ where: { code: input.gameCode, isActive: true } });
    if (!game) throw new NotFoundException({ code: 'GAME_NOT_FOUND', message: 'Game not available' });
    const engine = getEngine(game.code);
    let gameConfig: Record<string, unknown>;
    try {
      gameConfig = engine.normalizeConfig({ ...(game.config as object), ...(input.config ?? {}) }) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof GameRuleError) throw new BadRequestException({ code: e.code, message: e.message });
      throw e;
    }
    const maxPlayers = Math.min(input.maxPlayers ?? game.maxPlayers, engine.maxPlayers, game.maxPlayers);
    if (maxPlayers < Math.max(engine.minPlayers, game.minPlayers)) throw new BadRequestException('Max players is below the game minimum');

    const floor = await this.settings.get('points.minTableBuyIn');
    const minStack = engine.minStackToPlay(gameConfig);
    const minBuyIn = Math.max(input.buyIn?.min ?? minStack * 10, minStack, floor);
    const maxBuyIn = Math.max(input.buyIn?.max ?? minBuyIn * 10, minBuyIn);

    const maxRooms = await this.settings.get('rooms.maxPerUser');
    const open = await this.prisma.room.count({ where: { hostId: userId, status: { not: 'CLOSED' } } });
    if (open >= maxRooms) throw new BadRequestException({ code: 'ROOM_LIMIT', message: `You can host at most ${maxRooms} open rooms` });

    if (input.associationId) {
      const m = await this.prisma.associationMember.findUnique({
        where: { associationId_userId: { associationId: input.associationId, userId } },
      });
      if (!m || m.status !== 'ACTIVE')
        throw new ForbiddenException({ code: 'NOT_MEMBER', message: 'Only association members can create association rooms' });
    }
    const visibility = input.associationId ? 'PRIVATE' : (input.visibility ?? 'PUBLIC');
    if (visibility === 'PRIVATE' && !input.associationId && !input.password) {
      throw new BadRequestException({ code: 'PASSWORD_REQUIRED', message: 'Private rooms need a password' });
    }
    const passwordHash = input.password ? await argon2.hash(input.password, ARGON_OPTS) : null;
    const config: RoomRuntimeConfig = { game: gameConfig, buyIn: { min: minBuyIn, max: maxBuyIn } };
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { profile: true } });

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const room = await this.prisma.$transaction(async (tx) => {
          const r = await tx.room.create({
            data: {
              code: roomCode(),
              gameId: game.id,
              hostId: userId,
              name: sanitizeText(input.name || `${me.profile?.displayName ?? me.username}'s ${game.name} table`, 60),
              visibility,
              passwordHash,
              associationId: input.associationId,
              maxPlayers,
              config: config as unknown as Prisma.InputJsonValue,
            },
          });
          await this.chat.createLinkedRoom(tx, 'GAME_ROOM', r.id, r.name, []);
          return r;
        });
        return this.details(userId, room.id);
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') continue;
        throw e;
      }
    }
    throw new Error('Could not allocate a room code');
  }

  async list(userId: string, gameCode?: string) {
    const memberships = await this.prisma.associationMember.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { associationId: true },
    });
    const rows = await this.prisma.room.findMany({
      where: {
        status: { not: 'CLOSED' },
        ...(gameCode ? { game: { code: gameCode.toUpperCase() as GameCode } } : {}),
        OR: [{ visibility: 'PUBLIC' }, { associationId: { in: memberships.map((m) => m.associationId) } }, { hostId: userId }],
      },
      include: {
        game: { select: { code: true, name: true } },
        host: { select: PUBLIC_USER_SELECT },
        _count: { select: { players: { where: { status: 'SEATED' } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items: rows.map((r) => this.card(r)) };
  }

  private card(
    r: Prisma.RoomGetPayload<{
      include: {
        game: { select: { code: true; name: true } };
        host: { select: typeof PUBLIC_USER_SELECT };
        _count: { select: { players: { where: { status: 'SEATED' } } } };
      };
    }>,
  ) {
    const config = r.config as unknown as RoomRuntimeConfig;
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      status: r.status,
      visibility: r.visibility,
      hasPassword: !!r.passwordHash,
      associationId: r.associationId,
      game: r.game,
      host: publicUser(r.host),
      players: r._count.players,
      maxPlayers: r.maxPlayers,
      config: config.game,
      buyIn: config.buyIn,
      createdAt: r.createdAt,
    };
  }

  async details(_userId: string, idOrCode: string) {
    const where = /^[A-Z2-9]{6}$/i.test(idOrCode) ? { code: idOrCode.toUpperCase() } : { id: idOrCode };
    const r = await this.prisma.room.findFirst({
      where,
      include: {
        game: { select: { code: true, name: true } },
        host: { select: PUBLIC_USER_SELECT },
        _count: { select: { players: { where: { status: 'SEATED' } } } },
        players: { where: { status: 'SEATED' }, include: { user: { select: PUBLIC_USER_SELECT } }, orderBy: { seat: 'asc' } },
        chatRoom: { select: { id: true } },
      },
    });
    if (!r) throw new NotFoundException({ code: 'ROOM_NOT_FOUND', message: 'Room not found' });
    return {
      ...this.card(r),
      chatRoomId: r.chatRoom?.id ?? null,
      seats: r.players.map((p) => ({ seat: p.seat, stack: p.stack, user: publicUser(p.user) })),
    };
  }

  async mySeats(userId: string) {
    const rows = await this.prisma.roomPlayer.findMany({
      where: { userId, status: 'SEATED' },
      include: { room: { include: { game: { select: { code: true, name: true } } } } },
    });
    return {
      items: rows.map((p) => ({ roomId: p.roomId, code: p.room.code, name: p.room.name, game: p.room.game, seat: p.seat, stack: p.stack })),
    };
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { GameCode } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { getEngine } from './registry';

@Injectable()
export class GamesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const [games, categories, live] = await Promise.all([
      this.prisma.game.findMany({
        where: { isActive: true },
        orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }],
        include: { category: true },
      }),
      this.prisma.gameCategory.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.roomPlayer.groupBy({ by: ['roomId'], where: { status: 'SEATED' }, _count: { _all: true } }),
    ]);
    const rooms = await this.prisma.room.findMany({ where: { id: { in: live.map((l) => l.roomId) } }, select: { id: true, gameId: true } });
    const playersByGame = new Map<string, number>();
    for (const l of live) {
      const g = rooms.find((r) => r.id === l.roomId)?.gameId;
      if (g) playersByGame.set(g, (playersByGame.get(g) ?? 0) + l._count._all);
    }
    return {
      categories: categories.map((c) => ({ id: c.id, slug: c.slug, name: c.name })),
      items: games.map((g) => ({
        id: g.id,
        code: g.code,
        name: g.name,
        tagline: g.tagline,
        category: g.category?.slug ?? null,
        minPlayers: g.minPlayers,
        maxPlayers: g.maxPlayers,
        isFeatured: g.isFeatured,
        playersOnline: playersByGame.get(g.id) ?? 0,
      })),
    };
  }

  async details(code: string) {
    const g = await this.prisma.game.findFirst({
      where: { code: code.toUpperCase() as GameCode, isActive: true },
      include: { category: true },
    });
    if (!g) throw new NotFoundException({ code: 'GAME_NOT_FOUND', message: 'Game not found' });
    const engine = getEngine(g.code);
    const defaults = engine.normalizeConfig((g.config as Record<string, unknown>) ?? {});
    const openRooms = await this.prisma.room.count({ where: { gameId: g.id, status: { not: 'CLOSED' }, visibility: 'PUBLIC' } });
    return {
      id: g.id,
      code: g.code,
      name: g.name,
      tagline: g.tagline,
      description: g.description,
      category: g.category?.slug ?? null,
      minPlayers: g.minPlayers,
      maxPlayers: g.maxPlayers,
      defaultConfig: defaults,
      minStackToPlay: engine.minStackToPlay(defaults),
      openRooms,
    };
  }

  async banners() {
    const now = new Date();
    return {
      items: await this.prisma.banner.findMany({
        where: {
          isActive: true,
          AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
        },
        orderBy: { sortOrder: 'asc' },
      }),
    };
  }
}

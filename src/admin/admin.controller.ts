import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GameCode, Prisma, ReportStatus, TicketPriority, TicketStatus, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsDefined,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Request } from 'express';
import { randomUUID } from 'crypto';
import { ARGON_OPTS } from '../auth/auth.service';
import { PASSWORD_MESSAGE, PASSWORD_RULE } from '../auth/auth.dto';
import { AuditService } from '../common/audit/audit.service';
import { Public } from '../common/guards/jwt-auth.guard';
import { PrismaService } from '../common/prisma/prisma.service';
import { PresenceService } from '../common/redis/presence.service';
import { SETTING_DEFAULTS, SettingKey, SettingsService } from '../common/settings.service';
import { getEngine } from '../games/registry';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { MultiplayerService } from '../multiplayer/multiplayer.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PointsService } from '../points/points.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SupportService } from '../support/support.service';
import { AdminContext, AdminGuard, CurrentAdmin, PERMISSIONS, RequirePermissions } from './admin.guard';

class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsString() @MaxLength(40) status?: string;
}
const paging = (q: PageQuery) => ({ skip: (q.page - 1) * q.pageSize, take: q.pageSize });

class UserStatusDto {
  @IsEnum(UserStatus) status: UserStatus;
  @IsString() @Length(3, 300) reason: string;
}
class AdjustPointsDto {
  @IsInt() @Min(-10_000_000) @Max(10_000_000) amount: number;
  @IsString() @Length(3, 200) note: string;
  @IsOptional() @IsUUID() requestId?: string;
}
class GameUpdateDto {
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() isFeatured?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsString() @Length(2, 60) name?: string;
  @IsOptional() @IsString() @Length(2, 120) tagline?: string;
  @IsOptional() @IsString() @Length(2, 4000) description?: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsUUID() categoryId?: string;
}
class CategoryDto {
  @Matches(/^[a-z0-9-]{2,40}$/) slug: string;
  @IsString() @Length(2, 60) name: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
class ReportUpdateDto {
  @IsEnum(ReportStatus) status: ReportStatus;
  @IsOptional() @IsString() @MaxLength(500) resolution?: string;
}
class GiftDto {
  @Matches(/^[a-z0-9_]{2,32}$/) code: string;
  @IsString() @Length(2, 40) name: string;
  @IsString() @Length(1, 64) icon: string;
  @IsOptional() @IsIn(['float', 'burst', 'rain', 'spin', 'sparkle']) animation?: string;
  @IsInt() @Min(1) @Max(1_000_000) pricePoints: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}
class BannerDto {
  @IsString() @Length(2, 80) title: string;
  @IsOptional() @IsString() @MaxLength(160) subtitle?: string;
  @IsOptional() @IsString() @MaxLength(500) imageUrl?: string;
  @IsOptional() @IsString() @MaxLength(255) linkUrl?: string;
  @IsOptional() @IsIn(['gold', 'blue', 'green', 'red', 'black']) theme?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
}
class BroadcastDto {
  @IsString() @Length(2, 120) title: string;
  @IsString() @Length(2, 500) body: string;
  @IsIn(['ALL', 'ACTIVE_7D']) audience: 'ALL' | 'ACTIVE_7D';
}
class TicketReplyDto {
  @IsString() @Length(1, 4000) body: string;
  @IsOptional() @IsEnum(TicketStatus) status?: TicketStatus;
}
class TicketUpdateDto {
  @IsOptional() @IsEnum(TicketStatus) status?: TicketStatus;
  @IsOptional() @IsEnum(TicketPriority) priority?: TicketPriority;
  @IsOptional() @IsUUID() assignedToId?: string;
}
class RoleDto {
  @Matches(/^[A-Z_]{3,32}$/) key: string;
  @IsString() @Length(2, 60) name: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  @IsArray() @ArrayUnique() @IsIn(PERMISSIONS as unknown as string[], { each: true }) permissions: string[];
}
class RoleUpdateDto {
  @IsOptional() @IsString() @Length(2, 60) name?: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(PERMISSIONS as unknown as string[], { each: true }) permissions?: string[];
}
class AdminCreateDto {
  @IsEmail() email: string;
  @IsString() @Length(2, 60) name: string;
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) password: string;
  @IsUUID() roleId: string;
}
class AdminUpdateDto {
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: 'ACTIVE' | 'DISABLED';
}
class SettingDto {
  @IsDefined()
  value: unknown;
}

@ApiTags('admin')
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly presence: PresenceService,
    private readonly mp: MultiplayerService,
    private readonly points: PointsService,
    private readonly settings: SettingsService,
    private readonly lb: LeaderboardService,
    private readonly notifications: NotificationsService,
    private readonly support: SupportService,
    private readonly realtime: RealtimeService,
  ) {}

  private log(a: AdminContext, action: string, targetType?: string, targetId?: string, metadata?: Record<string, unknown>, req?: Request) {
    return this.audit.record({ actorType: 'ADMIN', actorId: a.id, action, targetType, targetId, metadata, ip: req?.ip });
  }

  // ── Dashboard ────────────────────────────────────────────────

  @Get('dashboard')
  @RequirePermissions('dashboard.read')
  async dashboard() {
    const dayAgo = new Date(Date.now() - 86_400_000);
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const [users, newToday, active24h, openRooms, handsToday, openReports, openTickets, associations] = await Promise.all([
      this.prisma.user.count({ where: { status: { not: 'DELETED' } } }),
      this.prisma.user.count({ where: { createdAt: { gte: startOfDay } } }),
      this.prisma.user.count({ where: { lastSeenAt: { gte: dayAgo } } }),
      this.prisma.room.count({ where: { status: { not: 'CLOSED' } } }),
      this.prisma.gameSession.count({ where: { startedAt: { gte: startOfDay }, status: 'COMPLETED' } }),
      this.prisma.userReport.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
      this.prisma.supportTicket.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      this.prisma.association.count({ where: { deletedAt: null } }),
    ]);
    const signups = await this.prisma.$queryRaw<{ day: string; n: bigint }[]>`
      SELECT DATE_FORMAT(createdAt, '%Y-%m-%d') AS day, COUNT(*) AS n FROM \`User\`
      WHERE createdAt > UTC_TIMESTAMP() - INTERVAL 14 DAY GROUP BY day ORDER BY day`;
    const handsByGame = await this.prisma.$queryRaw<{ code: string; n: bigint }[]>`
      SELECT g.code AS code, COUNT(s.id) AS n FROM \`Game\` g
      LEFT JOIN \`GameSession\` s ON s.gameId = g.id AND s.startedAt > UTC_TIMESTAMP() - INTERVAL 7 DAY AND s.status = 'COMPLETED'
      GROUP BY g.code ORDER BY n DESC`;
    return {
      totals: {
        users,
        newToday,
        active24h,
        onlineNow: await this.presence.onlineCount(),
        openRooms,
        handsToday,
        openReports,
        openTickets,
        associations,
      },
      live: this.mp.liveStats(),
      signups: signups.map((s) => ({ day: s.day, count: Number(s.n) })),
      handsByGame: handsByGame.map((h) => ({ game: h.code, count: Number(h.n) })),
    };
  }

  // ── Users ────────────────────────────────────────────────────

  @Get('users')
  @RequirePermissions('users.read')
  async users(@Query() q: PageQuery) {
    const where: Prisma.UserWhereInput = {
      ...(q.status ? { status: q.status as UserStatus } : {}),
      ...(q.q
        ? {
            OR: [
              { username: { contains: q.q } },
              { email: { contains: q.q } },
              { csId: q.q.toUpperCase() },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        ...paging(q),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          csId: true,
          email: true,
          username: true,
          status: true,
          pointsBalance: true,
          createdAt: true,
          lastSeenAt: true,
          profile: { select: { displayName: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    const online = await this.presence.onlineAmong(items.map((i) => i.id));
    return { items: items.map((i) => ({ ...i, online: online.has(i.id) })), total, page: q.page, pageSize: q.pageSize };
  }

  @Get('users/:id')
  @RequirePermissions('users.read')
  async user(@Param('id', ParseUUIDPipe) id: string) {
    const u = await this.prisma.user.findUnique({
      where: { id },
      include: {
        profile: true,
        ledger: { orderBy: { createdAt: 'desc' }, take: 25 },
        sessions: {
          where: { revokedAt: null, expiresAt: { gt: new Date() } },
          select: { id: true, ip: true, userAgent: true, createdAt: true, lastUsedAt: true },
        },
        reportsReceived: { orderBy: { createdAt: 'desc' }, take: 10 },
        gameHistory: { orderBy: { createdAt: 'desc' }, take: 15, include: { game: { select: { code: true, name: true } } } },
        roomPlayers: { where: { status: 'SEATED' }, include: { room: { select: { code: true, name: true } } } },
      },
    });
    if (!u) throw new NotFoundException('User not found');
    const { passwordHash: _p, ...safe } = u;
    return { ...safe, online: await this.presence.isOnline(id) };
  }

  @Post('users/:id/status')
  @HttpCode(200)
  @RequirePermissions('users.manage')
  async setStatus(
    @CurrentAdmin() a: AdminContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UserStatusDto,
    @Req() req: Request,
  ) {
    if (dto.status === 'DELETED' || dto.status === 'PENDING_VERIFICATION') throw new BadRequestException('Use ACTIVE, SUSPENDED or BANNED');
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u || u.status === 'DELETED') throw new NotFoundException('User not found');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { status: dto.status } }),
      ...(dto.status !== 'ACTIVE'
        ? [this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } })]
        : []),
    ]);
    if (dto.status !== 'ACTIVE') {
      this.realtime.toUser(id, 'account:restricted', { status: dto.status });
      this.realtime.io?.in(`user:${id}`).disconnectSockets(true);
    }
    await this.log(a, 'user.status_changed', 'user', id, { from: u.status, to: dto.status, reason: dto.reason }, req);
    return { ok: true };
  }

  @Post('users/:id/points')
  @HttpCode(200)
  @RequirePermissions('points.adjust')
  async adjustPoints(
    @CurrentAdmin() a: AdminContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustPointsDto,
    @Req() req: Request,
  ) {
    const key = dto.requestId ?? randomUUID();
    const balance = await this.prisma.$transaction((tx) =>
      this.points.apply(tx, {
        userId: id,
        amount: dto.amount,
        type: 'ADMIN_ADJUSTMENT',
        idempotencyKey: `admin:${a.id}:${key}`,
        note: dto.note,
        refType: 'admin',
        refId: a.id,
      }),
    );
    await this.log(a, 'user.points_adjusted', 'user', id, { amount: dto.amount, note: dto.note, balance }, req);
    return { balance };
  }

  // ── Games ────────────────────────────────────────────────────

  @Get('games')
  @RequirePermissions('games.manage')
  games() {
    return this.prisma.game.findMany({ orderBy: { sortOrder: 'asc' }, include: { category: true } }).then((items) => ({ items }));
  }

  @Patch('games/:id')
  @RequirePermissions('games.manage')
  async updateGame(
    @CurrentAdmin() a: AdminContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GameUpdateDto,
    @Req() req: Request,
  ) {
    const g = await this.prisma.game.findUniqueOrThrow({ where: { id } });
    if (dto.config) {
      try {
        getEngine(g.code).normalizeConfig(dto.config);
      } catch (e) {
        throw new BadRequestException(`Invalid config: ${(e as Error).message}`);
      }
    }
    const updated = await this.prisma.game.update({
      where: { id },
      data: { ...dto, config: dto.config as Prisma.InputJsonValue | undefined },
    });
    await this.log(a, 'game.updated', 'game', id, dto as Record<string, unknown>, req);
    return updated;
  }

  @Get('game-categories')
  @RequirePermissions('games.manage')
  categories() {
    return this.prisma.gameCategory
      .findMany({ orderBy: { sortOrder: 'asc' }, include: { _count: { select: { games: true } } } })
      .then((items) => ({ items }));
  }

  @Post('game-categories')
  @RequirePermissions('games.manage')
  async createCategory(@CurrentAdmin() a: AdminContext, @Body() dto: CategoryDto, @Req() req: Request) {
    const c = await this.prisma.gameCategory.create({ data: dto });
    await this.log(a, 'category.created', 'category', c.id, { ...dto }, req);
    return c;
  }

  @Patch('game-categories/:id')
  @RequirePermissions('games.manage')
  async updateCategory(
    @CurrentAdmin() a: AdminContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CategoryDto,
    @Req() req: Request,
  ) {
    const c = await this.prisma.gameCategory.update({ where: { id }, data: dto });
    await this.log(a, 'category.updated', 'category', id, { ...dto }, req);
    return c;
  }

  // ── Rooms ────────────────────────────────────────────────────

  @Get('rooms')
  @RequirePermissions('rooms.read')
  async rooms(@Query() q: PageQuery) {
    const where: Prisma.RoomWhereInput = {
      ...(q.status ? { status: q.status as never } : { status: { not: 'CLOSED' } }),
      ...(q.q ? { OR: [{ code: q.q.toUpperCase() }, { name: { contains: q.q } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.room.findMany({
        where,
        ...paging(q),
        orderBy: { createdAt: 'desc' },
        include: {
          game: { select: { code: true, name: true } },
          host: { select: { username: true } },
          _count: { select: { players: { where: { status: 'SEATED' } }, sessions: true } },
        },
      }),
      this.prisma.room.count({ where }),
    ]);
    return {
      items: items.map(({ passwordHash, ...r }) => ({ ...r, hasPassword: !!passwordHash })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  @Post('rooms/:id/close')
  @HttpCode(200)
  @RequirePermissions('rooms.manage')
  async closeRoom(@CurrentAdmin() a: AdminContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    await this.mp.adminClose(id);
    await this.log(a, 'room.closed', 'room', id, {}, req);
    return { ok: true };
  }

  // ── Associations ─────────────────────────────────────────────

  @Get('associations')
  @RequirePermissions('associations.read')
  async associations(@Query() q: PageQuery) {
    const where: Prisma.AssociationWhereInput = {
      deletedAt: null,
      ...(q.q ? { OR: [{ name: { contains: q.q } }, { publicId: q.q.toUpperCase() }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.association.findMany({
        where,
        ...paging(q),
        orderBy: { createdAt: 'desc' },
        include: { owner: { select: { id: true, username: true } } },
      }),
      this.prisma.association.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  @Delete('associations/:id')
  @RequirePermissions('associations.manage')
  async deleteAssociation(@CurrentAdmin() a: AdminContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    await this.prisma.association.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.log(a, 'association.deleted', 'association', id, {}, req);
    return { ok: true };
  }

  // ── Chat moderation ──────────────────────────────────────────

  @Get('messages')
  @RequirePermissions('chat.moderate')
  async messages(@Query() q: PageQuery, @Query('userId') userId?: string, @Query('chatRoomId') chatRoomId?: string) {
    const where: Prisma.MessageWhereInput = {
      ...(q.q ? { content: { contains: q.q } } : {}),
      ...(userId ? { senderId: userId } : {}),
      ...(chatRoomId ? { chatRoomId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        ...paging(q),
        orderBy: { createdAt: 'desc' },
        include: { sender: { select: { id: true, username: true } }, chatRoom: { select: { id: true, type: true, name: true } } },
      }),
      this.prisma.message.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  @Delete('messages/:id')
  @RequirePermissions('chat.moderate')
  async deleteMessage(@CurrentAdmin() a: AdminContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const m = await this.prisma.message.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: a.id } });
    const members = await this.prisma.chatMember.findMany({ where: { chatRoomId: m.chatRoomId }, select: { userId: true } });
    this.realtime.toUsers(
      members.map((x) => x.userId),
      'chat:deleted',
      { id, chatRoomId: m.chatRoomId },
    );
    await this.log(a, 'message.deleted', 'message', id, { senderId: m.senderId }, req);
    return { ok: true };
  }

  // ── Reports ──────────────────────────────────────────────────

  @Get('reports')
  @RequirePermissions('reports.read')
  async reports(@Query() q: PageQuery) {
    const where: Prisma.UserReportWhereInput = q.status ? { status: q.status as ReportStatus } : {};
    const [items, total] = await Promise.all([
      this.prisma.userReport.findMany({
        where,
        ...paging(q),
        orderBy: { createdAt: 'desc' },
        include: {
          reporter: { select: { id: true, username: true } },
          reported: { select: { id: true, username: true, status: true } },
          handledBy: { select: { name: true } },
        },
      }),
      this.prisma.userReport.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  @Patch('reports/:id')
  @RequirePermissions('reports.manage')
  async updateReport(
    @CurrentAdmin() a: AdminContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportUpdateDto,
    @Req() req: Request,
  ) {
    const r = await this.prisma.userReport.update({
      where: { id },
      data: { status: dto.status, resolution: dto.resolution, handledById: a.id },
    });
    await this.log(a, 'report.updated', 'report', id, { ...dto }, req);
    return r;
  }

  // ── Gifts ────────────────────────────────────────────────────

  @Get('gifts')
  @RequirePermissions('gifts.manage')
  gifts() {
    return this.prisma.gift
      .findMany({ orderBy: { sortOrder: 'asc' }, include: { _count: { select: { transactions: true } } } })
      .then((items) => ({ items }));
  }

  @Post('gifts')
  @RequirePermissions('gifts.manage')
  async createGift(@CurrentAdmin() a: AdminContext, @Body() dto: GiftDto, @Req() req: Request) {
    const g = await this.prisma.gift.create({ data: dto });
    await this.log(a, 'gift.created', 'gift', g.id, { ...dto }, req);
    return g;
  }

  @Patch('gifts/:id')
  @RequirePermissions('gifts.manage')
  async updateGift(@CurrentAdmin() a: AdminContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GiftDto, @Req() req: Request) {
    const g = await this.prisma.gift.update({ where: { id }, data: dto });
    await this.log(a, 'gift.updated', 'gift', id, { ...dto }, req);
    return g;
  }

  // ── Leaderboard ──────────────────────────────────────────────

  @Get('leaderboard')
  @RequirePermissions('leaderboard.read')
  leaderboard(@Query('period') period = 'weekly', @Query('game') game = 'ALL') {
    return this.lb.top('00000000-0000-0000-0000-000000000000', period, game, 100);
  }

  @Get('leaderboard/associations')
  @RequirePermissions('leaderboard.read')
  associationBoard(@Query('period') period = 'weekly') {
    return this.lb.associations(period, 100);
  }

  // ── Banners ──────────────────────────────────────────────────

  @Get('banners')
  @RequirePermissions('banners.manage')
  banners() {
    return this.prisma.banner.findMany({ orderBy: { sortOrder: 'asc' } }).then((items) => ({ items }));
  }

  @Post('banners')
  @RequirePermissions('banners.manage')
  async createBanner(@CurrentAdmin() a: AdminContext, @Body() dto: BannerDto, @Req() req: Request) {
    const b = await this.prisma.banner.create({
      data: { ...dto, startsAt: dto.startsAt ? new Date(dto.startsAt) : null, endsAt: dto.endsAt ? new Date(dto.endsAt) : null },
    });
    await this.log(a, 'banner.created', 'banner', b.id, { title: dto.title }, req);
    return b;
  }

  @Patch('banners/:id')
  @RequirePermissions('banners.manage')
  async updateBanner(@CurrentAdmin() a: AdminContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BannerDto, @Req() req: Request) {
    const b = await this.prisma.banner.update({
      where: { id },
      data: { ...dto, startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined, endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined },
    });
    await this.log(a, 'banner.updated', 'banner', id, { title: dto.title }, req);
    return b;
  }

  @Delete('banners/:id')
  @RequirePermissions('banners.manage')
  async deleteBanner(@CurrentAdmin() a: AdminContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    await this.prisma.banner.delete({ where: { id } });
    await this.log(a, 'banner.deleted', 'banner', id, {}, req);
    return { ok: true };
  }

  // ── Broadcast notifications ──────────────────────────────────

  @Get('notifications')
  @RequirePermissions('notifications.send')
  broadcasts() {
    return this.prisma.broadcastNotification
      .findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { createdBy: { select: { name: true } } } })
      .then((items) => ({ items }));
  }

  @Post('notifications')
  @RequirePermissions('notifications.send')
  async broadcast(@CurrentAdmin() a: AdminContext, @Body() dto: BroadcastDto, @Req() req: Request) {
    const where: Prisma.UserWhereInput = {
      status: 'ACTIVE',
      ...(dto.audience === 'ACTIVE_7D' ? { lastSeenAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } : {}),
    };
    let sent = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.user.findMany({
        where,
        select: { id: true },
        take: 500,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!batch.length) break;
      for (const u of batch) await this.notifications.notify(u.id, 'SYSTEM', dto.title, dto.body, {});
      sent += batch.length;
      cursor = batch[batch.length - 1].id;
    }
    const b = await this.prisma.broadcastNotification.create({ data: { ...dto, sentCount: sent, createdById: a.id } });
    await this.log(a, 'notification.broadcast', 'broadcast', b.id, { audience: dto.audience, sent }, req);
    return b;
  }

  // ── Support ──────────────────────────────────────────────────

  @Get('support')
  @RequirePermissions('support.read')
  async tickets(@Query() q: PageQuery) {
    const where: Prisma.SupportTicketWhereInput = q.status ? { status: q.status as TicketStatus } : {};
    const [items, total] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        ...paging(q),
        orderBy: { updatedAt: 'desc' },
        include: { user: { select: { id: true, username: true, email: true } }, assignedTo: { select: { name: true } } },
      }),
      this.prisma.supportTicket.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  @Get('support/:id')
  @RequirePermissions('support.read')
  async ticket(@Param('id', ParseUUIDPipe) id: string) {
    const t = await this.prisma.supportTicket.findUnique({
      where: { id },
      include: { user: { select: { id: true, username: true, email: true } }, messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!t) throw new NotFoundException('Ticket not found');
    return t;
  }

  @Post('support/:id/reply')
  @RequirePermissions('support.manage')
  async replyTicket(
    @CurrentAdmin() a: AdminContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TicketReplyDto,
    @Req() req: Request,
  ) {
    const t = await this.support.staffReply(a.id, id, dto.body, dto.status);
    await this.log(a, 'support.replied', 'ticket', id, { status: dto.status }, req);
    return t;
  }

  @Patch('support/:id')
  @RequirePermissions('support.manage')
  async updateTicket(
    @CurrentAdmin() a: AdminContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TicketUpdateDto,
    @Req() req: Request,
  ) {
    const t = await this.prisma.supportTicket.update({ where: { id }, data: dto });
    await this.log(a, 'support.updated', 'ticket', id, { ...dto }, req);
    return t;
  }

  // ── Roles, permissions, admin users ──────────────────────────

  @Get('permissions')
  @RequirePermissions('admins.manage')
  permissions() {
    return { items: PERMISSIONS };
  }

  @Get('roles')
  @RequirePermissions('admins.manage')
  async roles() {
    const rows = await this.prisma.adminRole.findMany({
      include: { permissions: { include: { permission: true } }, _count: { select: { admins: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        admins: r._count.admins,
        permissions: r.permissions.map((p) => p.permission.key),
      })),
    };
  }

  private async setRolePermissions(roleId: string, keys: string[]) {
    const perms = await this.prisma.adminPermission.findMany({ where: { key: { in: keys } } });
    await this.prisma.$transaction([
      this.prisma.adminRolePermission.deleteMany({ where: { roleId } }),
      this.prisma.adminRolePermission.createMany({ data: perms.map((p) => ({ roleId, permissionId: p.id })) }),
    ]);
  }

  @Post('roles')
  @RequirePermissions('admins.manage')
  async createRole(@CurrentAdmin() a: AdminContext, @Body() dto: RoleDto, @Req() req: Request) {
    const r = await this.prisma.adminRole.create({ data: { key: dto.key, name: dto.name, description: dto.description } });
    await this.setRolePermissions(r.id, dto.permissions);
    await this.log(a, 'role.created', 'role', r.id, { ...dto }, req);
    return r;
  }

  @Patch('roles/:id')
  @RequirePermissions('admins.manage')
  async updateRole(
    @CurrentAdmin() a: AdminContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RoleUpdateDto,
    @Req() req: Request,
  ) {
    const role = await this.prisma.adminRole.findUniqueOrThrow({ where: { id } });
    if (role.key === 'SUPER_ADMIN' && dto.permissions) throw new BadRequestException('Super Admin always has every permission');
    await this.prisma.adminRole.update({ where: { id }, data: { name: dto.name, description: dto.description } });
    if (dto.permissions) await this.setRolePermissions(id, dto.permissions);
    await this.log(a, 'role.updated', 'role', id, { ...dto }, req);
    return { ok: true };
  }

  @Get('admins')
  @RequirePermissions('admins.manage')
  admins() {
    return this.prisma.adminUser
      .findMany({
        select: {
          id: true,
          email: true,
          name: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          role: { select: { id: true, key: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      })
      .then((items) => ({ items }));
  }

  @Post('admins')
  @RequirePermissions('admins.manage')
  async createAdmin(@CurrentAdmin() a: AdminContext, @Body() dto: AdminCreateDto, @Req() req: Request) {
    const created = await this.prisma.adminUser.create({
      data: {
        email: dto.email.toLowerCase(),
        name: dto.name,
        roleId: dto.roleId,
        passwordHash: await argon2.hash(dto.password, ARGON_OPTS),
      },
      select: { id: true, email: true, name: true },
    });
    await this.log(a, 'admin.created', 'admin', created.id, { email: created.email, roleId: dto.roleId }, req);
    return created;
  }

  @Patch('admins/:id')
  @RequirePermissions('admins.manage')
  async updateAdmin(
    @CurrentAdmin() a: AdminContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateDto,
    @Req() req: Request,
  ) {
    if (id === a.id) throw new BadRequestException('You cannot change your own role or status');
    await this.prisma.adminUser.update({ where: { id }, data: dto });
    if (dto.status === 'DISABLED')
      await this.prisma.adminSession.updateMany({ where: { adminId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.log(a, 'admin.updated', 'admin', id, { ...dto }, req);
    return { ok: true };
  }

  // ── Audit & settings ─────────────────────────────────────────

  @Get('audit')
  @RequirePermissions('audit.read')
  async auditLogs(@Query() q: PageQuery, @Query('actorId') actorId?: string) {
    const where: Prisma.AuditLogWhereInput = { ...(q.q ? { action: { contains: q.q } } : {}), ...(actorId ? { actorId } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, ...paging(q), orderBy: { createdAt: 'desc' } }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  @Get('settings')
  @RequirePermissions('settings.manage')
  async allSettings() {
    return { items: await this.settings.all() };
  }

  @Put('settings/:key')
  @RequirePermissions('settings.manage')
  async putSetting(@CurrentAdmin() a: AdminContext, @Param('key') key: string, @Body() dto: SettingDto, @Req() req: Request) {
    if (!(key in SETTING_DEFAULTS)) throw new NotFoundException('Unknown setting');
    try {
      await this.settings.set(key as SettingKey, dto.value, a.id);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    await this.log(a, 'setting.updated', 'setting', key, { value: dto.value }, req);
    return { ok: true };
  }

  @Get('games-codes')
  codes() {
    return { items: Object.values(GameCode) };
  }
}

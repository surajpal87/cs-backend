import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { ChatService } from '../chat/chat.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { EngineEvent, GameCodeName, GameRuleError, PlayerAction, SeatedPlayer } from '../games/core/engine';
import { SeededRng } from '../games/core/rng';
import { AnyEngine, getEngine } from '../games/registry';
import { AchievementsService } from '../leaderboard/achievements.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { PointsService } from '../points/points.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RoomRuntimeConfig } from '../rooms/rooms.service';

const COUNTDOWN_MS = 4000;
const RESULT_PAUSE_MS = 6000;
const DISCONNECT_GRACE_MS = 30_000;
const DISCONNECT_EVICT_MS = 120_000;
const EMPTY_ROOM_CLOSE_MS = 10 * 60_000;
const ACTION_CACHE = 500;

interface Seat {
  seat: number;
  userId: string;
  roomPlayerId: string;
  joinedAt: Date;
  name: string;
  avatarPreset: string;
  stack: number;
  connected: boolean;
  disconnectedAt: number | null;
  leaving: boolean;
  sittingOut: boolean;
}

interface LoggedEvent {
  seq: number;
  type: string;
  actorId: string | null;
  payload: Record<string, unknown>;
}

export interface ActionInput {
  actionId: string;
  type: string;
  expectedVersion?: number;
  [key: string]: unknown;
}

class LiveRoom {
  seats = new Map<number, Seat>();
  spectators = new Set<string>();
  handNumber = 0;
  state: unknown = null;
  engine: AnyEngine;
  sessionId: string | null = null;
  rng: SeededRng | null = null;
  participants: string[] = [];
  version = 0;
  eventSeq = 0;
  events: LoggedEvent[] = [];
  timer: NodeJS.Timeout | null = null;
  deadline: number | null = null;
  pendingKey: string[] = [];
  nextTimer: NodeJS.Timeout | null = null;
  countdownUntil: number | null = null;
  hadHumanAction = false;
  paused = false;
  closed = false;
  emptySince: number | null = Date.now();
  actionResults = new Map<string, unknown>();
  queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly id: string,
    readonly code: string,
    readonly name: string,
    readonly gameCode: GameCodeName,
    readonly gameId: string,
    readonly hostId: string,
    readonly visibility: 'PUBLIC' | 'PRIVATE',
    readonly associationId: string | null,
    readonly passwordHash: string | null,
    readonly chatRoomId: string | null,
    readonly maxPlayers: number,
    readonly config: RoomRuntimeConfig,
  ) {
    this.engine = getEngine(gameCode);
  }

  get inHand(): boolean {
    return this.state !== null && !this.engine.isComplete(this.state);
  }

  seatOf(userId: string): Seat | undefined {
    for (const s of this.seats.values()) if (s.userId === userId) return s;
    return undefined;
  }
}

/**
 * Authoritative game-room runtime. All mutations of a room are serialised through a per-room
 * promise queue; clients only send intents (actions) and receive versioned state batches.
 * Card distribution, RNG, timers and settlement happen exclusively here.
 *
 * Scaling note: a room lives on exactly one instance. With several instances, route
 * sockets for a room to the same node (sticky sessions by room) and use the Redis adapter
 * for cross-node user notifications. See documentation/ARCHITECTURE.md.
 */
@Injectable()
export class MultiplayerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MultiplayerService.name);
  private readonly rooms = new Map<string, LiveRoom>();
  private readonly loading = new Map<string, Promise<LiveRoom>>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly points: PointsService,
    private readonly leaderboard: LeaderboardService,
    private readonly achievements: AchievementsService,
    private readonly chat: ChatService,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────

  async onModuleInit() {
    await this.recoverAfterRestart();
    this.sweeper = setInterval(() => this.sweep().catch((e) => this.log.error(`sweep failed: ${e.message}`)), 15_000);
  }

  onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const r of this.rooms.values()) this.clearTimers(r);
  }

  /**
   * After a crash/restart in-memory hands are gone. Void unfinished hands and return every
   * seated stack (last settled value) to its owner's balance, idempotently.
   */
  private async recoverAfterRestart() {
    const aborted = await this.prisma.gameSession.updateMany({
      where: { status: 'IN_PROGRESS' },
      data: { status: 'ABORTED', endedAt: new Date() },
    });
    const seated = await this.prisma.roomPlayer.findMany({ where: { status: 'SEATED' } });
    for (const p of seated) {
      await this.prisma.$transaction(async (tx) => {
        if (p.stack > 0) {
          await this.points.apply(tx, {
            userId: p.userId,
            amount: p.stack,
            type: 'TABLE_RETURN',
            idempotencyKey: `return:${p.id}:${p.joinedAt.getTime()}`,
            refType: 'room',
            refId: p.roomId,
            note: 'Returned after server restart',
          });
        }
        await tx.roomPlayer.update({ where: { id: p.id }, data: { status: 'LEFT', stack: 0, leftAt: new Date() } });
      });
    }
    await this.prisma.room.updateMany({ where: { status: 'PLAYING' }, data: { status: 'WAITING' } });
    if (aborted.count || seated.length) this.log.warn(`Recovery: voided ${aborted.count} hands, returned ${seated.length} table stacks`);
  }

  private run<T>(room: LiveRoom, fn: () => Promise<T>): Promise<T> {
    const next = room.queue.then(fn, fn);
    room.queue = next.catch(() => undefined);
    return next;
  }

  private async load(roomId: string): Promise<LiveRoom> {
    const live = this.rooms.get(roomId);
    if (live) return live;
    const pending = this.loading.get(roomId);
    if (pending) return pending;
    const p = (async () => {
      const r = await this.prisma.room.findFirst({
        where: { OR: [{ id: /^[0-9a-f-]{36}$/i.test(roomId) ? roomId : undefined }, { code: roomId.toUpperCase() }] },
        include: { game: true, chatRoom: { select: { id: true } } },
      });
      if (!r || r.status === 'CLOSED') throw new NotFoundException({ code: 'ROOM_NOT_FOUND', message: 'Room not found or closed' });
      const existing = this.rooms.get(r.id);
      if (existing) return existing;
      const room = new LiveRoom(
        r.id,
        r.code,
        r.name,
        r.game.code,
        r.gameId,
        r.hostId,
        r.visibility,
        r.associationId,
        r.passwordHash,
        r.chatRoom?.id ?? null,
        r.maxPlayers,
        r.config as unknown as RoomRuntimeConfig,
      );
      const seated = await this.prisma.roomPlayer.findMany({
        where: { roomId: r.id, status: 'SEATED' },
        include: { user: { include: { profile: true } } },
      });
      for (const p of seated) {
        room.seats.set(p.seat, {
          seat: p.seat,
          userId: p.userId,
          roomPlayerId: p.id,
          joinedAt: p.joinedAt,
          name: p.user.profile?.displayName ?? p.user.username,
          avatarPreset: p.user.profile?.avatarPreset ?? 'royal-1',
          stack: p.stack,
          connected: false,
          disconnectedAt: Date.now(),
          leaving: false,
          sittingOut: false,
        });
      }
      this.rooms.set(r.id, room);
      return room;
    })();
    this.loading.set(roomId, p);
    try {
      return await p;
    } finally {
      this.loading.delete(roomId);
    }
  }

  roomIdsForUser(userId: string): string[] {
    const out: string[] = [];
    for (const r of this.rooms.values()) if (r.seatOf(userId) || r.spectators.has(userId)) out.push(r.id);
    return out;
  }

  // ── Views ─────────────────────────────────────────────────────

  private roomMeta(room: LiveRoom) {
    return {
      roomId: room.id,
      code: room.code,
      name: room.name,
      game: room.gameCode,
      hostId: room.hostId,
      visibility: room.visibility,
      maxPlayers: room.maxPlayers,
      chatRoomId: room.chatRoomId,
      config: room.config.game,
      buyIn: room.config.buyIn,
      minStackToPlay: room.engine.minStackToPlay(room.config.game),
      handNumber: room.handNumber,
      countdownUntil: room.countdownUntil,
      paused: room.paused,
      spectators: room.spectators.size,
      seats: [...room.seats.values()]
        .sort((a, b) => a.seat - b.seat)
        .map((s) => ({
          seat: s.seat,
          userId: s.userId,
          name: s.name,
          avatarPreset: s.avatarPreset,
          stack: s.stack,
          connected: s.connected,
          leaving: s.leaving,
          inHand: room.inHand && room.participants.includes(s.userId),
        })),
    };
  }

  private timerInfo(room: LiveRoom) {
    return room.deadline ? { deadline: room.deadline, userIds: room.pendingKey, serverNow: Date.now() } : null;
  }

  snapshot(room: LiveRoom, userId: string) {
    return {
      seq: room.version,
      room: this.roomMeta(room),
      game: room.state ? room.engine.view(room.state, room.participants.includes(userId) ? userId : null) : null,
      legalActions: room.state ? room.engine.legalActions(room.state, userId) : [],
      timer: this.timerInfo(room),
      mySeat: room.seatOf(userId)?.seat ?? null,
      serverNow: Date.now(),
    };
  }

  private audience(room: LiveRoom): string[] {
    const ids = new Set<string>(room.spectators);
    for (const s of room.seats.values()) ids.add(s.userId);
    return [...ids];
  }

  /** Lightweight seat/meta update (not versioned). */
  private broadcastMeta(room: LiveRoom) {
    this.realtime.toUsers(this.audience(room), 'room:update', this.roomMeta(room));
  }

  /** Versioned game batch: personalised view + filtered animation events for every viewer. */
  private broadcastBatch(room: LiveRoom, events: EngineEvent[], actorId: string | null) {
    room.version++;
    const ts = Date.now();
    for (const e of events) {
      room.events.push({ seq: ++room.eventSeq, type: e.type, actorId, payload: e.to ? { ...e.payload, _private: true } : e.payload });
    }
    for (const uid of this.audience(room)) {
      const inHand = room.participants.includes(uid);
      this.realtime.toUser(uid, 'game:batch', {
        roomId: room.id,
        seq: room.version,
        ts,
        handNumber: room.handNumber,
        events: events.filter((e) => !e.to || e.to.includes(uid)).map((e) => ({ eventId: randomUUID(), type: e.type, payload: e.payload })),
        game: room.state ? room.engine.view(room.state, inHand ? uid : null) : null,
        legalActions: room.state && inHand ? room.engine.legalActions(room.state, uid) : [],
        timer: this.timerInfo(room),
      });
    }
  }

  // ── Joining / seating ────────────────────────────────────────

  async join(userId: string, roomRef: string, password?: string) {
    const room = await this.load(roomRef);
    return this.run(room, async () => {
      if (room.closed) throw new NotFoundException({ code: 'ROOM_NOT_FOUND', message: 'Room is closed' });
      const seat = room.seatOf(userId);
      if (!seat) await this.checkAccess(room, userId, password);
      if (seat) {
        seat.connected = true;
        seat.disconnectedAt = null;
      } else room.spectators.add(userId);
      room.emptySince = null;
      this.broadcastMeta(room);
      return this.snapshot(room, userId);
    });
  }

  private async checkAccess(room: LiveRoom, userId: string, password?: string) {
    if (room.hostId === userId) return;
    if (room.associationId) {
      const m = await this.prisma.associationMember.findUnique({
        where: { associationId_userId: { associationId: room.associationId, userId } },
      });
      if (m?.status === 'ACTIVE') return;
      if (!room.passwordHash) throw new ForbiddenException({ code: 'MEMBERS_ONLY', message: 'This table is for association members' });
    }
    if (room.passwordHash) {
      if (!password || !(await argon2.verify(room.passwordHash, password))) {
        throw new ForbiddenException({ code: 'ROOM_PASSWORD', message: 'Incorrect room password' });
      }
    }
  }

  async sit(userId: string, roomId: string, seatNo: number | undefined, buyIn: number) {
    const room = await this.load(roomId);
    return this.run(room, async () => {
      if (room.seatOf(userId)) throw new BadRequestException({ code: 'ALREADY_SEATED', message: 'You are already seated' });
      if (!room.spectators.has(userId)) throw new ForbiddenException({ code: 'JOIN_FIRST', message: 'Join the room first' });
      const { min, max } = room.config.buyIn;
      if (!Number.isInteger(buyIn) || buyIn < min || buyIn > max)
        throw new BadRequestException({ code: 'BAD_BUY_IN', message: `Buy-in must be between ${min} and ${max}` });
      const free = [...Array(room.maxPlayers).keys()].filter((i) => !room.seats.has(i));
      if (!free.length) throw new BadRequestException({ code: 'TABLE_FULL', message: 'Table is full' });
      const seat = seatNo ?? free[0];
      if (!free.includes(seat)) throw new BadRequestException({ code: 'SEAT_TAKEN', message: 'Seat is taken' });
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { profile: true } });
      const now = new Date();
      const rp = await this.prisma.$transaction(async (tx) => {
        const row = await tx.roomPlayer.upsert({
          where: { roomId_userId: { roomId: room.id, userId } },
          create: { roomId: room.id, userId, seat, stack: buyIn, status: 'SEATED', joinedAt: now },
          update: { seat, stack: buyIn, status: 'SEATED', joinedAt: now, leftAt: null },
        });
        await this.points.apply(tx, {
          userId,
          amount: -buyIn,
          type: 'TABLE_BUY_IN',
          idempotencyKey: `buyin:${row.id}:${now.getTime()}`,
          refType: 'room',
          refId: room.id,
        });
        if (room.chatRoomId) await this.chat.addMember(room.chatRoomId, userId, tx);
        return row;
      });
      room.spectators.delete(userId);
      room.seats.set(seat, {
        seat,
        userId,
        roomPlayerId: rp.id,
        joinedAt: now,
        name: user.profile?.displayName ?? user.username,
        avatarPreset: user.profile?.avatarPreset ?? 'royal-1',
        stack: buyIn,
        connected: true,
        disconnectedAt: null,
        leaving: false,
        sittingOut: false,
      });
      room.paused = false;
      this.broadcastMeta(room);
      this.realtime.toUsers(this.audience(room), 'room:player', { roomId: room.id, type: 'joined', userId, seat });
      this.maybeScheduleHand(room);
      return this.snapshot(room, userId);
    });
  }

  async rebuy(userId: string, roomId: string, amount: number, actionId: string) {
    const room = await this.load(roomId);
    return this.run(room, async () => {
      const seat = room.seatOf(userId);
      if (!seat) throw new BadRequestException({ code: 'NOT_SEATED', message: 'You are not seated' });
      if (room.inHand && room.participants.includes(userId))
        throw new BadRequestException({ code: 'IN_HAND', message: 'Wait for the hand to finish' });
      const max = room.config.buyIn.max;
      if (!Number.isInteger(amount) || amount <= 0 || seat.stack + amount > max)
        throw new BadRequestException({ code: 'BAD_BUY_IN', message: `Table maximum is ${max}` });
      await this.prisma.$transaction(async (tx) => {
        await this.points.apply(tx, {
          userId,
          amount: -amount,
          type: 'TABLE_BUY_IN',
          idempotencyKey: `rebuy:${seat.roomPlayerId}:${actionId}`,
          refType: 'room',
          refId: room.id,
        });
        await tx.roomPlayer.update({ where: { id: seat.roomPlayerId }, data: { stack: { increment: amount } } });
      });
      seat.stack += amount;
      seat.sittingOut = false;
      this.broadcastMeta(room);
      this.maybeScheduleHand(room);
      return this.snapshot(room, userId);
    });
  }

  async leave(userId: string, roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: true };
    return this.run(room, async () => {
      room.spectators.delete(userId);
      const seat = room.seatOf(userId);
      if (seat) {
        if (room.inHand && room.participants.includes(userId)) {
          // Finish their part of the hand automatically, then cash out at hand end.
          seat.leaving = true;
          this.rescheduleTimer(room);
        } else await this.cashOut(room, seat);
      }
      this.broadcastMeta(room);
      return { ok: true };
    });
  }

  private async cashOut(room: LiveRoom, seat: Seat, note?: string) {
    await this.prisma.$transaction(async (tx) => {
      if (seat.stack > 0) {
        await this.points.apply(tx, {
          userId: seat.userId,
          amount: seat.stack,
          type: 'TABLE_RETURN',
          idempotencyKey: `return:${seat.roomPlayerId}:${seat.joinedAt.getTime()}`,
          refType: 'room',
          refId: room.id,
          note,
        });
      }
      await tx.roomPlayer.update({ where: { id: seat.roomPlayerId }, data: { status: 'LEFT', stack: 0, leftAt: new Date() } });
    });
    room.seats.delete(seat.seat);
    this.realtime.toUsers([...this.audience(room), seat.userId], 'room:player', {
      roomId: room.id,
      type: 'left',
      userId: seat.userId,
      seat: seat.seat,
      returned: seat.stack,
    });
    if (!room.seats.size) room.emptySince = Date.now();
  }

  disconnected(userId: string) {
    for (const room of this.rooms.values()) {
      const seat = room.seatOf(userId);
      room.spectators.delete(userId);
      if (seat) {
        this.run(room, async () => {
          seat.connected = false;
          seat.disconnectedAt = Date.now();
          this.broadcastMeta(room);
        }).catch(() => undefined);
      }
    }
  }

  async kick(hostId: string, roomId: string, targetId: string) {
    const room = await this.load(roomId);
    return this.run(room, async () => {
      if (room.hostId !== hostId) throw new ForbiddenException({ code: 'HOST_ONLY', message: 'Only the host can do that' });
      if (room.visibility !== 'PRIVATE')
        throw new ForbiddenException({ code: 'PRIVATE_ONLY', message: 'Players can only be removed from private tables' });
      const seat = room.seatOf(targetId);
      if (!seat || targetId === hostId) throw new BadRequestException('Player is not seated');
      if (room.inHand && room.participants.includes(targetId)) seat.leaving = true;
      else await this.cashOut(room, seat, 'Removed by host');
      this.realtime.toUser(targetId, 'room:kicked', { roomId: room.id });
      this.broadcastMeta(room);
      return { ok: true };
    });
  }

  async close(userId: string | null, roomId: string, reason = 'Closed by host') {
    const room = await this.load(roomId);
    return this.run(room, async () => {
      if (userId && room.hostId !== userId)
        throw new ForbiddenException({ code: 'HOST_ONLY', message: 'Only the host can close the table' });
      if (room.inHand) throw new BadRequestException({ code: 'IN_HAND', message: 'Wait for the current hand to finish' });
      await this.closeNow(room, reason);
      return { ok: true };
    });
  }

  private async closeNow(room: LiveRoom, reason: string) {
    this.clearTimers(room);
    for (const seat of [...room.seats.values()]) await this.cashOut(room, seat, reason);
    room.closed = true;
    await this.prisma.room.update({ where: { id: room.id }, data: { status: 'CLOSED', closedAt: new Date() } });
    this.realtime.toUsers(this.audience(room), 'room:closed', { roomId: room.id, reason });
    this.rooms.delete(room.id);
  }

  async resume(userId: string, roomId: string) {
    const room = await this.load(roomId);
    return this.run(room, async () => {
      if (!room.seatOf(userId)) throw new BadRequestException({ code: 'NOT_SEATED', message: 'Take a seat first' });
      room.paused = false;
      this.maybeScheduleHand(room);
      this.broadcastMeta(room);
      return { ok: true };
    });
  }

  // ── Hands ─────────────────────────────────────────────────────

  private eligible(room: LiveRoom): Seat[] {
    const min = room.engine.minStackToPlay(room.config.game);
    const now = Date.now();
    return [...room.seats.values()].filter(
      (s) =>
        !s.leaving &&
        !s.sittingOut &&
        s.stack >= min &&
        (s.connected || (s.disconnectedAt !== null && now - s.disconnectedAt < DISCONNECT_GRACE_MS)),
    );
  }

  private maybeScheduleHand(room: LiveRoom) {
    if (room.inHand || room.nextTimer || room.paused || room.closed) return;
    if (this.eligible(room).length < Math.max(room.engine.minPlayers, 1)) {
      if (room.countdownUntil) {
        room.countdownUntil = null;
        this.broadcastMeta(room);
      }
      return;
    }
    room.countdownUntil = Date.now() + COUNTDOWN_MS;
    this.broadcastMeta(room);
    room.nextTimer = setTimeout(() => {
      room.nextTimer = null;
      this.run(room, () => this.startHand(room)).catch((e) => this.log.error(`startHand ${room.id}: ${e.message}`, e.stack));
    }, COUNTDOWN_MS);
  }

  private async startHand(room: LiveRoom) {
    room.countdownUntil = null;
    if (room.inHand || room.closed || room.paused) return;
    const seats = this.eligible(room);
    if (seats.length < Math.max(room.engine.minPlayers, 1)) {
      this.broadcastMeta(room);
      return;
    }
    const rng = SeededRng.fresh();
    const handNumber = room.handNumber + 1;
    const lastHand = await this.prisma.gameSession.findFirst({
      where: { roomId: room.id },
      orderBy: { handNumber: 'desc' },
      select: { handNumber: true },
    });
    const nextNumber = Math.max(handNumber, (lastHand?.handNumber ?? 0) + 1);
    const players: SeatedPlayer[] = seats.map((s) => ({ userId: s.userId, seat: s.seat, name: s.name, stack: s.stack }));
    const { state, events } = room.engine.start(players, room.config.game, { handNumber: nextNumber, rng });
    const session = await this.prisma.gameSession.create({
      data: { roomId: room.id, gameId: room.gameId, handNumber: nextNumber, seedCommit: rng.commitment },
    });
    await this.prisma.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
    room.handNumber = nextNumber;
    room.state = state;
    room.rng = rng;
    room.sessionId = session.id;
    room.participants = players.map((p) => p.userId);
    room.events = [];
    room.eventSeq = 0;
    room.hadHumanAction = false;
    room.pendingKey = [];
    room.deadline = null;
    events.unshift({ type: 'FAIRNESS_COMMIT', payload: { sessionId: session.id, seedCommit: rng.commitment } });
    this.rescheduleTimer(room);
    this.broadcastMeta(room);
    this.broadcastBatch(room, events, null);
  }

  async act(userId: string, roomId: string, input: ActionInput) {
    const room = this.rooms.get(roomId);
    if (!room) throw new NotFoundException({ code: 'ROOM_NOT_FOUND', message: 'Room not loaded; join first' });
    return this.run(room, async () => {
      const cacheKey = `${userId}:${input.actionId}`;
      if (room.actionResults.has(cacheKey)) return room.actionResults.get(cacheKey);
      if (!room.state || !room.inHand) throw new GameRuleError('No hand in progress', 'NO_HAND');
      if (!room.participants.includes(userId)) throw new GameRuleError('You are not playing this hand', 'NOT_IN_HAND');
      if (input.expectedVersion !== undefined && input.expectedVersion !== room.version) {
        throw new GameRuleError('Table state changed; resyncing', 'STALE_STATE');
      }
      const { actionId: _a, expectedVersion: _v, ...rest } = input;
      const action = rest as PlayerAction;
      const { state, events } = room.engine.act(room.state, userId, action, room.rng!);
      room.state = state;
      room.hadHumanAction = true;
      const seat = room.seatOf(userId);
      if (seat) seat.sittingOut = false;
      this.rescheduleTimer(room);
      this.broadcastBatch(room, events, userId);
      if (room.engine.isComplete(state)) await this.settle(room);
      const result = { ok: true, seq: room.version };
      room.actionResults.set(cacheKey, result);
      if (room.actionResults.size > ACTION_CACHE) room.actionResults.delete(room.actionResults.keys().next().value!);
      return result;
    });
  }

  private clearTimers(room: LiveRoom) {
    if (room.timer) clearTimeout(room.timer);
    if (room.nextTimer) clearTimeout(room.nextTimer);
    room.timer = null;
    room.nextTimer = null;
  }

  /**
   * Turn/phase timer. The deadline resets only when someone new must act (a new turn);
   * concurrent betting windows keep their original deadline as players lock in.
   */
  private rescheduleTimer(room: LiveRoom) {
    if (!room.state || room.engine.isComplete(room.state)) {
      if (room.timer) clearTimeout(room.timer);
      room.timer = null;
      room.deadline = null;
      room.pendingKey = [];
      return;
    }
    const pending = room.engine.pendingActors(room.state);
    const newActor = pending.some((p) => !room.pendingKey.includes(p));
    const expired = !room.deadline || room.deadline <= Date.now();
    const leavingTurn = pending.length > 0 && pending.every((p) => room.seatOf(p)?.leaving || !room.seatOf(p));
    if (newActor || expired || leavingTurn) {
      const ms = leavingTurn ? 300 : room.engine.timeoutSeconds(room.state, room.config.game) * 1000;
      room.deadline = Date.now() + ms;
      if (room.timer) clearTimeout(room.timer);
      room.timer = setTimeout(() => {
        this.run(room, () => this.onTimeout(room)).catch((e) => this.log.error(`timeout ${room.id}: ${e.message}`, e.stack));
      }, ms);
    }
    room.pendingKey = pending;
  }

  private async onTimeout(room: LiveRoom) {
    room.timer = null;
    if (!room.state || room.engine.isComplete(room.state)) return;
    if (room.deadline && room.deadline > Date.now() + 50) return; // superseded
    const { state, events } = room.engine.onTimeout(room.state, room.rng!);
    room.state = state;
    room.deadline = null;
    this.rescheduleTimer(room);
    this.broadcastBatch(room, events, null);
    if (room.engine.isComplete(state)) await this.settle(room);
  }

  /** Persists the finished hand atomically: session, history, events, stacks, leaderboards. */
  private async settle(room: LiveRoom) {
    const engine = room.engine;
    const state = room.state;
    const results = engine.results(state);
    const stacks = engine.finalStacks(state);
    const houseGame = engine.minPlayers === 1;
    const recorded = results.filter((r) => !houseGame || r.delta !== 0 || r.outcome !== 'DRAW');
    const sessionId = room.sessionId!;
    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.gameSession.update({
            where: { id: sessionId },
            data: {
              status: 'COMPLETED',
              seedReveal: room.rng!.seed,
              stateVersion: room.version,
              endedAt: new Date(),
              summary: { results, final: engine.view(state, null) } as unknown as Prisma.InputJsonValue,
            },
          });
          if (room.events.length) {
            await tx.gameEvent.createMany({
              data: room.events.map((e) => ({
                gameSessionId: sessionId,
                seq: e.seq,
                type: e.type,
                actorId: e.actorId,
                payload: e.payload as Prisma.InputJsonValue,
              })),
            });
          }
          for (const r of recorded) {
            await tx.gameHistory.create({
              data: {
                gameSessionId: sessionId,
                userId: r.userId,
                gameId: room.gameId,
                outcome: r.outcome,
                pointsDelta: r.delta,
                rank: r.rank,
                details: (r.details ?? {}) as Prisma.InputJsonValue,
              },
            });
          }
          for (const [uid, stack] of Object.entries(stacks)) {
            const seat = room.seatOf(uid);
            if (seat) await tx.roomPlayer.update({ where: { id: seat.roomPlayerId }, data: { stack } });
          }
          await this.leaderboard.recordHand(
            tx,
            room.gameCode,
            recorded.map((r) => ({ userId: r.userId, delta: r.delta, won: r.outcome === 'WIN' })),
          );
          await tx.room.update({ where: { id: room.id }, data: { status: 'WAITING' } });
        },
        { timeout: 20_000 },
      );
    } catch (e) {
      this.log.error(`settle failed for ${room.id} hand ${room.handNumber}: ${(e as Error).message}`, (e as Error).stack);
      throw e;
    }
    for (const [uid, stack] of Object.entries(stacks)) {
      const seat = room.seatOf(uid);
      if (seat) seat.stack = stack;
    }
    this.realtime.toUsers(this.audience(room), 'game:result', {
      roomId: room.id,
      handNumber: room.handNumber,
      sessionId,
      seedCommit: room.rng!.commitment,
      seedReveal: room.rng!.seed,
      results,
    });
    for (const s of [...room.seats.values()]) if (s.leaving) await this.cashOut(room, s);
    if (!room.hadHumanAction) room.paused = true;
    const minStack = engine.minStackToPlay(room.config.game);
    for (const s of room.seats.values()) if (s.stack < minStack) s.sittingOut = true;
    this.broadcastMeta(room);
    Promise.all(recorded.map((r) => this.achievements.evaluate(r.userId))).catch(() => undefined);
    room.nextTimer = setTimeout(() => {
      room.nextTimer = null;
      this.run(room, async () => this.maybeScheduleHand(room)).catch(() => undefined);
    }, RESULT_PAUSE_MS);
  }

  // ── Housekeeping ─────────────────────────────────────────────

  private async sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      await this.run(room, async () => {
        if (room.closed) return;
        for (const s of [...room.seats.values()]) {
          if (
            !s.connected &&
            s.disconnectedAt &&
            now - s.disconnectedAt > DISCONNECT_EVICT_MS &&
            !(room.inHand && room.participants.includes(s.userId))
          ) {
            await this.cashOut(room, s, 'Disconnected');
            this.broadcastMeta(room);
          }
        }
        if (!room.seats.size && !room.inHand) {
          room.emptySince ??= now;
          if (now - room.emptySince > EMPTY_ROOM_CLOSE_MS) await this.closeNow(room, 'Closed after inactivity');
        }
      }).catch((e) => this.log.warn(`sweep room ${room.id}: ${(e as Error).message}`));
    }
  }

  /** Admin: force-close a room (any state). Unfinished hands are voided and stacks returned. */
  async adminClose(roomId: string) {
    const live = this.rooms.get(roomId);
    if (!live) {
      const seated = await this.prisma.roomPlayer.findMany({ where: { roomId, status: 'SEATED' } });
      for (const p of seated) {
        await this.prisma.$transaction(async (tx) => {
          if (p.stack > 0) {
            await this.points.apply(tx, {
              userId: p.userId,
              amount: p.stack,
              type: 'TABLE_RETURN',
              idempotencyKey: `return:${p.id}:${p.joinedAt.getTime()}`,
              refType: 'room',
              refId: roomId,
            });
          }
          await tx.roomPlayer.update({ where: { id: p.id }, data: { status: 'LEFT', stack: 0, leftAt: new Date() } });
        });
      }
      await this.prisma.room.update({ where: { id: roomId }, data: { status: 'CLOSED', closedAt: new Date() } });
      return { ok: true };
    }
    return this.run(live, async () => {
      if (live.inHand && live.sessionId) {
        await this.prisma.gameSession.update({ where: { id: live.sessionId }, data: { status: 'ABORTED', endedAt: new Date() } });
        live.state = null;
      }
      await this.closeNow(live, 'Closed by moderator');
      return { ok: true };
    });
  }

  liveStats() {
    let players = 0;
    let hands = 0;
    for (const r of this.rooms.values()) {
      players += r.seats.size;
      if (r.inHand) hands++;
    }
    return { rooms: this.rooms.size, seatedPlayers: players, handsInProgress: hands };
  }

  getRoom(roomId: string) {
    return this.rooms.get(roomId);
  }
}

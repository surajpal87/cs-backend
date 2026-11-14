import { HttpException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { ChatService } from '../chat/chat.service';
import { verifyAccessToken } from '../common/guards/jwt-auth.guard';
import { PrismaService } from '../common/prisma/prisma.service';
import { PresenceService } from '../common/redis/presence.service';
import { FriendsService } from '../friends/friends.service';
import { GameRuleError } from '../games/core/engine';
import { GiftsService } from '../gifts/gifts.service';
import { MultiplayerService } from '../multiplayer/multiplayer.service';
import { RealtimeService } from './realtime.service';

type Ack = { ok: true; data?: unknown } | { ok: false; error: { code: string; message: string } };

interface AuthedSocket extends Socket {
  data: { userId: string; username: string; tokens: number; refillAt: number };
}

function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== 'string' || !v.length || v.length > max) throw new GameRuleError(`"${name}" is required`, 'BAD_PAYLOAD');
  return v;
}

/**
 * Single authenticated Socket.IO endpoint (path /socket.io) for game rooms, chat, presence
 * and notifications. Clients pass the access JWT in `auth.token`. Every request event takes
 * an ack callback that receives { ok, data } or { ok: false, error }.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true }, pingInterval: 20000, pingTimeout: 20000 })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger('Realtime');

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly presence: PresenceService,
    private readonly mp: MultiplayerService,
    private readonly chat: ChatService,
    private readonly friends: FriendsService,
    private readonly gifts: GiftsService,
  ) {}

  afterInit(server: Server) {
    this.realtime.attach(server);
    server.use(async (socket, next) => {
      try {
        const token = (socket.handshake.auth?.token as string) || '';
        if (!token) return next(new Error('UNAUTHENTICATED'));
        const user = await verifyAccessToken(this.jwt, this.prisma, token);
        socket.data = { userId: user.id, username: user.username, tokens: 40, refillAt: Date.now() };
        next();
      } catch {
        next(new Error('UNAUTHENTICATED'));
      }
    });
  }

  async handleConnection(socket: AuthedSocket) {
    const { userId } = socket.data;
    if (!userId) return socket.disconnect(true);
    await socket.join(`user:${userId}`);
    const first = await this.presence.connected(userId);
    if (first) await this.announcePresence(userId, true);
    socket.emit('session:ready', { userId, serverNow: Date.now() });
  }

  async handleDisconnect(socket: AuthedSocket) {
    const userId = socket.data?.userId;
    if (!userId) return;
    const last = await this.presence.disconnected(userId);
    if (last) {
      this.mp.disconnected(userId);
      await this.prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
      await this.announcePresence(userId, false);
    }
  }

  private async announcePresence(userId: string, online: boolean) {
    const profile = await this.prisma.profile.findUnique({ where: { userId }, select: { showOnlineStatus: true } });
    if (profile && !profile.showOnlineStatus) return;
    const friends = await this.friends.friendIds(userId);
    this.realtime.toUsers(friends, 'presence:update', { userId, online });
  }

  /** Token bucket: 20 events/s sustained, burst of 40. */
  private allow(socket: AuthedSocket): boolean {
    const now = Date.now();
    const d = socket.data;
    d.tokens = Math.min(40, d.tokens + ((now - d.refillAt) / 1000) * 20);
    d.refillAt = now;
    if (d.tokens < 1) return false;
    d.tokens -= 1;
    return true;
  }

  private async handle(socket: AuthedSocket, fn: () => Promise<unknown>): Promise<Ack> {
    if (!this.allow(socket)) return { ok: false, error: { code: 'RATE_LIMITED', message: 'Slow down' } };
    try {
      return { ok: true, data: await fn() };
    } catch (e) {
      if (e instanceof GameRuleError) return { ok: false, error: { code: e.code, message: e.message } };
      if (e instanceof HttpException) {
        const body = e.getResponse() as { code?: string; message?: string } | string;
        return {
          ok: false,
          error: {
            code: typeof body === 'string' ? 'ERROR' : (body.code ?? 'ERROR'),
            message: typeof body === 'string' ? body : (body.message ?? e.message),
          },
        };
      }
      this.log.error((e as Error).message, (e as Error).stack);
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } };
    }
  }

  // ── Game rooms ───────────────────────────────────────────────

  @SubscribeMessage('room:join')
  join(@ConnectedSocket() s: AuthedSocket, @MessageBody() b: { roomId: string; password?: string }) {
    return this.handle(s, async () => {
      const snap = await this.mp.join(s.data.userId, str(b?.roomId, 'roomId', 64), typeof b.password === 'string' ? b.password : undefined);
      await s.join(`room:${snap.room.roomId}`);
      return snap;
    });
  }

  @SubscribeMessage('room:sync')
  sync(@ConnectedSocket() s: AuthedSocket, @MessageBody() b: { roomId: string }) {
    return this.handle(s, async () => {
      const room = this.mp.getRoom(str(b?.roomId, 'roomId', 64));
      if (!room) throw new GameRuleError('Room not loaded', 'ROOM_NOT_FOUND');
      return this.mp.snapshot(room, s.data.userId);
    });
  }

  @SubscribeMessage('room:sit')
  sit(@ConnectedSocket() s: AuthedSocket, @MessageBody() b: { roomId: string; seat?: number; buyIn: number }) {
    return this.handle(s, () =>
      this.mp.sit(s.data.userId, str(b?.roomId, 'roomId', 64), typeof b.seat === 'number' ? b.seat : undefined, Number(b.buyIn)),
    );
  }

  @SubscribeMessage('room:leave')
  leave(@ConnectedSocket() s: AuthedSocket, @MessageBody() b: { roomId: string }) {
    return this.handle(s, async () => {
      const id = str(b?.roomId, 'roomId', 64);
      await s.leave(`room:${id}`);
      return this.mp.leave(s.data.userId, id);
    });
  }

  @SubscribeMessage('room:action')
  action(@ConnectedSocket() s: AuthedSocket, @MessageBody() b: { roomId: string; actionId: string; type: string; [k: string]: unknown }) {
    return this.handle(s, () => {
      const { roomId, ...rest } = b ?? ({} as typeof b);
      str(rest.actionId, 'actionId', 64);
      str(rest.type, 'type', 32);
      return this.mp.act(s.data.userId, str(roomId, 'roomId', 64), rest as never);
    });
  }

  @SubscribeMessage('room:rebuy')
  rebuy(@ConnectedSocket() s: AuthedSocket, @MessageBody() b: { roomId: string; amount: number; actionId: string }) {
    return this.handle(s, () =>
      this.mp.rebuy(s.data.userId, str(b?.roomId, 'roomId', 64), Number(b.amount), str(b.actionId, 'actionId', 64)),
    );
  }

  @SubscribeMessage('room:start')
  start(@ConnectedSocket() s: AuthedSocket, @MessageBody() b: { roomId: string }) {
    return this.handle(s, () => this.mp.resume(s.data.userId, str(b?.roomId, 'roomId', 64)));
  }

  @SubscribeMessage('room:kick')
  kick(@ConnectedSocket() s: AuthedSocket, @MessageBody() b: { roomId: string; userId: string }) {
    return this.handle(s, () => this.mp.kick(s.data.userId, str(b?.roomId, 'roomId', 64), str(b.userId, 'userId', 64)));
  }

  @SubscribeMessage('room:close')
  close(@ConnectedSocket() s: AuthedSocket, @MessageBody() b: { roomId: string }) {
    return this.handle(s, () => this.mp.close(s.data.userId, str(b?.roomId, 'roomId', 64)));
  }

  @SubscribeMessage('room:gift')
  gift(@ConnectedSocket() s: AuthedSocket, @MessageBody() b: { roomId: string; toUserId: string; giftCode: string; requestId?: string }) {
    return this.handle(s, async () => {
      const roomId = str(b?.roomId, 'roomId', 64);
      const room = this.mp.getRoom(roomId);
      if (!room || (!room.seatOf(s.data.userId) && !room.spectators.has(s.data.userId)))
        throw new GameRuleError('Join the room first', 'JOIN_FIRST');
      const res = await this.gifts.send(s.data.userId, str(b.toUserId, 'toUserId', 64), str(b.giftCode, 'giftCode', 32), {
        roomId,
        idempotencyKey: b.requestId,
      });
      this.realtime.toChannel(`room:${roomId}`, 'room:gift', res);
      return res;
    });
  }

  @SubscribeMessage('room:chat')
  roomChat(@ConnectedSocket() s: AuthedSocket, @MessageBody() b: { roomId: string; content: string; clientMsgId?: string }) {
    return this.handle(s, async () => {
      const room = this.mp.getRoom(str(b?.roomId, 'roomId', 64));
      if (!room?.chatRoomId || !room.seatOf(s.data.userId))
        throw new GameRuleError('Only seated players can chat at this table', 'NOT_SEATED');
      return this.chat.send(s.data.userId, room.chatRoomId, str(b.content, 'content', 1000), b.clientMsgId);
    });
  }

  // ── Chat ─────────────────────────────────────────────────────

  @SubscribeMessage('chat:send')
  chatSend(@ConnectedSocket() s: AuthedSocket, @MessageBody() b: { roomId: string; content: string; clientMsgId?: string }) {
    return this.handle(s, () =>
      this.chat.send(s.data.userId, str(b?.roomId, 'roomId', 64), str(b.content, 'content', 1000), b.clientMsgId),
    );
  }

  @SubscribeMessage('chat:read')
  chatRead(@ConnectedSocket() s: AuthedSocket, @MessageBody() b: { roomId: string }) {
    return this.handle(s, () => this.chat.markRead(s.data.userId, str(b?.roomId, 'roomId', 64)));
  }

  @SubscribeMessage('chat:typing')
  async typing(@ConnectedSocket() s: AuthedSocket, @MessageBody() b: { roomId: string }) {
    return this.handle(s, async () => {
      const roomId = str(b?.roomId, 'roomId', 64);
      const members = await this.prisma.chatMember.findMany({ where: { chatRoomId: roomId }, select: { userId: true } });
      if (!members.some((m) => m.userId === s.data.userId)) throw new GameRuleError('Not a member', 'CHAT_NOT_FOUND');
      this.realtime.toUsers(
        members.map((m) => m.userId).filter((id) => id !== s.data.userId),
        'chat:typing',
        { roomId, userId: s.data.userId },
      );
      return null;
    });
  }

  @SubscribeMessage('presence:friends')
  async onlineFriends(@ConnectedSocket() s: AuthedSocket) {
    return this.handle(s, async () => {
      const ids = await this.friends.friendIds(s.data.userId);
      return [...(await this.presence.onlineAmong(ids))];
    });
  }
}

import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';

/**
 * Thin facade over the Socket.IO server so REST services (friends, chat, notifications...)
 * can push real-time events without depending on gateway classes.
 * Every authenticated socket joins `user:<id>`.
 */
@Injectable()
export class RealtimeService {
  private server: Server | null = null;

  attach(server: Server) {
    this.server = server;
  }

  get io(): Server | null {
    return this.server;
  }

  toUser(userId: string, event: string, data: unknown) {
    this.server?.to(`user:${userId}`).emit(event, data);
  }

  toUsers(userIds: string[], event: string, data: unknown) {
    if (!userIds.length) return;
    this.server?.to(userIds.map((id) => `user:${id}`)).emit(event, data);
  }

  toChannel(channel: string, event: string, data: unknown) {
    this.server?.to(channel).emit(event, data);
  }
}

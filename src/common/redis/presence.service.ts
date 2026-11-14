import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config';

/**
 * Ephemeral online presence. Uses Redis when REDIS_URL is configured (multi-instance
 * deployments), otherwise an in-process map (single instance / development).
 * Presence is never used as a source of truth for anything persistent.
 */
@Injectable()
export class PresenceService implements OnModuleDestroy {
  private readonly log = new Logger(PresenceService.name);
  private readonly local = new Map<string, number>();
  readonly redis: Redis | null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.redis = config.redisUrl ? new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 }) : null;
    if (this.redis) this.redis.on('error', (e) => this.log.warn(`Redis error: ${e.message}`));
    else this.log.log('REDIS_URL not set - using in-memory presence (single instance only)');
  }

  async connected(userId: string): Promise<boolean> {
    if (this.redis) {
      const n = await this.redis.hincrby('presence:online', userId, 1);
      return n === 1;
    }
    const n = (this.local.get(userId) ?? 0) + 1;
    this.local.set(userId, n);
    return n === 1;
  }

  /** Returns true when the user's last connection closed. */
  async disconnected(userId: string): Promise<boolean> {
    if (this.redis) {
      const n = await this.redis.hincrby('presence:online', userId, -1);
      if (n <= 0) {
        await this.redis.hdel('presence:online', userId);
        return true;
      }
      return false;
    }
    const n = (this.local.get(userId) ?? 1) - 1;
    if (n <= 0) {
      this.local.delete(userId);
      return true;
    }
    this.local.set(userId, n);
    return false;
  }

  async isOnline(userId: string): Promise<boolean> {
    if (this.redis) return (await this.redis.hexists('presence:online', userId)) === 1;
    return this.local.has(userId);
  }

  async onlineAmong(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    if (this.redis) {
      const vals = await this.redis.hmget('presence:online', ...userIds);
      return new Set(userIds.filter((_, i) => vals[i] !== null));
    }
    return new Set(userIds.filter((id) => this.local.has(id)));
  }

  async onlineCount(): Promise<number> {
    if (this.redis) return this.redis.hlen('presence:online');
    return this.local.size;
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }
}

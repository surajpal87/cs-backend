import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import type { app as FirebaseApp } from 'firebase-admin';
import { APP_CONFIG, AppConfig } from '../common/config';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * Firebase Cloud Messaging. FCM_CREDENTIALS may be a path to a service-account JSON file
 * or the JSON itself. Without credentials push is disabled (in-app + socket notifications
 * still work) and a warning is logged once.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly log = new Logger(PushService.name);
  private app: FirebaseApp.App | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    const raw = this.config.fcmCredentials;
    if (!raw) {
      this.log.warn('FCM_CREDENTIALS not set - push notifications disabled');
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const admin = require('firebase-admin') as typeof import('firebase-admin');
      const json = raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8');
      this.app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(json)) }, 'cs-push');
      this.log.log('FCM push enabled');
    } catch (e) {
      this.log.error(`FCM init failed: ${(e as Error).message}`);
    }
  }

  get enabled() {
    return this.app !== null;
  }

  async sendToUser(userId: string, title: string, body: string, data: Record<string, string> = {}) {
    if (!this.app) return;
    const tokens = await this.prisma.deviceToken.findMany({ where: { userId }, select: { token: true } });
    if (!tokens.length) return;
    const res = await this.app.messaging().sendEachForMulticast({
      tokens: tokens.map((t) => t.token),
      notification: { title, body },
      data,
      android: { priority: 'high', notification: { channelId: 'cs_default', color: '#D8AE55' } },
    });
    // Prune tokens FCM reports as invalid.
    const dead = res.responses
      .map((r, i) =>
        !r.success && /registration-token-not-registered|invalid-argument/.test(r.error?.code ?? '') ? tokens[i].token : null,
      )
      .filter((t): t is string => !!t);
    if (dead.length) await this.prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
  }
}

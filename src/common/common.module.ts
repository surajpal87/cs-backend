import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RealtimeService } from '../realtime/realtime.service';
import { AuditService } from './audit/audit.service';
import { APP_CONFIG, AppConfig, loadConfig } from './config';
import { MailService } from './mail/mail.service';
import { PrismaService } from './prisma/prisma.service';
import { PresenceService } from './redis/presence.service';
import { SettingsService } from './settings.service';

const configProvider = { provide: APP_CONFIG, useFactory: () => loadConfig() };

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      useFactory: () => {
        const c: AppConfig = loadConfig();
        return {
          secret: c.jwtSecret,
          signOptions: { expiresIn: c.accessTokenTtlSec, issuer: 'cs-card-station', algorithm: 'HS256' },
          verifyOptions: { issuer: 'cs-card-station', algorithms: ['HS256'] },
        };
      },
    }),
  ],
  providers: [configProvider, PrismaService, PresenceService, AuditService, MailService, SettingsService, RealtimeService],
  exports: [APP_CONFIG, PrismaService, PresenceService, AuditService, MailService, SettingsService, RealtimeService, JwtModule],
})
export class CommonModule {}

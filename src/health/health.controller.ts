import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { Public } from '../common/guards/jwt-auth.guard';
import { PrismaService } from '../common/prisma/prisma.service';
import { PresenceService } from '../common/redis/presence.service';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok', uptime: process.uptime() };
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma, { timeout: 2000 }),
      async () => {
        if (!this.presence.redis) return { redis: { status: 'up', mode: 'in-memory' } };
        await this.presence.redis.ping();
        return { redis: { status: 'up', mode: 'redis' } };
      },
    ]);
  }
}

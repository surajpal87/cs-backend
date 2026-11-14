import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import * as argon2 from 'argon2';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length } from 'class-validator';
import { Request, Response } from 'express';
import { AuditService } from '../common/audit/audit.service';
import { APP_CONFIG, AppConfig } from '../common/config';
import { Public } from '../common/guards/jwt-auth.guard';
import { PrismaService } from '../common/prisma/prisma.service';
import { randomToken, sha256 } from '../common/utils/ids';
import { ADMIN_COOKIE, AdminContext, AdminGuard, AdminPublic, CurrentAdmin, PERMISSIONS } from './admin.guard';

class AdminLoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)) @IsEmail() email: string;
  @IsString() @Length(1, 128) password: string;
}

@ApiTags('admin')
@Public()
@UseGuards(AdminGuard)
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @AdminPublic()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: AdminLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const admin = await this.prisma.adminUser.findUnique({
      where: { email: dto.email },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
    const ok = admin ? await argon2.verify(admin.passwordHash, dto.password) : false;
    if (!admin || !ok || admin.status !== 'ACTIVE') {
      await this.audit.record({
        actorType: 'ADMIN',
        actorId: admin?.id ?? null,
        action: 'admin.login_failed',
        metadata: { email: dto.email },
        ip: req.ip,
      });
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    }
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const ttl = this.config.adminSessionTtlHours * 3600_000;
    await this.prisma.adminSession.create({
      data: {
        adminId: admin.id,
        tokenHash: sha256(token),
        csrfToken,
        ip: req.ip,
        userAgent: req.headers['user-agent']?.slice(0, 255),
        expiresAt: new Date(Date.now() + ttl),
      },
    });
    await this.prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({ actorType: 'ADMIN', actorId: admin.id, action: 'admin.login', ip: req.ip });
    res.cookie(ADMIN_COOKIE, token, {
      httpOnly: true,
      secure: this.config.isProd,
      sameSite: 'strict',
      path: '/api/v1/admin',
      maxAge: ttl,
    });
    const perms = admin.role.key === 'SUPER_ADMIN' ? [...PERMISSIONS] : admin.role.permissions.map((p) => p.permission.key);
    return {
      admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role.key, roleName: admin.role.name },
      permissions: perms,
      csrfToken,
    };
  }

  @Get('me')
  me(@CurrentAdmin() a: AdminContext) {
    const perms = a.roleKey === 'SUPER_ADMIN' ? [...PERMISSIONS] : [...a.permissions];
    return { admin: { id: a.id, email: a.email, name: a.name, role: a.roleKey }, permissions: perms, csrfToken: a.csrfToken };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentAdmin() a: AdminContext, @Res({ passthrough: true }) res: Response) {
    await this.prisma.adminSession.update({ where: { id: a.sessionId }, data: { revokedAt: new Date() } });
    res.clearCookie(ADMIN_COOKIE, { path: '/api/v1/admin' });
    await this.audit.record({ actorType: 'ADMIN', actorId: a.id, action: 'admin.logout' });
    return { ok: true };
  }
}

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PrismaService } from '../common/prisma/prisma.service';
import { safeEqual, sha256 } from '../common/utils/ids';

export const ADMIN_COOKIE = 'cs_admin_session';
export const PERMISSIONS_KEY = 'adminPermissions';
export const ADMIN_PUBLIC = 'adminPublic';

export const PERMISSIONS = [
  'dashboard.read',
  'users.read',
  'users.manage',
  'points.adjust',
  'games.manage',
  'rooms.read',
  'rooms.manage',
  'associations.read',
  'associations.manage',
  'chat.moderate',
  'reports.read',
  'reports.manage',
  'gifts.manage',
  'leaderboard.read',
  'banners.manage',
  'notifications.send',
  'support.read',
  'support.manage',
  'settings.manage',
  'admins.manage',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PRESETS: Record<string, { name: string; permissions: Permission[] | 'ALL' }> = {
  SUPER_ADMIN: { name: 'Super Admin', permissions: 'ALL' },
  ADMIN: { name: 'Admin', permissions: PERMISSIONS.filter((p) => p !== 'admins.manage') },
  MODERATOR: {
    name: 'Moderator',
    permissions: [
      'dashboard.read',
      'users.read',
      'users.manage',
      'rooms.read',
      'rooms.manage',
      'associations.read',
      'associations.manage',
      'chat.moderate',
      'reports.read',
      'reports.manage',
      'leaderboard.read',
    ],
  },
  SUPPORT: { name: 'Support Staff', permissions: ['dashboard.read', 'users.read', 'support.read', 'support.manage', 'reports.read'] },
};

/** Route requires ALL listed permissions. SUPER_ADMIN bypasses checks. */
export const RequirePermissions = (...p: Permission[]) => SetMetadata(PERMISSIONS_KEY, p);
export const AdminPublic = () => SetMetadata(ADMIN_PUBLIC, true);

export interface AdminContext {
  id: string;
  email: string;
  name: string;
  roleKey: string;
  permissions: Set<string>;
  sessionId: string;
  csrfToken: string;
}

export const CurrentAdmin = createParamDecorator((_d: unknown, ctx: ExecutionContext): AdminContext => {
  return ctx.switchToHttp().getRequest<Request & { admin: AdminContext }>().admin;
});

/**
 * Browser admin sessions: opaque token in an HttpOnly, SameSite=Strict cookie (hash stored
 * server-side) + CSRF double-submit token required on every state-changing request.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(ADMIN_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<Request & { admin?: AdminContext; cookies?: Record<string, string> }>();
    const token = req.cookies?.[ADMIN_COOKIE];
    if (!token) throw new UnauthorizedException({ code: 'ADMIN_UNAUTHENTICATED', message: 'Admin sign-in required' });
    const session = await this.prisma.adminSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { admin: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.admin.status !== 'ACTIVE') {
      throw new UnauthorizedException({ code: 'ADMIN_UNAUTHENTICATED', message: 'Admin session expired' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const header = String(req.headers['x-csrf-token'] ?? '');
      if (!header || !safeEqual(header, session.csrfToken)) throw new ForbiddenException({ code: 'CSRF', message: 'Invalid CSRF token' });
    }
    const admin: AdminContext = {
      id: session.admin.id,
      email: session.admin.email,
      name: session.admin.name,
      roleKey: session.admin.role.key,
      permissions: new Set(session.admin.role.permissions.map((p) => p.permission.key)),
      sessionId: session.id,
      csrfToken: session.csrfToken,
    };
    req.admin = admin;
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]) ?? [];
    if (admin.roleKey !== 'SUPER_ADMIN' && required.some((p) => !admin.permissions.has(p))) {
      throw new ForbiddenException({
        code: 'ADMIN_FORBIDDEN',
        message: `Missing permission: ${required.filter((p) => !admin.permissions.has(p)).join(', ')}`,
      });
    }
    return true;
  }
}

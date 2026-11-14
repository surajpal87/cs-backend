import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

export interface AuthUser {
  id: string;
  sessionId: string;
  username: string;
}

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  usr: string;
  typ: 'access';
}

export const IS_PUBLIC = 'isPublic';
/** Marks a route as not requiring a user access token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<Request & { user: AuthUser }>().user;
});

/**
 * Global guard for the player API: requires `Authorization: Bearer <access JWT>` unless the
 * route is @Public(). Admin routes use AdminGuard (cookie session) instead and are skipped.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    if (req.path.startsWith('/api/v1/admin')) return true; // AdminGuard handles these
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Sign in required' });
    req.user = await verifyAccessToken(this.jwt, this.prisma, token);
    return true;
  }
}

export async function verifyAccessToken(jwt: JwtService, prisma: PrismaService, token: string): Promise<AuthUser> {
  let payload: AccessTokenPayload;
  try {
    payload = await jwt.verifyAsync<AccessTokenPayload>(token);
  } catch {
    throw new UnauthorizedException({ code: 'TOKEN_INVALID', message: 'Session expired, please sign in again' });
  }
  if (payload.typ !== 'access') throw new UnauthorizedException({ code: 'TOKEN_INVALID', message: 'Invalid token' });
  const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, status: true, username: true } });
  if (!user || user.status === 'DELETED') throw new UnauthorizedException({ code: 'TOKEN_INVALID', message: 'Account not found' });
  if (user.status === 'BANNED' || user.status === 'SUSPENDED') {
    throw new ForbiddenException({ code: 'ACCOUNT_RESTRICTED', message: `Your account is ${user.status.toLowerCase()}` });
  }
  return { id: user.id, sessionId: payload.sid, username: user.username };
}

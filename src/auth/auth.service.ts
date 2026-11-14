import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OtpPurpose, User } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuditService } from '../common/audit/audit.service';
import { APP_CONFIG, AppConfig } from '../common/config';
import { AccessTokenPayload } from '../common/guards/jwt-auth.guard';
import { MailService } from '../common/mail/mail.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { SettingsService } from '../common/settings.service';
import { hmac, otpCode, publicId, randomToken, safeEqual, sha256 } from '../common/utils/ids';
import { PointsService } from '../points/points.service';
import { LoginDto, RegisterDto } from './auth.dto';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 5;
export const ARGON_OPTS: argon2.HashOptions & { raw?: false } = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly points: PointsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ── Registration ──────────────────────────────────────────────

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { username: { equals: dto.username } }] },
    });
    const passwordHash = await argon2.hash(dto.password, ARGON_OPTS);
    let user: User;
    if (existing) {
      // Allow re-registration only for an unverified account with the same email.
      if (existing.email !== dto.email || existing.status !== 'PENDING_VERIFICATION') {
        throw new ConflictException({
          code: 'ACCOUNT_EXISTS',
          message: existing.email === dto.email ? 'An account with this email already exists' : 'Username is taken',
        });
      }
      user = await this.prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash, username: dto.username, profile: { update: { displayName: dto.displayName ?? dto.username } } },
      });
    } else {
      user = await this.createUserWithUniqueId(dto, passwordHash);
    }
    await this.issueOtp(user.email, 'REGISTER', user.id);
    return { userId: user.id, email: user.email, otpRequired: true, devOtpDelivery: !this.mail.configured ? 'server-log' : undefined };
  }

  private async createUserWithUniqueId(dto: RegisterDto, passwordHash: string): Promise<User> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.prisma.user.create({
          data: {
            csId: publicId('CS'),
            email: dto.email,
            username: dto.username,
            passwordHash,
            profile: {
              create: { displayName: dto.displayName ?? dto.username, avatarPreset: `royal-${1 + Math.floor(Math.random() * 8)}`, preferences: {} },
            },
          },
        });
      } catch (e: unknown) {
        const err = e as { code?: string; meta?: { target?: string[] } };
        if (err.code === 'P2002' && String(err.meta?.target).includes('csId')) continue;
        throw e;
      }
    }
    throw new Error('Could not allocate a unique CS ID');
  }

  async verifyRegistration(email: string, code: string, meta: ClientMeta) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new BadRequestException({ code: 'OTP_INVALID', message: 'Invalid or expired code' });
    if (user.status !== 'PENDING_VERIFICATION')
      throw new BadRequestException({ code: 'ALREADY_VERIFIED', message: 'Account already verified; please sign in' });
    await this.consumeOtp(email, 'REGISTER', code);
    const bonus = await this.settings.get('points.signupBonus');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', emailVerified: true } });
      await this.points.apply(tx, {
        userId: user.id,
        amount: bonus,
        type: 'SIGNUP_BONUS',
        idempotencyKey: `signup:${user.id}`,
        note: 'Welcome bonus',
      });
    });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'auth.registered', ip: meta.ip });
    return this.createSession(user.id, meta);
  }

  // ── OTP ───────────────────────────────────────────────────────

  private otpHash(target: string, purpose: OtpPurpose, code: string) {
    return hmac(this.config.otpSecret, `${target}|${purpose}|${code}`);
  }

  async issueOtp(target: string, purpose: OtpPurpose, userId?: string) {
    const recent = await this.prisma.otpVerification.count({
      where: { target, purpose, createdAt: { gt: new Date(Date.now() - 3600_000) } },
    });
    if (recent >= OTP_MAX_PER_HOUR) {
      throw new HttpException(
        { code: 'OTP_RATE_LIMIT', message: 'Too many codes requested. Try again later.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const code = otpCode();
    await this.prisma.$transaction([
      // Only the newest code is valid.
      this.prisma.otpVerification.updateMany({ where: { target, purpose, consumedAt: null }, data: { consumedAt: new Date() } }),
      this.prisma.otpVerification.create({
        data: { target, purpose, userId, codeHash: this.otpHash(target, purpose, code), expiresAt: new Date(Date.now() + OTP_TTL_MS) },
      }),
    ]);
    await this.mail.sendOtp(target, code, purpose);
  }

  async resendOtp(email: string, purpose: OtpPurpose) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Do not reveal whether the account exists.
    if (!user) return { sent: true };
    if (purpose === 'REGISTER' && user.status !== 'PENDING_VERIFICATION') return { sent: true };
    await this.issueOtp(email, purpose, user.id);
    return { sent: true };
  }

  private async consumeOtp(target: string, purpose: OtpPurpose, code: string) {
    const otp = await this.prisma.otpVerification.findFirst({
      where: { target, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const invalid = new BadRequestException({ code: 'OTP_INVALID', message: 'Invalid or expired code' });
    if (!otp || otp.expiresAt < new Date() || otp.attempts >= OTP_MAX_ATTEMPTS) throw invalid;
    if (!safeEqual(otp.codeHash, this.otpHash(target, purpose, code))) {
      await this.prisma.otpVerification.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw invalid;
    }
    // Atomic consume: guards against double use under concurrency.
    const res = await this.prisma.otpVerification.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (res.count !== 1) throw invalid;
  }

  // ── Login / sessions ──────────────────────────────────────────

  async login(dto: LoginDto, meta: ClientMeta) {
    const id = dto.identifier.toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: id }, { username: { equals: dto.identifier } }] },
    });
    // Constant-ish work even when the user does not exist.
    const ok = user
      ? await argon2.verify(user.passwordHash, dto.password)
      : await argon2.verify(await dummyHash(), dto.password).then(() => false);
    if (!user || !ok || user.status === 'DELETED') {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Incorrect email/username or password' });
    }
    if (user.status === 'PENDING_VERIFICATION') {
      await this.issueOtp(user.email, 'REGISTER', user.id).catch(() => undefined);
      throw new ForbiddenException({
        code: 'VERIFICATION_REQUIRED',
        message: 'Please verify your email. We sent you a new code.',
        email: user.email,
      });
    }
    if (user.status === 'BANNED' || user.status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: 'ACCOUNT_RESTRICTED',
        message: `Your account is ${user.status.toLowerCase()}. Contact support.`,
      });
    }
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'auth.login', ip: meta.ip });
    return this.createSession(user.id, meta);
  }

  async createSession(userId: string, meta: ClientMeta) {
    const secret = randomToken(32);
    const session = await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash: sha256(secret),
        ip: meta.ip?.slice(0, 64),
        userAgent: meta.userAgent?.slice(0, 255),
        expiresAt: new Date(Date.now() + this.config.refreshTokenTtlDays * 86_400_000),
      },
    });
    return this.tokensFor(userId, session.id, secret);
  }

  private async tokensFor(userId: string, sessionId: string, secret: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { profile: true } });
    const payload: AccessTokenPayload = { sub: user.id, sid: sessionId, usr: user.username, typ: 'access' };
    return {
      accessToken: await this.jwt.signAsync(payload),
      refreshToken: `${sessionId}.${secret}`,
      expiresIn: this.config.accessTokenTtlSec,
      user: serializeMe(user),
    };
  }

  /** Refresh-token rotation: each refresh token is single use; reuse revokes the session. */
  async refresh(refreshToken: string) {
    const [sessionId, secret] = refreshToken.split('.');
    const invalid = new UnauthorizedException({ code: 'REFRESH_INVALID', message: 'Session expired, please sign in again' });
    if (!sessionId || !secret || !/^[0-9a-f-]{36}$/.test(sessionId)) throw invalid;
    const session = await this.prisma.session.findUnique({ where: { id: sessionId }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) throw invalid;
    if (!safeEqual(session.refreshTokenHash, sha256(secret))) {
      // Token reuse detected: kill the session.
      await this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
      throw invalid;
    }
    if (session.user.status !== 'ACTIVE') throw invalid;
    const next = randomToken(32);
    const rotated = await this.prisma.session.updateMany({
      where: { id: sessionId, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
      data: { refreshTokenHash: sha256(next), lastUsedAt: new Date() },
    });
    if (rotated.count !== 1) throw invalid;
    return this.tokensFor(session.userId, sessionId, next);
  }

  async logout(userId: string, sessionId: string, allDevices = false) {
    await this.prisma.session.updateMany({
      where: allDevices ? { userId, revokedAt: null } : { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  // ── Passwords ─────────────────────────────────────────────────

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user && user.status !== 'DELETED') await this.issueOtp(email, 'RESET_PASSWORD', user.id).catch(() => undefined);
    return { sent: true };
  }

  async resetPassword(email: string, code: string, newPassword: string, meta: ClientMeta) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new BadRequestException({ code: 'OTP_INVALID', message: 'Invalid or expired code' });
    await this.consumeOtp(email, 'RESET_PASSWORD', code);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await argon2.hash(newPassword, ARGON_OPTS) },
      }),
      this.prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'auth.password_reset', ip: meta.ip });
    return { ok: true };
  }

  async changePassword(userId: string, sessionId: string, current: string, next: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await argon2.verify(user.passwordHash, current))) {
      throw new BadRequestException({ code: 'INVALID_PASSWORD', message: 'Current password is incorrect' });
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await argon2.hash(next, ARGON_OPTS) } }),
      // Sign out every other device.
      this.prisma.session.updateMany({ where: { userId, revokedAt: null, NOT: { id: sessionId } }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.record({ actorType: 'USER', actorId: userId, action: 'auth.password_changed' });
    return { ok: true };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { profile: true } });
    return serializeMe(user);
  }
}

// Hash of a random string, used to equalise login timing for unknown accounts.
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= argon2.hash(randomToken(16), ARGON_OPTS));

export function serializeMe(user: User & { profile: import('@prisma/client').Profile | null }) {
  return {
    id: user.id,
    csId: user.csId,
    email: user.email,
    username: user.username,
    status: user.status,
    pointsBalance: user.pointsBalance,
    createdAt: user.createdAt,
    profile: user.profile && {
      displayName: user.profile.displayName,
      avatarUrl: user.profile.avatarUrl,
      avatarPreset: user.profile.avatarPreset,
      bio: user.profile.bio,
      country: user.profile.country,
      showOnlineStatus: user.profile.showOnlineStatus,
      allowFriendRequests: user.profile.allowFriendRequests,
      allowRoomInvites: user.profile.allowRoomInvites,
      tableTheme: user.profile.tableTheme,
      preferences: user.profile.preferences,
    },
  };
}

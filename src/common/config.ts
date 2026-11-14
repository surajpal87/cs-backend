/**
 * Centralised, validated configuration. The process refuses to boot with missing or weak
 * secrets so a misconfigured deployment fails fast instead of running insecurely.
 */
export interface AppConfig {
  nodeEnv: string;
  isProd: boolean;
  port: number;
  databaseUrl: string;
  redisUrl: string | null;
  jwtSecret: string;
  otpSecret: string;
  sessionSecret: string;
  appUrl: string;
  apiUrl: string;
  corsOrigins: string[];
  email: { host: string | null; port: number; user: string | null; password: string | null; from: string };
  fcmCredentials: string | null;
  storage: { endpoint: string | null; bucket: string | null; accessKey: string | null; secretKey: string | null };
  accessTokenTtlSec: number;
  refreshTokenTtlDays: number;
  adminSessionTtlHours: number;
}

function required(name: string, env: NodeJS.ProcessEnv, minLen = 1): string {
  const v = env[name];
  if (!v || v.length < minLen) throw new Error(`Environment variable ${name} is required${minLen > 1 ? ` (min length ${minLen})` : ''}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  return {
    nodeEnv,
    isProd: nodeEnv === 'production',
    port: Number(env.PORT ?? 3000),
    databaseUrl: required('DATABASE_URL', env),
    redisUrl: env.REDIS_URL || null,
    jwtSecret: required('JWT_SECRET', env, 32),
    otpSecret: required('OTP_SECRET', env, 32),
    sessionSecret: required('SESSION_SECRET', env, 32),
    appUrl: env.APP_URL ?? 'http://localhost:3001',
    apiUrl: env.API_URL ?? 'http://localhost:3000',
    corsOrigins: (env.CORS_ORIGINS ?? env.APP_URL ?? 'http://localhost:3001')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    email: {
      host: env.EMAIL_HOST || null,
      port: Number(env.EMAIL_PORT ?? 587),
      user: env.EMAIL_USER || null,
      password: env.EMAIL_PASSWORD || null,
      from: env.EMAIL_FROM ?? 'CS Card Station <no-reply@cardstation.local>',
    },
    fcmCredentials: env.FCM_CREDENTIALS || null,
    storage: {
      endpoint: env.STORAGE_ENDPOINT || null,
      bucket: env.STORAGE_BUCKET || null,
      accessKey: env.STORAGE_ACCESS_KEY || null,
      secretKey: env.STORAGE_SECRET_KEY || null,
    },
    accessTokenTtlSec: Number(env.ACCESS_TOKEN_TTL_SEC ?? 900),
    refreshTokenTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS ?? 30),
    adminSessionTtlHours: Number(env.ADMIN_SESSION_TTL_HOURS ?? 12),
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

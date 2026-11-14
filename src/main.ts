import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadConfig } from './common/config';

export async function createApp() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: config.isProd ? ['log', 'warn', 'error'] : ['log', 'warn', 'error', 'debug'],
  });
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: config.isProd ? undefined : false, crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cookieParser());
  app.use((req: { id?: string; headers: Record<string, unknown> }, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    req.id = (req.headers['x-request-id'] as string) || randomUUID();
    res.setHeader('x-request-id', req.id);
    next();
  });
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.enableShutdownHooks();

  if (!config.isProd || process.env.SWAGGER_ENABLED === 'true') {
    const doc = new DocumentBuilder()
      .setTitle('CS Card Station API')
      .setDescription('REST API v1. Real-time gameplay and chat use Socket.IO - see documentation/API_DOCUMENTATION.md.')
      .setVersion('1.0')
      .addBearerAuth()
      .addCookieAuth('cs_admin_session')
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));
  }
  return { app, config };
}

async function bootstrap() {
  const { app, config } = await createApp();
  await app.listen(config.port, '0.0.0.0');
  Logger.log(`CS Card Station API listening on :${config.port} (${config.nodeEnv})`, 'Bootstrap');
}

if (require.main === module) {
  bootstrap().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}

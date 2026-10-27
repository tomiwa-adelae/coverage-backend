import 'dotenv/config';
import cookieParser from 'cookie-parser';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ErrorFilter, validationException } from './common/errors';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Profile pictures (base64) and spreadsheet imports need more than the 100 KB default.
  app.useBodyParser('json', { limit: '2mb' });
  // Behind Render's load balancer and the Next.js proxy: read the client IP from X-Forwarded-For.
  app.set('trust proxy', true);

  // The Next.js app proxies /api/* here, so browsers never call this origin directly.
  // CORS stays open only to the listed frontend origins for local tooling.
  const allowedOrigins = (process.env.FRONTEND_URL ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: allowedOrigins, credentials: true });

  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      exceptionFactory: validationException,
    }),
  );
  app.useGlobalFilters(new ErrorFilter());

  await app.listen(process.env.PORT || 8000, '0.0.0.0');
}
void bootstrap();

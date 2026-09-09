import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import { AppModule } from './app.module';
import { ENV } from './config/env';

const API_PREFIX = 'api/v1';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // JSON body parsing with raw-bytes capture so Monnify webhook signatures
  // can be verified over the exact payload that was received.
  const captureRaw = (
    req: { rawBody?: Buffer },
    _res: unknown,
    buf: Buffer,
  ): void => {
    req.rawBody = buf;
  };
  app.use(
    json({ limit: '256kb', verify: captureRaw as never }) as never,
  );

  // Request ID: accept inbound x-request-id or mint one; echo on the response.
  app.use((req: { headers: Record<string, unknown>; id?: string }, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    const inbound = req.headers['x-request-id'];
    const requestId =
      typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 128
        ? inbound
        : randomUUID();
    req.id = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  });

  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({
    origin: ENV.corsOrigins,
    exposedHeaders: ['x-request-id', 'x-total-count'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Co-opEngine API')
    .setDescription(
      'Multi-tenant cooperative platform API — membership, savings, loans, share capital and double-entry ledger. All tenant data is isolated by PostgreSQL row-level security.',
    )
    .setVersion('0.1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Staff access token' },
      'staff-auth',
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Member access token' },
      'member-auth',
    )
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig, {
    operationIdFactory: (_controllerKey, methodKey) => methodKey,
  });
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Co-opEngine API listening on http://localhost:${port}/${API_PREFIX}`);
  // eslint-disable-next-line no-console
  console.log(`OpenAPI docs: http://localhost:${port}/docs`);
}

void bootstrap();

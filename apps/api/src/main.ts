import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './platform/api-exception.filter';
import { TransformInterceptor } from './platform/transform.interceptor';
import { ConfigResolverService } from './config/config-resolver.service';
import { applyDatabaseConfigFromStore } from './config/database-bootstrap';

async function bootstrap(): Promise<void> {
  await applyDatabaseConfigFromStore();
  const app = await NestFactory.create(AppModule, { cors: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  app.enableShutdownHooks();

  const resolver = app.get(ConfigResolverService);
  await resolver.ensureInitialized();

  const allowedOrigins = resolver.getStringArray('server.corsOrigins', [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]);
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  });

  const port = resolver.getNumber('server.port', 3000);
  const host = resolver.getString('server.listenHost', '127.0.0.1');
  await app.listen(port, host);
  console.log(`[competition-sj] api ready at http://${host}:${port}/api/v1`);
}

void bootstrap();
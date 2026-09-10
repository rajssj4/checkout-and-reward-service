import express, { type ErrorRequestHandler } from 'express';
import { fileURLToPath } from 'node:url';
import swaggerUi from 'swagger-ui-express';
import type { Knex } from 'knex';
import { ZodError } from 'zod';
import { DomainError } from './domain/errors.js';
import { cartService } from './services/carts.js';
import { cartRoutes } from './routes/carts.js';

export function createApp(dependencies?: { db: Knex; currency: string }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.get('/openapi.yaml', (_request, response) => {
    response.sendFile(
      fileURLToPath(new URL('../docs/openapi.yaml', import.meta.url)),
    );
  });
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(null, {
      customSiteTitle: 'Checkout and Rewards API',
      swaggerOptions: { url: '/openapi.yaml', validatorUrl: null },
    }),
  );
  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });
  if (dependencies)
    app.use(cartRoutes(cartService(dependencies.db, dependencies.currency)));
  app.use((_request, response) => {
    response.status(404).json({
      error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found.' },
    });
  });
  const handleError: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    if (error instanceof DomainError) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request.',
          details: {
            issues: error.issues.map(({ path, message }) => ({
              path,
              message,
            })),
          },
        },
      });
      return;
    }
    if (['55P03', '40P01', '40001'].includes(error.code)) {
      response
        .set('Retry-After', '1')
        .status(503)
        .json({
          error: {
            code: 'SERVICE_BUSY',
            message: 'Database is busy. Retry the request.',
          },
        });
      return;
    }
    if (error.type === 'entity.parse.failed') {
      response.status(400).json({
        error: {
          code: 'INVALID_JSON',
          message: 'Request body must be valid JSON.',
        },
      });
      return;
    }
    if (error.type === 'entity.too.large') {
      response.status(413).json({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body exceeds 32 KB.',
        },
      });
      return;
    }
    console.error(error);
    response.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' },
    });
  };
  app.use(handleError);
  return app;
}

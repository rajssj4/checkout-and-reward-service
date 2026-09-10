import express, { type ErrorRequestHandler } from 'express';
import { fileURLToPath } from 'node:url';
import swaggerUi from 'swagger-ui-express';

export function createApp() {
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

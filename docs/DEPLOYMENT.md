# Docker and Vercel deployment

## Files

| File                  | Purpose                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `Dockerfile`          | Production Node 24 image, compiled app, production dependencies, non-root user                    |
| `Dockerfile.vercel`   | Independently buildable Vercel container image; defaults to two database connections per instance |
| `compose.yaml`        | Local PostgreSQL, one-shot migration/seed service, and API                                        |
| `compose.vercel.yaml` | Local override to exercise the Vercel image against the same stack                                |
| `.dockerignore`       | Excludes secrets, Git metadata, local dependencies, and build outputs                             |

Both images use `node:24.21.0-alpine` and contain compiled migrations and Swagger files. Neither contains PostgreSQL or credentials. The Vercel image first runs `docker/start-vercel.sh` to initialize its database. Both ultimately run `node dist/server.js`, accept runtime environment variables, and handle SIGTERM. Their health check is API liveness, not a continuous database check.

## Run everything locally

Requires a running Docker engine and Docker Compose v2.

```sh
docker compose up --build -d --wait
curl http://localhost:3000/health
# Swagger: http://localhost:3000/docs
docker compose logs -f app
docker compose down
```

Compose starts PostgreSQL, waits for database health, runs migrations and repeatable seed, then starts the API. Existing inventory is not reset. `docker compose down` preserves the named database volume. Compose credentials are local development defaults; this file is not a public production database configuration.

Host PostgreSQL is exposed only at `127.0.0.1:5433`; containers connect to `postgres:5432`. Compose deliberately uses its internal database URL instead of the host `DATABASE_URL` in `.env`. Change `POSTGRES_PORT` if the host port is occupied, or `PORT` for the API's host port; update host-side database URLs to match. The container always listens on port 3000. `API_BIND_HOST` defaults to loopback.

If running Node directly, start only the database:

```sh
docker compose up -d --wait postgres
npm run db:migrate
npm run db:seed
npm run dev
```

After changing application code or migrations, run `docker compose up --build -d --wait` again. A failed migration prevents the API from starting. Inspect `docker compose logs db-init` for setup failures, including mismatched persisted reward settings.

## Build the images separately

```sh
docker build -t checkout-and-reward-service:local .
docker build -f Dockerfile.vercel -t checkout-and-reward-service:vercel .
```

Use the Vercel image locally with PostgreSQL:

```sh
docker compose -f compose.yaml -f compose.vercel.yaml up --build -d --wait
```

Do not run the two stacks on the same host ports simultaneously. Stop one before switching. The override shares the existing database volume when used with the same Compose project name.

For an external database, run the regular image with runtime configuration:

```sh
docker run --rm --env-file .env.production checkout-and-reward-service:local node dist/db/cli.js migrate
docker run --rm --env-file .env.production checkout-and-reward-service:local node dist/db/cli.js seed
docker run --rm --init --env-file .env.production -e PORT=3000 -p 3000:3000 checkout-and-reward-service:local
```

Create `.env.production` locally with `DATABASE_URL` and matching reward/currency settings. Do not commit it. Use your database provider's TLS connection string; certificate verification is not disabled by application code. Run migrations once as a release step using a direct connection with DDL permissions. Seed is optional outside assignment evaluation.

## Deploy the Vercel-specific image

Vercel documents OCI container deployments through a root-level `Dockerfile.vercel`, currently in beta. It builds the image and routes requests to its HTTP server. See [Vercel container images](https://vercel.com/docs/functions/container-images).

1. Provision external PostgreSQL accessible from Vercel; choose a region near the application. The Compose database and its local volume are not deployed to Vercel.
2. Use a direct PostgreSQL connection URL with schema creation permissions. The Vercel startup script automatically runs pending migrations and seeds the five evaluation products before starting the API. No local migration command is required.
3. Import this repository in Vercel. Set the project root to the directory containing `Dockerfile.vercel`. Use the Container deployment preset if prompted; no Express serverless adapter or custom rewrite configuration is required for this container path.
4. Set runtime environment variables for each intended environment:

   | Variable                | Value                                                                           |
   | ----------------------- | ------------------------------------------------------------------------------- |
   | `DATABASE_URL`          | External PostgreSQL URL, including provider-required TLS options                |
   | `PORT`                  | **3000**; set explicitly in Vercel so routing matches the non-root image        |
   | `DB_POOL_MAX`           | **2** initially; size against the database connection budget and instance count |
   | `REWARD_EVERY_N_ORDERS` | Same value persisted during migration, normally 5                               |
   | `DISCOUNT_BPS`          | Same value persisted during migration, normally 1000                            |
   | `CURRENCY`              | USD                                                                             |

5. Deploy through the Vercel dashboard or CLI. Verify `/health`, `/docs`, cart creation, checkout/replay, and the admin summary on the deployed URL.

Vercel's documented container port defaults to 80 unless `PORT` is configured. Its instances scale down and receive SIGTERM; durable state stays in PostgreSQL. Startup initialization is serialized with a PostgreSQL session advisory lock (60-second wait limit); use a direct connection, not a transaction pooler. Initialization failure prevents the API from starting. Applied migrations are skipped, and seeding preserves existing inventory. For production scale, move initialization to a separate release job. See the [port and lifecycle contract](https://vercel.com/docs/functions/container-images#port-resolution).

Use separate databases/branches for Preview and Production so evaluation orders cannot consume production stock or coupons. If using a transaction pooler, verify support for PostgreSQL transaction-scoped advisory locks and required session settings; use a direct connection for migrations. No in-process lock or local disk state is required for correctness.

This assignment has no authentication, including its administrative endpoints. Use Vercel Deployment Protection for a private evaluation deployment; application authorization remains deferred.

## Publishing

Docker image builds and these files do not publish images or deploy to Vercel automatically. A Vercel project and external database credentials are required for the live deployment. No real credentials belong in Dockerfile ARG/ENV instructions or build context.

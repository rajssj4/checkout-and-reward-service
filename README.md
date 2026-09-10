# Checkout and Reward Service

Node.js 24, TypeScript, Express, PostgreSQL, and Knex. Initial setup includes configuration validation, versioned migrations, five seed products, health API, Swagger UI, and focused setup tests. Product listing and cart APIs are implemented. Atomic checkout, immutable orders, single-use milestone coupons, and reconciled reporting are implemented.

## Setup

Use Node 24.21.0 (pinned in `.nvmrc`) and npm. Start PostgreSQL with Docker Compose or use an existing PostgreSQL 16+ server.

```sh
nvm use
npm ci
cp .env.example .env
docker compose up -d --wait
npm run db:migrate
npm run db:seed
npm run dev
```

Run commands inside `checkout-and-reward-service/`. The Compose service provides development database `checkout` and test database `checkout_test` on port 5433. Credentials in Compose are local development defaults. Data is stored in a named volume; `docker compose down` stops the database without deleting it. The test database initialization script runs only when that volume is first created.

For an existing PostgreSQL server, create separate development/test databases and set `DATABASE_URL` and `TEST_DATABASE_URL` in `.env`; skip the Docker command. Migration users need schema/table creation permissions. Docker is optional, but a running PostgreSQL server is required for startup and integration tests.

## API documentation

Open [Swagger UI](http://localhost:3000/docs) and use **Try it out** on `GET /health`. The [raw spec](http://localhost:3000/openapi.yaml) is served from [docs/openapi.yaml](docs/openapi.yaml). Requests use the current server origin, including custom ports; Swagger assets are served locally.

```sh
curl http://localhost:3000/health
# {"status":"ok"}
```

`GET /health` is liveness, not a continuous database readiness check. Startup verifies database settings before listening. Unknown routes return `404 ROUTE_NOT_FOUND`; invalid JSON returns `400 INVALID_JSON`; bodies over 32 KB return `413 PAYLOAD_TOO_LARGE`.

## Configuration

| Variable              | Default / rule                                                   |
| --------------------- | ---------------------------------------------------------------- |
| PORT                  | 3000; integer 1–65535                                            |
| DATABASE_URL          | postgresql://checkout:checkout@localhost:5433/checkout           |
| TEST_DATABASE_URL     | Set explicitly for integration tests; example uses checkout_test |
| REWARD_EVERY_N_ORDERS | 5; integer 1–2147483647                                          |
| DISCOUNT_BPS          | 1000 (10%); integer 0–10000                                      |
| CURRENCY              | USD only                                                         |

Reward settings are persisted at first initialization; subsequent startup/migration rejects mismatches. Seed reruns insert missing products without resetting inventory. Amounts are stored as PostgreSQL BIGINT minor units, which the driver returns as strings to preserve precision. Cart calculations use BigInt, then convert to safe JSON integers; out-of-range totals are rejected. Environment variables override `.env`.

## Verification and build

```sh
npm test                  # HTTP/configuration tests; no database required
npm run test:integration  # Real PostgreSQL; requires TEST_DATABASE_URL
npm run typecheck
npm run format:check
npm run build
npm start
```

Integration tests create a unique schema in the dedicated test database and remove only that schema afterward. They verify migration/seed repetition, settings drift, constraints, and transaction rollback. Run both test commands for complete setup verification.

`npm run test:watch` watches HTTP/configuration tests; `npm run format` applies formatting. TypeScript migrations compile with the app and are registered explicitly in `src/db/migrate.ts`; there is no separate SQL-copy step. The repository's `docs/` directory must remain alongside `dist/` for compiled Swagger serving.

## Structure

- `src/app.ts`: app factory, Swagger routes, and error handling.
- `src/server.ts`: startup, settings validation, pool shutdown.
- `src/db/`: Knex connection pool, migrations, seed, and CLI.
- `tests/`: HTTP/configuration and real PostgreSQL integration tests.
- [DECISIONS.md](DECISIONS.md): specific design choices and trade-offs.

Product and cart APIs are implemented. Coupon generation/redemption and read-only reporting are implemented.

## Products and carts

Run `npm run db:migrate` after updating the code to add cart and order tables. Open `/docs` to try the documented routes.

```sh
curl http://localhost:3000/products
curl -X POST http://localhost:3000/carts -H 'Content-Type: application/json' -d '{}'
# Substitute the returned cart ID below.
curl -X PUT http://localhost:3000/carts/CART_ID/items/coffee -H 'Content-Type: application/json' -d '{"quantity":2}'
curl http://localhost:3000/carts/CART_ID
curl -X DELETE http://localhost:3000/carts/CART_ID/items/coffee
```

PUT replaces quantity; it never increments it. Cart edits check current stock but do not reserve it. Views show current prices, line totals, gross totals, and per-item availability. Completed carts are readable but cannot be edited. Checkout rechecks prices and stock before creating an order.

Integration tests also cover cart CRUD, invalid input, price/stock changes, competing HTTP edits, completed-cart protection, and rollback when totals exceed safe JSON integer bounds.

## Checkout and orders

```sh
# Use a filled cart ID from the cart workflow; use a new key for each new checkout.
curl -X POST http://localhost:3000/carts/CART_ID/checkout -H 'Content-Type: application/json' -H 'Idempotency-Key: my-checkout-001' -d '{}'
# Repeat the exact request to replay the order without buying again.
curl -X POST http://localhost:3000/carts/CART_ID/checkout -H 'Content-Type: application/json' -H 'Idempotency-Key: my-checkout-001' -d '{}'
curl http://localhost:3000/orders/ORDER_ID
```

First success returns 201, replay returns 200 with the same order, and a different key for the completed cart returns 409 with its existing order ID. A key reused for another cart or changed coupon input returns 409 IDEMPOTENCY_KEY_REUSED. Keys are global, case-sensitive, 1–128 printable ASCII characters without spaces, and retained with successful orders. Failed attempts are not cached. Retry timeouts/503 with the same key.

Checkout locks its idempotency key, cart, optional coupon, and products (in product-ID order) inside a PostgreSQL transaction. It snapshots current product names/prices, decrements inventory with guarded updates, creates the order, and closes the cart. Commit is payment success. A commit failure rolls everything back. No external payment call is made. Orders retain exact purchase details and coupon code/rate snapshots after product changes. Invalid or previously redeemed coupon codes return distinct 409 errors.

`npm run test:integration` also exercises checkout across two independent connection pools: repeated/same-key requests, different-key conflicts, the last inventory unit, edit/checkout competition, changed prices, unsafe amounts, and a deferred database trigger that forces COMMIT to fail. The trigger exists only in an isolated test schema; the production service has no failure-injection endpoint.

## Rewards and reporting (administrative)

Every `REWARD_EVERY_N_ORDERS` globally successful orders unlocks one coupon milestone. Discounted orders count. An administrator explicitly generates one coupon for the oldest eligible milestone; checkout does not generate coupons automatically. Backlogged milestones remain available. A retry of generation can create the next eligible coupon, so generation is not idempotent across milestones.

```sh
# First place at least five successful orders with the default configuration.
curl -X POST http://localhost:3000/admin/coupons -H 'Content-Type: application/json' -d '{}'
curl http://localhost:3000/admin/coupons
# Create and fill another cart, then use the returned coupon code.
curl -X POST http://localhost:3000/carts/CART_ID/checkout -H 'Content-Type: application/json' -H 'Idempotency-Key: discounted-checkout-001' -d '{"couponCode":"COUPON_CODE"}'
curl http://localhost:3000/admin/reports/summary
```

All `/admin/*` operations are administrative; authentication/authorization is intentionally omitted. Coupons are case-sensitive bearer codes, trimmed at checkout, single-use, with no expiry or stacking. A coupon is consumed only when its order commits. Failed checkout leaves it available. The order that unlocks a milestone cannot use that milestone's not-yet-generated coupon.

Discounts use basis points and round half-up once on the whole order subtotal: `(grossMinor * discountBps + 5000) / 10000`, using integer division and BigInt intermediates. Discounts cannot exceed gross; 100% discounts yield zero net. Coupon status is derived from its unique order association.

The all-time report includes purchased quantities for every product, gross revenue, discounts, net revenue, coupon counts, and successful orders. It reads one consistent snapshot and never changes state. Gross minus discounts equals net; generated coupons equal available plus redeemed. Aggregate values outside safe JSON integer bounds return AMOUNT_OUT_OF_RANGE rather than losing precision.

Tests cover concurrent coupon generation/redemption, milestone backlogs, coupon preservation after stock/commit failures, 0%/100% discounts, rounding ties, and exact reporting after retries and failed requests.

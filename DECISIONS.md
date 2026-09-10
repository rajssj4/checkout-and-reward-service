# Decisions

## PostgreSQL with Knex

**Choice:** PostgreSQL with Knex for queries, schema migrations, and transactions. Knex is a query builder, not a full ORM.

**Why:** The user selected PostgreSQL and accepted Knex or Sequelize. Knex keeps transaction and locking behavior explicit with less model machinery than Sequelize.

**Trade-off:** A running PostgreSQL server is required. Checkout uses explicit row locks, guarded updates, and uniqueness constraints; PostgreSQL provides the shared coordination boundary.

## Fixed reward settings and repeatable seed

**Choice:** Persist reward interval, discount rate, and currency at initialization; reject configuration drift. Seed only missing products.

**Why:** Restarting or reseeding must not silently change reward rules or restore sold stock.

**Trade-off:** Changing reward settings requires a deliberate migration or fresh database.

## Separate app construction and database tests

**Choice:** Keep the HTTP app factory separate from server startup. Run database tests against real PostgreSQL in a unique temporary schema.

**Why:** HTTP tests remain independent of infrastructure; integration tests exercise actual PostgreSQL constraints and transactions.

**Trade-off:** Run both test commands for complete verification. The integration database user needs permission to create schemas.

## Cart prices, inventory, and competing edits

**Choice:** Carts show current prices and do not reserve stock. PUT sets an absolute quantity (1–1,000,000); zero requires DELETE. Edits lock the cart row and reject completed carts. Reads use a repeatable-read snapshot.

**Why:** Retries do not increment quantities, concurrent edits serialize per cart, and stale availability stays visible. Reservations and locked-in prices add lifecycle complexity.

**Trade-off:** Checkout must revalidate prices/stock and acquire the same cart lock. BigInt computes totals exactly; values outside safe JSON integer bounds are rejected, rolling back edits.

## Atomic checkout and durable retries

**Choice:** One PostgreSQL transaction locks the idempotency key, cart, optional coupon, then products in ID order; guarded stock updates, order snapshots, and cart closure commit together. Unique constraints enforce one order per cart/key. Commit is payment success.

**Why:** Unlike process-local locks, database locks coordinate multiple instances. Transaction-level advisory locks serialize requests even before a key has a persisted result ([PostgreSQL locking](https://www.postgresql.org/docs/17/explicit-locking.html)).

**Trade-off:** Keys are global and retained with successful orders. Matching retries return the original order; changed inputs conflict. Failures are not cached. Lock timeouts return 503 for retry with the same key. Real payments require a separate recoverable workflow.

## Purchase snapshots and money

**Choice:** Snapshot product names, current unit prices, quantities, and line/order totals. Use BigInt arithmetic and safe integer JSON amounts. Compute discounts with basis points and round half-up once on the gross subtotal using BigInt.

**Why:** Historical purchases must remain explainable after product edits. Floating-point currency arithmetic and reading live product prices for orders would violate this.

**Trade-off:** Snapshot data is duplicated intentionally. Amounts exceeding safe JSON integer bounds are rejected; 100% discounts produce zero net.

## Reward milestones and single-use coupons

**Choice:** Global successful-order milestones, explicit admin generation, one oldest eligible coupon per request. Lock the settings row to serialize generators; enforce unique milestone numbers. Coupons are append-only bearer codes without expiry or stacking. Redemption locks the coupon and stores its unique order association in the checkout transaction.

**Why:** Backlogs remain recoverable; competing requests cannot duplicate a milestone or consume the same coupon. Discounted orders count, and failed checkout never consumes a coupon.

**Trade-off:** Generation retries may create the next eligible coupon. Coupon deletion and changing reward rules are unsupported; supporting either requires revisiting milestone allocation.

## Reports from committed source records

**Choice:** Aggregate orders, order items, and coupons inside one read-only repeatable-read transaction. Sum order totals separately from item quantities; derive redemption counts from orders.

**Why:** Reports reconcile without duplicate revenue from joins or counters drifting after retries/failures.

**Trade-off:** All-time aggregation and unpaginated coupon listing are appropriate for this assignment; production scale may need projections reconciled to source records.

## Errors and client recovery

**Choice:** Stable error codes: 400 for invalid inputs/unsupported amounts, 404 for missing resources, 409 for business conflicts, 503 with Retry-After for lock/deadlock/serialization conflicts, and 500 for unexpected failures.

**Why:** Clients need to distinguish correcting input from retrying contention. Returning 200 for failures or treating every database error as retryable hides actionable differences.

**Trade-off:** Checkout retries reuse the same key. Unexpected failures are logged server-side; responses omit SQL and stack traces.

## Production evolution and scope

**Choice:** Multiple instances share PostgreSQL and use the same lock ordering and unique constraints. Keep authentication, real payments, refunds, taxes, shipping, reservations, expiry, pagination, and live cloud deployment outside this submission.

**Why:** These require separate lifecycle/security decisions beyond the checkout invariants. A distributed in-memory lock would add a second coordination system unnecessarily.

**Trade-off:** Production needs authenticated key scope, bounded idempotency retention, database backup/restore verification, pool sizing, and recoverable provider-idempotent payments. With two more hours, examine high-contention multi-process failure/retry behavior and recovery after connection loss first.

## AI assistance with independent verification

**Choice:** Use Codex to draft code, tests, and documentation, then verify against real PostgreSQL and the compiled server.

**Why:** Generated tests alone are insufficient: the initial named Knex import passed the test runner but failed in the real CLI. It was replaced with the runtime-compatible default import and verified through migrations and compiled startup. The user also redirected SQLite to PostgreSQL/Knex.

**Trade-off:** AI accelerated implementation but does not establish correctness or human review. No private transcripts are included; the candidate remains responsible for explaining and reviewing the submitted code.

## Container packaging and database lifecycle

**Choice:** Separate standard and Vercel Dockerfiles package the same compiled service as a non-root process. Compose runs migration/seed once before starting the API. Vercel uses external PostgreSQL and a separate migration release step, with a smaller configurable connection pool.

**Why:** Container builds need no database credentials, and autoscaled instances must not race to mutate schema or seed data at startup.

**Trade-off:** The Vercel container path is beta and requires project PORT=3000 plus an external database. Image definitions duplicate a small build recipe so each remains independently deployable.

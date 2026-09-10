# Decisions

## PostgreSQL with Knex

**Choice:** PostgreSQL with Knex for queries, schema migrations, and transactions. Knex is a query builder, not a full ORM.

**Why:** The user selected PostgreSQL and accepted Knex or Sequelize. Knex keeps transaction and locking behavior explicit with less model machinery than Sequelize.

**Trade-off:** A running PostgreSQL server is required. Checkout still needs explicit row locking/guarded updates and uniqueness constraints; changing databases alone does not implement those guarantees.

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

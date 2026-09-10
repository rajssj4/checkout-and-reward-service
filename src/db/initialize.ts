import pg from 'pg';
import { readConfig } from '../config.js';
import { openDatabase } from './connection.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

const config = readConfig();
// A dedicated session holds the lock across Knex migration and seed transactions.
// Use a direct PostgreSQL URL: transaction poolers cannot preserve session locks.
const lock = new pg.Client({
  connectionString: config.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
const db = openDatabase(config.DATABASE_URL, 'public', config.DB_POOL_MAX);
try {
  await lock.connect();
  await lock.query("SET lock_timeout = '60s'");
  await lock.query('SELECT pg_advisory_lock(724193, 1)');
  console.info('Initializing database: migrations and seed.');
  await migrate(db, config);
  await seed(db);
  console.info('Database initialization completed.');
} finally {
  // Closing this session releases its advisory lock, including after failures.
  await Promise.all([db.destroy(), lock.end()]);
}

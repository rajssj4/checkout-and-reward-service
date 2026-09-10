import { createApp } from './app.js';
import { readConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { assertSettings } from './db/migrate.js';

const config = readConfig();
const db = openDatabase(config.DATABASE_URL);
try {
  await assertSettings(db, config);
} catch (error) {
  await db.destroy();
  throw error;
}
const server = createApp({ db, currency: config.CURRENCY }).listen(
  config.PORT,
  () => {
    console.info(`Checkout service listening on port ${config.PORT}`);
  },
);
server.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
  void db.destroy();
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => server.closeAllConnections(), 5000);
  timeout.unref();
  server.close(() => {
    clearTimeout(timeout);
    void db.destroy().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

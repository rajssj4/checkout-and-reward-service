import { readConfig } from '../config.js';
import { openDatabase } from './connection.js';
import { migrate, assertSettings } from './migrate.js';
import { seed } from './seed.js';

const command = process.argv[2];
if (command !== 'migrate' && command !== 'seed')
  throw new Error('Expected migrate or seed command.');
const config = readConfig();
const db = openDatabase(config.DATABASE_URL, 'public', config.DB_POOL_MAX);
try {
  if (command === 'migrate') await migrate(db, config);
  else {
    await assertSettings(db, config);
    await seed(db);
  }
  console.info(`Database ${command} completed.`);
} finally {
  await db.destroy();
}

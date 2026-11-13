// Run with the bot stopped: bun --env-file=<env> scripts/migrate.ts
import { openDatabase, migrate } from '@guard/database';

const path = process.env.DATABASE_PATH;
if (!path) throw new Error('DATABASE_PATH is required');
const db = openDatabase(path);
const ran = migrate(db, Date.now());
db.close();
console.log(ran.length ? `applied migrations: ${ran.join(', ')}` : 'schema already current');

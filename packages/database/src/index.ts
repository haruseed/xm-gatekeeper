export { isDatabaseError } from './errors';
export type { MessageCleanupRepository } from './message-cleanup-repository';
export type { ActionTokens, ActionPayload } from './action-tokens';
export type { CapRepository, CapRequest, CapSession } from './cap-repository';
export type { EnqueueWork, InboxRepository, OutboxRepository } from './queue-repositories';
export type { UsernameDirectory, PhotoCacheRepository } from './repositories';
import { Database } from 'bun:sqlite';

export * from './migrations';
export * from './store';

export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 1000;
    PRAGMA synchronous = FULL;
    PRAGMA cache_size = -32768;
    PRAGMA wal_autocheckpoint = 1000;
  `);
  return db;
}

/**
 * Single-instance guard: an exclusive SQLite lock on a side file, held for the process
 * lifetime and released by the operating system if the process dies.
 */
export function acquireInstanceLock(databasePath: string): Database {
  const lock = new Database(`${databasePath}.lock`, { create: true });
  try {
    lock.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
  } catch {
    lock.close();
    throw new Error('another ingress-guard process holds the instance lock');
  }
  return lock;
}

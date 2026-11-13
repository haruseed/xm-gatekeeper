import { SQLiteError } from 'bun:sqlite';

/** Identify driver failures by type, never by matching arbitrary error messages. */
export function isDatabaseError(error: unknown): error is SQLiteError {
  return error instanceof SQLiteError;
}

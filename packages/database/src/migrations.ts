import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE groups (
  chat_id INTEGER PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  mode TEXT NOT NULL DEFAULT 'join_request',
  settings_json TEXT NOT NULL,
  settings_version INTEGER NOT NULL DEFAULT 1,
  raid_mode INTEGER NOT NULL DEFAULT 0 CHECK(raid_mode IN (0,1)),
  invite_link TEXT,
  paused_reason TEXT,
  owner_checked_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE group_admins (
  chat_id INTEGER NOT NULL REFERENCES groups(chat_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('reviewer','manager')),
  granted_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(chat_id,user_id)
);
CREATE TABLE known_chats (
  chat_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  bot_status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE user_preferences (
  user_id INTEGER PRIMARY KEY,
  locale TEXT CHECK(locale IS NULL OR locale IN ('zh-HK','zh-TW','zh-CN','en')),
  explicit_dm_chat_id INTEGER,
  admin_chat_id INTEGER,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE join_requests (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES groups(chat_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  contact_chat_id INTEGER NOT NULL,
  request_date INTEGER NOT NULL,
  source_update_id INTEGER NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','challenging','manual_review','approval_pending',
    'approved','decline_pending','declined','expired','superseded','external_resolution')),
  reason_code TEXT,
  deadline_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(chat_id,user_id,generation)
);
CREATE UNIQUE INDEX one_live_request ON join_requests(chat_id,user_id)
  WHERE state IN ('pending','challenging','manual_review','approval_pending');
CREATE INDEX request_deadlines ON join_requests(state,deadline_at);
CREATE INDEX request_user ON join_requests(user_id,state);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES join_requests(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  locale TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preparing','active','passed','failed','expired','cancelled')),
  round_no INTEGER NOT NULL DEFAULT 1,
  round_version INTEGER NOT NULL DEFAULT 1,
  answer_position INTEGER,
  board_hash TEXT,
  question_json TEXT,
  used_items_json TEXT NOT NULL DEFAULT '[]',
  message_id INTEGER,
  policy_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(request_id,attempt_no)
);
CREATE UNIQUE INDEX one_live_session ON sessions(request_id)
  WHERE state IN ('preparing','active');
CREATE INDEX session_expiry ON sessions(state,expires_at);
CREATE TABLE callback_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round_version INTEGER NOT NULL,
  action TEXT NOT NULL,
  choice INTEGER,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX callback_session ON callback_tokens(session_id);
CREATE TABLE resume_tokens (
  token_hash TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES join_requests(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE TABLE action_tokens (
  token_hash TEXT PRIMARY KEY,
  actor_user_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX action_expiry ON action_tokens(expires_at);
CREATE TABLE limits (
  scope TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  tokens REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(scope,bucket_key)
);
CREATE TABLE attempts (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  session_id TEXT NOT NULL UNIQUE
);
CREATE INDEX attempts_window ON attempts(chat_id,user_id,started_at);
CREATE INDEX attempts_user ON attempts(user_id,started_at);
CREATE TABLE file_cache (
  bot_id INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  media_kind TEXT NOT NULL,
  file_id TEXT NOT NULL,
  file_unique_id TEXT,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY(bot_id,content_hash,media_kind)
);
CREATE TABLE inbox (
  update_id INTEGER PRIMARY KEY,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX inbox_ready ON inbox(status,available_at);
CREATE TABLE runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  request_id TEXT REFERENCES join_requests(id) ON DELETE CASCADE,
  request_revision INTEGER,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX outbox_ready ON outbox(state,next_attempt_at);
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER,
  actor_user_id INTEGER,
  subject_user_id INTEGER,
  action TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_retention ON audit_events(created_at);
CREATE INDEX audit_chat ON audit_events(chat_id,id);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE join_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'request' CHECK(kind IN ('request','member'));
ALTER TABLE join_requests ADD COLUMN prompt_message_id INTEGER;
UPDATE groups SET settings_json = json_set(settings_json, '$.quarantine', json('true'));
`,
  },
  {
    version: 3,
    sql: `
CREATE TABLE cap_sessions (
 request_id TEXT PRIMARY KEY REFERENCES join_requests(id) ON DELETE CASCADE,
 ticket_hash TEXT UNIQUE NOT NULL,
 expires_at INTEGER NOT NULL,
 challenge_count INTEGER NOT NULL DEFAULT 0,
 last_challenge_at INTEGER NOT NULL DEFAULT 0,
 passed_at INTEGER
);
CREATE TABLE cap_nonces (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
`,
  },
  { version: 4, sql: `
CREATE TABLE cap_messages (
 request_id TEXT NOT NULL REFERENCES join_requests(id) ON DELETE CASCADE,
 chat_id INTEGER NOT NULL,
 message_id INTEGER NOT NULL,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(chat_id,message_id)
);
` },
];

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/** Applies pending migrations. Never downgrades; refuses a database whose history differs. */
export function migrate(db: Database, now: number): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied = db.query('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as {
    version: number;
    checksum: string;
  }[];
  const known = new Map(MIGRATIONS.map((m) => [m.version, m]));
  for (const row of applied) {
    const m = known.get(row.version);
    if (!m) throw new Error(`database schema version ${row.version} is newer than this release`);
    if (checksum(m.sql) !== row.checksum) throw new Error(`migration ${row.version} checksum mismatch`);
  }
  const done = new Set(applied.map((r) => r.version));
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.query('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?,?,?)').run(
        m.version,
        checksum(m.sql),
        now,
      );
    }).immediate();
    ran.push(m.version);
  }
  return ran;
}

export function schemaIsCurrent(db: Database): boolean {
  try {
    const row = db.query('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
    return row.v === MIGRATIONS[MIGRATIONS.length - 1]!.version;
  } catch {
    return false;
  }
}

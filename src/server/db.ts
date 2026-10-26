import "server-only";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "@/server/env";

const filename = env.DATABASE_PATH ?? join(process.cwd(), "data", "slatemail.sqlite");
mkdirSync(dirname(filename), { recursive: true });

const database = new Database(filename);
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.pragma("busy_timeout = 5000");
database.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    sub TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    encrypted_credentials TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY,
    account_sub TEXT NOT NULL REFERENCES accounts(sub) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS sync_state (
    account_sub TEXT PRIMARY KEY REFERENCES accounts(sub) ON DELETE CASCADE,
    history_id TEXT,
    last_synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS ai_credentials (
    account_sub TEXT NOT NULL REFERENCES accounts(sub) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    model TEXT NOT NULL,
    endpoint TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_sub, provider)
  );
  CREATE TABLE IF NOT EXISTS draft_sync (
    account_sub TEXT NOT NULL REFERENCES accounts(sub) ON DELETE CASCADE,
    local_draft_id TEXT NOT NULL,
    gmail_draft_id TEXT,
    remote_version TEXT,
    status TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_sub, local_draft_id)
  );
  CREATE TABLE IF NOT EXISTS send_attempts (
    account_sub TEXT NOT NULL REFERENCES accounts(sub) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    status TEXT NOT NULL,
    gmail_message_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_sub, attempt_id)
  );
`);

export default database;

/** Local schema version 1: the DDL of protocol §12.2 (column comments live in db/types.ts). */
export const SCHEMA_V1 = `
CREATE TABLE conversations (
  peer_user_id         TEXT PRIMARY KEY,
  peer_username        TEXT NOT NULL,
  peer_avatar_url      TEXT,
  last_activity_at     INTEGER NOT NULL,
  unread_count         INTEGER NOT NULL DEFAULT 0,
  profile_refreshed_at INTEGER
);
CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  peer_user_id   TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('in','out','system')),
  sender_user_id TEXT,
  body           TEXT NOT NULL,
  sent_at        INTEGER NOT NULL,
  server_ts      INTEGER,
  sort_ts        INTEGER NOT NULL,
  received_at    INTEGER,
  status         TEXT NOT NULL
);
CREATE INDEX messages_by_conversation ON messages(peer_user_id, sort_ts, id);
CREATE TABLE outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('message','receipt')),
  message_id      TEXT,
  payload         TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE TABLE receipt_hints (
  message_id TEXT PRIMARY KEY, status TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE contact_identities (
  user_id              TEXT PRIMARY KEY,
  identity_key         TEXT NOT NULL,
  first_seen_at        INTEGER NOT NULL,
  verified             INTEGER NOT NULL DEFAULT 0,
  pending_identity_key TEXT
);
CREATE TABLE history_transfers (
  transfer_id      TEXT PRIMARY KEY,
  transfer_key     TEXT,
  created_at       INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  sender_device_id TEXT,
  attempt_id       TEXT,
  total            INTEGER,
  received_seqs    TEXT NOT NULL DEFAULT '[]',
  completed_at     INTEGER
);
`;

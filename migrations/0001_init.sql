-- Family Address Book: initial schema.
-- Timestamps are UTC ISO-8601 text (e.g. 2026-01-31T10:00:00Z), except
-- login_attempts.attempted_at which is Unix epoch seconds.

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  email                TEXT    NOT NULL,              -- stored lower-cased
  name                 TEXT    NOT NULL,
  password_hash        TEXT    NOT NULL,              -- hex PBKDF2-SHA256
  password_salt        TEXT    NOT NULL,              -- hex, 16 bytes
  role                 TEXT    NOT NULL CHECK (role IN ('owner', 'member')),
  disabled             INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  created_by           INTEGER REFERENCES users (id),
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX idx_users_email ON users (email);
-- There is exactly one owner.
CREATE UNIQUE INDEX idx_users_single_owner ON users (role) WHERE role = 'owner';

CREATE TABLE addresses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name    TEXT    NOT NULL,
  surname       TEXT,
  address_line1 TEXT    NOT NULL,
  address_line2 TEXT,
  landmark      TEXT,
  city          TEXT    NOT NULL,
  state         TEXT    NOT NULL,
  pin           TEXT    NOT NULL,                     -- exactly 6 digits
  phone         TEXT    NOT NULL,                     -- 10 digits, normalised
  email         TEXT,
  group_name    TEXT,
  notes         TEXT,
  created_by    INTEGER NOT NULL REFERENCES users (id),
  updated_by    INTEGER REFERENCES users (id),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at    TEXT                                   -- soft delete
);

CREATE INDEX idx_addresses_phone ON addresses (phone);
CREATE INDEX idx_addresses_deleted_at ON addresses (deleted_at);

-- One row per FAILED login attempt, keyed by lower-cased email (whether or
-- not the account exists).
CREATE TABLE login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT    NOT NULL,
  attempted_at INTEGER NOT NULL                        -- Unix epoch seconds
);

CREATE INDEX idx_login_attempts_email_time ON login_attempts (email, attempted_at);

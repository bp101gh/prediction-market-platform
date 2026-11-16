-- =====================================================================
-- 预测市场平台 D1 数据库 Schema
-- 适配 Cloudflare Worker + D1 + Pages 架构
-- =====================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  balance       REAL    NOT NULL DEFAULT 10000,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS contracts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  description       TEXT    NOT NULL DEFAULT '',
  max_price         REAL    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'active',
  end_result        TEXT,
  settlement_result TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  ended_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id     INTEGER NOT NULL REFERENCES contracts(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  side            TEXT    NOT NULL CHECK (side IN ('buy','sell')),
  price           REAL    NOT NULL,
  amount          INTEGER NOT NULL,
  original_amount INTEGER NOT NULL,
  is_close        INTEGER NOT NULL DEFAULT 0,
  target_asset    TEXT    NOT NULL CHECK (target_asset IN ('yes','no')),
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','partial','filled','canceled')),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_book ON orders(contract_id, side, price, status);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, id);

CREATE TABLE IF NOT EXISTS trades (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id        INTEGER NOT NULL REFERENCES contracts(id),
  buyer_id           INTEGER NOT NULL REFERENCES users(id),
  seller_id          INTEGER NOT NULL REFERENCES users(id),
  buy_order_id       INTEGER NOT NULL,
  sell_order_id      INTEGER NOT NULL,
  buy_order_asset    TEXT    NOT NULL,
  buy_order_is_close INTEGER NOT NULL DEFAULT 0,
  sell_order_asset   TEXT    NOT NULL,
  sell_order_is_close INTEGER NOT NULL DEFAULT 0,
  price              REAL    NOT NULL,
  amount             INTEGER NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trades_contract ON trades(contract_id, id);

CREATE TABLE IF NOT EXISTS positions (
  contract_id  INTEGER NOT NULL REFERENCES contracts(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  long_amount  INTEGER NOT NULL DEFAULT 0,
  short_amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (contract_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);

CREATE TABLE IF NOT EXISTS balance_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  delta           REAL    NOT NULL,
  balance_after   REAL    NOT NULL,
  reason          TEXT    NOT NULL,
  reference_type  TEXT    NOT NULL,
  reference_id    TEXT,
  idempotency_key TEXT    UNIQUE,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON balance_ledger(user_id, id);

CREATE TABLE IF NOT EXISTS admin_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id  INTEGER NOT NULL REFERENCES users(id),
  action         TEXT    NOT NULL,
  target_user_id INTEGER,
  amount         REAL,
  balance_before REAL,
  balance_after  REAL,
  reason         TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS login_throttle (
  username    TEXT    PRIMARY KEY,
  fail_count  INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

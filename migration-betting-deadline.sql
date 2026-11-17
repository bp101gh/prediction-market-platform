-- Run once against the existing D1 database before deploying deadline-worker.js.
ALTER TABLE contracts ADD COLUMN betting_closes_at TEXT;

CREATE TRIGGER IF NOT EXISTS trg_block_orders_after_betting_deadline
BEFORE INSERT ON orders
WHEN EXISTS (
  SELECT 1 FROM contracts c
  WHERE c.id = NEW.contract_id
    AND c.status = 'active'
    AND c.betting_closes_at IS NOT NULL
    AND julianday(c.betting_closes_at) <= julianday('now')
)
BEGIN
  SELECT RAISE(ABORT, 'betting closed');
END;

CREATE TRIGGER IF NOT EXISTS trg_block_trades_after_betting_deadline
BEFORE INSERT ON trades
WHEN EXISTS (
  SELECT 1 FROM contracts c
  WHERE c.id = NEW.contract_id
    AND c.status = 'active'
    AND c.betting_closes_at IS NOT NULL
    AND julianday(c.betting_closes_at) <= julianday('now')
)
BEGIN
  SELECT RAISE(ABORT, 'betting closed');
END;

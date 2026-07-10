-- Admin reservation management, public quota/expiry, and audit log.
-- Safe and idempotent for an existing installation after migration 002.

BEGIN;

ALTER TABLE inbox_reservations
  ADD COLUMN IF NOT EXISTS created_by VARCHAR(16) NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS created_by_admin_id INTEGER,
  ADD COLUMN IF NOT EXISTS created_by_ip_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS inbox_reservation_audit (
  id BIGSERIAL PRIMARY KEY,
  reservation_id INTEGER REFERENCES inbox_reservations(id) ON DELETE SET NULL,
  address VARCHAR(512) NOT NULL,
  action VARCHAR(64) NOT NULL,
  actor_type VARCHAR(16) NOT NULL,
  actor_admin_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbox_reservations_ip
  ON inbox_reservations(created_by_ip_hash)
  WHERE created_by = 'public';

CREATE INDEX IF NOT EXISTS idx_inbox_reservations_expires
  ON inbox_reservations(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inbox_reservation_audit_created
  ON inbox_reservation_audit(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbox_reservation_audit_address
  ON inbox_reservation_audit(address);

COMMIT;

SELECT 'Migration 003_reservation_management applied successfully!' AS message;

-- Protected inboxes + verified domain onboarding.
-- Safe to run on an existing installation. It preserves current domains by
-- marking them active, because they were already configured before this flow.

BEGIN;

ALTER TABLE domains
  ADD COLUMN IF NOT EXISTS verification_status VARCHAR(32) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS verification_token VARCHAR(128),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_verification_check_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS sync_error TEXT;

UPDATE domains
SET verification_status = 'active',
    verified_at = COALESCE(verified_at, NOW())
WHERE verification_status IS NULL OR verification_status = '';

CREATE TABLE IF NOT EXISTS inbox_reservations (
  id SERIAL PRIMARY KEY,
  local_part VARCHAR(255) NOT NULL,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  password_hash VARCHAR(255) NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(local_part, domain_id)
);

CREATE INDEX IF NOT EXISTS idx_domains_verification_status
  ON domains(verification_status);

CREATE INDEX IF NOT EXISTS idx_inbox_reservations_address
  ON inbox_reservations(local_part, domain_id)
  WHERE is_active = true;

-- Existing deployments receive the default "active" status above. Mark those
-- pre-existing active domains as previously trusted so disable/re-enable keeps
-- working without granting the same shortcut to a newly pending domain.
UPDATE domains
SET verified_at = COALESCE(verified_at, NOW())
WHERE verification_status = 'active' AND is_active = true;

COMMIT;

SELECT 'Migration 002_protected_inboxes_and_domain_verification applied successfully!' AS message;

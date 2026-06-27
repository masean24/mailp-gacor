-- Migration: high-concurrency readiness
-- Safe to run on an existing database. Does NOT drop tables or data.
-- Idempotent: re-running is harmless.
--
-- What it does:
--   1. Adds emails.otp_code (nullable) so OTP is extracted once at ingest
--      and read endpoints don't re-parse bodies on every request.
--   2. Adds indexes to speed up inbox listing and OTP polling.
--
-- Apply with:
--   psql -U hubify -d hubify_mail -f sql/migrations/001_high_concurrency.sql

BEGIN;

-- 1. otp_code column (nullable). Existing rows stay NULL and fall back to
--    live body parsing in the API until they expire / are cleaned up.
ALTER TABLE emails
  ADD COLUMN IF NOT EXISTS otp_code VARCHAR(16);

-- 2a. Composite index for the common inbox listing query
--     (WHERE inbox_id = $1 ORDER BY received_at DESC LIMIT n).
CREATE INDEX IF NOT EXISTS idx_emails_inbox_received
  ON emails (inbox_id, received_at DESC);

-- 2b. Partial index for the lightweight OTP polling endpoint
--     (WHERE inbox_id = $1 AND otp_code IS NOT NULL ORDER BY received_at DESC).
--     Partial keeps it small since most rows may have no OTP.
CREATE INDEX IF NOT EXISTS idx_emails_inbox_otp
  ON emails (inbox_id, received_at DESC)
  WHERE otp_code IS NOT NULL;

COMMIT;

SELECT 'Migration 001_high_concurrency applied successfully!' AS message;

-- Keep existing protected inbox content alive for the lifetime of its
-- reservation. Safe and idempotent after migration 002/003.

BEGIN;

UPDATE inboxes i
SET expires_at = r.expires_at
FROM inbox_reservations r
WHERE r.local_part = i.local_part
  AND r.domain_id = i.domain_id
  AND (r.expires_at IS NULL OR r.expires_at > NOW())
  AND i.expires_at IS DISTINCT FROM r.expires_at;

COMMIT;

SELECT 'Migration 004_protected_inbox_lifetime applied successfully!' AS message;

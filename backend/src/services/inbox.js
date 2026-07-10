import db from '../config/database.js';

// Default number of emails returned in list/polling responses.
// Keeps inbox responses bounded; full content is available via getEmailById.
const DEFAULT_INBOX_LIMIT = parseInt(process.env.INBOX_LIST_LIMIT, 10) || 20;
// Hard cap so an explicit caller-provided limit can't request unbounded rows.
const MAX_INBOX_LIMIT = 100;

/**
 * Generate random string for email local part
 */
export const generateRandomLocalPart = (length = 8) => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

/**
 * Get or create inbox
 */
export const getOrCreateInbox = async (localPart, domainId) => {
    // Check if inbox exists and not expired
    let result = await db.query(
        `SELECT i.*, d.domain 
     FROM inboxes i 
     JOIN domains d ON i.domain_id = d.id 
     WHERE i.local_part = $1 AND i.domain_id = $2
       AND (
         i.expires_at IS NULL OR i.expires_at > NOW()
         OR EXISTS (
           SELECT 1 FROM inbox_reservations r
           WHERE r.local_part = i.local_part AND r.domain_id = i.domain_id
             AND (r.expires_at IS NULL OR r.expires_at > NOW())
         )
       )`,
        [localPart.toLowerCase(), domainId]
    );

    if (result.rows.length > 0) {
        return result.rows[0];
    }

    // Create new inbox
    result = await db.query(
        `INSERT INTO inboxes (local_part, domain_id) 
     VALUES ($1, $2) 
     ON CONFLICT (local_part, domain_id) 
     DO UPDATE SET expires_at = NOW() + INTERVAL '24 hours'
     RETURNING *`,
        [localPart.toLowerCase(), domainId]
    );

    // Get with domain info
    const inbox = await db.query(
        `SELECT i.*, d.domain 
     FROM inboxes i 
     JOIN domains d ON i.domain_id = d.id 
     WHERE i.id = $1`,
        [result.rows[0].id]
    );

    return inbox.rows[0];
};

/**
 * Get inbox by full email address
 */
export const getInboxByAddress = async (address) => {
    const [localPart, domain] = address.toLowerCase().split('@');

    if (!localPart || !domain) {
        return null;
    }

    const result = await db.query(
        `SELECT i.*, d.domain 
     FROM inboxes i 
     JOIN domains d ON i.domain_id = d.id 
     WHERE i.local_part = $1 AND d.domain = $2
       AND (
         i.expires_at IS NULL OR i.expires_at > NOW()
         OR EXISTS (
           SELECT 1 FROM inbox_reservations r
           WHERE r.local_part = i.local_part AND r.domain_id = i.domain_id
             AND (r.expires_at IS NULL OR r.expires_at > NOW())
         )
       )`,
        [localPart, domain]
    );

    return result.rows[0];
};

/**
 * Get emails for inbox.
 * Includes the stored otp_code so callers don't need to re-parse bodies.
 * Defaults to a bounded limit for list/polling responses; detail views
 * should fetch a single email via getEmailById instead.
 */
export const getInboxEmails = async (inboxId, limit = DEFAULT_INBOX_LIMIT) => {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_INBOX_LIMIT, 1), MAX_INBOX_LIMIT);
    const result = await db.query(
        `SELECT id, from_address, subject, body_text, body_html, otp_code, has_attachment, received_at 
     FROM emails 
     WHERE inbox_id = $1 
     ORDER BY received_at DESC
     LIMIT $2`,
        [inboxId, safeLimit]
    );
    return result.rows;
};

/**
 * Get the most recent email for an inbox that already has a stored otp_code.
 * Lightweight: no body parsing, single row. Returns undefined if none.
 * Used by the polling-friendly /otp/latest endpoint.
 */
export const getLatestOtpEmail = async (inboxId) => {
    const result = await db.query(
        `SELECT id, from_address, subject, otp_code, received_at
     FROM emails
     WHERE inbox_id = $1 AND otp_code IS NOT NULL
     ORDER BY received_at DESC
     LIMIT 1`,
        [inboxId]
    );
    return result.rows[0];
};

/**
 * Get single email by ID
 */
export const getEmailById = async (emailId) => {
    const result = await db.query(
        `SELECT e.*, i.local_part, d.domain 
     FROM emails e
     JOIN inboxes i ON e.inbox_id = i.id
     JOIN domains d ON i.domain_id = d.id
     WHERE e.id = $1`,
        [emailId]
    );
    return result.rows[0];
};

/**
 * Insert new email.
 * otpCode is extracted once at ingest time (in email-handler.js) and stored,
 * so read endpoints don't re-parse bodies on every request.
 */
export const insertEmail = async (inboxId, emailData) => {
    const { from, subject, text, html, hasAttachment, otpCode } = emailData;

    const result = await db.query(
        `INSERT INTO emails (inbox_id, from_address, subject, body_text, body_html, otp_code, has_attachment)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
        [inboxId, from, subject, text, html, otpCode || null, hasAttachment || false]
    );

    return result.rows[0];
};

/**
 * Delete inbox and all its emails
 */
export const deleteInbox = async (inboxId) => {
    await db.query('DELETE FROM inboxes WHERE id = $1', [inboxId]);
};

/**
 * Count active inboxes
 */
export const countActiveInboxes = async () => {
    const result = await db.query(
        `SELECT COUNT(*) as count FROM inboxes i
         WHERE i.expires_at IS NULL OR i.expires_at > NOW()
           OR EXISTS (
             SELECT 1 FROM inbox_reservations r
             WHERE r.local_part = i.local_part AND r.domain_id = i.domain_id
               AND (r.expires_at IS NULL OR r.expires_at > NOW())
           )`
    );
    return parseInt(result.rows[0].count);
};

/**
 * Get recent emails for admin
 */
export const getRecentEmails = async (limit = 50) => {
    const result = await db.query(
        `SELECT e.id, e.from_address, e.subject, e.received_at, 
            i.local_part, d.domain
     FROM emails e
     JOIN inboxes i ON e.inbox_id = i.id
     JOIN domains d ON i.domain_id = d.id
     LEFT JOIN inbox_reservations r
        ON r.local_part = i.local_part AND r.domain_id = i.domain_id AND r.is_active = true
     WHERE r.id IS NULL
     ORDER BY e.received_at DESC
     LIMIT $1`,
        [limit]
    );
    return result.rows;
};

/**
 * Count emails (with optional filters)
 */
export const countEmails = async (filters = {}) => {
    let query = 'SELECT COUNT(*) as count FROM emails e';
    const params = [];

    if (filters.today) {
        query += ' WHERE e.received_at >= CURRENT_DATE';
    }

    if (filters.domainId) {
        const join = ' JOIN inboxes i ON e.inbox_id = i.id';
        const where = params.length > 0 ? ' AND' : ' WHERE';
        query = query.replace(' FROM emails e', ` FROM emails e${join}`) + `${where} i.domain_id = $${params.length + 1}`;
        params.push(filters.domainId);
    }

    const result = await db.query(query, params);
    return parseInt(result.rows[0].count);
};

/**
 * Get email stats per domain
 */
export const getEmailsPerDomain = async () => {
    const result = await db.query(
        `SELECT d.domain, COUNT(e.id) as email_count
     FROM domains d
     LEFT JOIN inboxes i ON d.id = i.domain_id
     LEFT JOIN emails e ON i.id = e.inbox_id
     WHERE d.is_active = true
     GROUP BY d.id, d.domain
     ORDER BY email_count DESC`
    );
    return result.rows;
};

export default {
    generateRandomLocalPart,
    getOrCreateInbox,
    getInboxByAddress,
    getInboxEmails,
    getLatestOtpEmail,
    getEmailById,
    insertEmail,
    deleteInbox,
    countActiveInboxes,
    getRecentEmails,
    countEmails,
    getEmailsPerDomain,
};

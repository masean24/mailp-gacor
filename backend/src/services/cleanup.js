import db from '../config/database.js';

/**
 * Cleanup expired inboxes and their emails
 * Emails are deleted via CASCADE when inbox is deleted
 */
export const cleanupExpiredInboxes = async () => {
    const result = await db.query(
        `DELETE FROM inboxes i
         WHERE i.expires_at < NOW()
           AND NOT EXISTS (
             SELECT 1 FROM inbox_reservations r
             WHERE r.local_part = i.local_part AND r.domain_id = i.domain_id
               AND (r.expires_at IS NULL OR r.expires_at > NOW())
           )
         RETURNING i.id`
    );
    return result.rowCount;
};

/** Delete protected content before releasing an expired reservation. */
export const cleanupExpiredReservations = async () => {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO inbox_reservation_audit
                (reservation_id, address, action, actor_type, metadata)
             SELECT r.id, r.local_part || '@' || d.domain, 'expired_released', 'system', '{}'::jsonb
             FROM inbox_reservations r
             JOIN domains d ON d.id = r.domain_id
             WHERE r.expires_at IS NOT NULL AND r.expires_at <= NOW()`
        );
        await client.query(
            `DELETE FROM inboxes i USING inbox_reservations r
             WHERE i.local_part = r.local_part AND i.domain_id = r.domain_id
               AND r.expires_at IS NOT NULL AND r.expires_at <= NOW()`
        );
        const result = await client.query(
            `DELETE FROM inbox_reservations
             WHERE expires_at IS NOT NULL AND expires_at <= NOW()
             RETURNING id`
        );
        await client.query('COMMIT');
        return result.rowCount;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

/**
 * Get cleanup statistics
 */
export const getCleanupStats = async () => {
    const expiredCount = await db.query(
        `SELECT COUNT(*) as count FROM inboxes i
         WHERE i.expires_at < NOW()
           AND NOT EXISTS (
             SELECT 1 FROM inbox_reservations r
             WHERE r.local_part = i.local_part AND r.domain_id = i.domain_id
               AND (r.expires_at IS NULL OR r.expires_at > NOW())
           )`
    );

    const totalInboxes = await db.query(
        `SELECT COUNT(*) as count FROM inboxes`
    );

    const totalEmails = await db.query(
        `SELECT COUNT(*) as count FROM emails`
    );

    const expiredReservations = await db.query(
        `SELECT COUNT(*) as count FROM inbox_reservations
         WHERE expires_at IS NOT NULL AND expires_at <= NOW()`
    );

    return {
        expiredInboxes: parseInt(expiredCount.rows[0].count),
        totalInboxes: parseInt(totalInboxes.rows[0].count),
        totalEmails: parseInt(totalEmails.rows[0].count),
        expiredReservations: parseInt(expiredReservations.rows[0].count),
    };
};

export default {
    cleanupExpiredInboxes,
    cleanupExpiredReservations,
    getCleanupStats,
};

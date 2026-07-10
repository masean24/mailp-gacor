import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createHmac } from 'crypto';
import db from '../config/database.js';

const SALT_ROUNDS = parseInt(process.env.INBOX_PASSWORD_SALT_ROUNDS, 10) || 12;
const ACCESS_TTL = process.env.INBOX_ACCESS_TOKEN_TTL || '15m';
const MAX_PUBLIC_RESERVATIONS = parseInt(process.env.PUBLIC_RESERVATION_MAX_PER_IP, 10) || 5;
const PUBLIC_TTL_DAYS = parseInt(process.env.PUBLIC_RESERVATION_TTL_DAYS, 10) || 7;

const normaliseAddress = (address) => String(address || '').trim().toLowerCase();

const splitAddress = (address) => {
    const [localPart, domain, ...rest] = normaliseAddress(address).split('@');
    if (!localPart || !domain || rest.length > 0) return null;
    return { localPart, domain };
};

const getAccessSecret = () => {
    const secret = process.env.INBOX_ACCESS_JWT_SECRET || process.env.JWT_SECRET;
    if (!secret || secret === 'default-secret-change-me') {
        throw new Error('INBOX_ACCESS_JWT_SECRET or a non-default JWT_SECRET must be configured');
    }
    return secret;
};

export const hashClientIp = (ip) => createHmac(
    'sha256',
    process.env.INBOX_RESERVATION_IP_SALT || getAccessSecret()
).update(String(ip || 'unknown')).digest('hex');

const recordAudit = async ({
    queryable = db,
    reservationId = null,
    address,
    action,
    actorType = 'system',
    actorAdminId = null,
    metadata = {},
}) => {
    await queryable.query(
        `INSERT INTO inbox_reservation_audit
            (reservation_id, address, action, actor_type, actor_admin_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [reservationId, normaliseAddress(address).slice(0, 512), action, actorType, actorAdminId, JSON.stringify(metadata)]
    );
};

export const getReservationByAddress = async (address) => {
    const parts = splitAddress(address);
    if (!parts) return null;

    const result = await db.query(
        `SELECT r.*, d.domain
         FROM inbox_reservations r
         JOIN domains d ON d.id = r.domain_id
         WHERE r.local_part = $1 AND d.domain = $2`,
        [parts.localPart, parts.domain]
    );
    return result.rows[0] || null;
};

export const isAddressProtected = async (address) => Boolean(await getReservationByAddress(address));

/** Reserve an address and record its ownership source. Existing inbox content
 * can only be adopted through an explicit admin-only conversion. */
export const reserveAddress = async ({
    localPart,
    domainId,
    password,
    actorType = 'public',
    actorAdminId = null,
    ipHash = null,
    expiresInDays,
    protectExistingInbox = false,
}) => {
    const client = await db.connect();
    const safeLocalPart = String(localPart || '').trim().toLowerCase();
    const safeActorType = actorType === 'admin' ? 'admin' : 'public';
    const requestedDays = safeActorType === 'public' ? PUBLIC_TTL_DAYS : expiresInDays;
    const safeDays = requestedDays === null || requestedDays === undefined || requestedDays === ''
        ? null
        : Math.min(Math.max(parseInt(requestedDays, 10) || 1, 1), 3650);
    const reservationExpiresAt = safeDays
        ? new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000)
        : null;

    try {
        await client.query('BEGIN');

        const domainResult = await client.query(
            `SELECT * FROM domains
             WHERE id = $1 AND is_active = true AND verification_status = 'active'`,
            [domainId]
        );
        const domain = domainResult.rows[0];
        if (!domain) {
            const error = new Error('Invalid or inactive domain');
            error.code = 'DOMAIN_UNAVAILABLE';
            throw error;
        }

        if (protectExistingInbox && safeActorType !== 'admin') {
            const error = new Error('Only an admin can protect an existing inbox');
            error.code = 'EXISTING_INBOX_FORBIDDEN';
            throw error;
        }

        if (safeActorType === 'public' && ipHash) {
            // Serialize quota checks per anonymized IP so concurrent requests
            // cannot race past the configured limit.
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ipHash]);
            const quotaResult = await client.query(
                `SELECT COUNT(*)::int AS count
                 FROM inbox_reservations
                 WHERE created_by = 'public' AND created_by_ip_hash = $1
                   AND (expires_at IS NULL OR expires_at > NOW())`,
                [ipHash]
            );
            if (quotaResult.rows[0].count >= MAX_PUBLIC_RESERVATIONS) {
                const error = new Error(`Public reservation limit reached (${MAX_PUBLIC_RESERVATIONS} per network)`);
                error.code = 'RESERVATION_QUOTA';
                throw error;
            }
        }

        const existingReservation = await client.query(
            'SELECT id FROM inbox_reservations WHERE local_part = $1 AND domain_id = $2 FOR UPDATE',
            [safeLocalPart, domainId]
        );
        if (existingReservation.rowCount > 0) {
            const error = new Error('This email address is already reserved');
            error.code = 'ALREADY_RESERVED';
            throw error;
        }

        const existingInboxResult = await client.query(
            `SELECT i.*,
                    (SELECT COUNT(*)::int FROM emails e WHERE e.inbox_id = i.id) AS email_count
             FROM inboxes i
             WHERE i.local_part = $1 AND i.domain_id = $2
             FOR UPDATE OF i`,
            [safeLocalPart, domainId]
        );

        if (protectExistingInbox && existingInboxResult.rowCount === 0) {
            const error = new Error('Existing inbox not found');
            error.code = 'EXISTING_INBOX_NOT_FOUND';
            throw error;
        }

        const existingEmailCount = existingInboxResult.rows[0]?.email_count || 0;
        if (!protectExistingInbox && existingEmailCount > 0) {
            const error = new Error('An address that already contains email cannot be reserved');
            error.code = 'INBOX_HAS_EMAILS';
            throw error;
        }

        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        const reservationResult = await client.query(
            `INSERT INTO inbox_reservations
                (local_part, domain_id, password_hash, created_by, created_by_admin_id,
                 created_by_ip_hash, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, local_part, domain_id, credential_version, is_active,
                       created_by, expires_at, created_at`,
            [safeLocalPart, domainId, passwordHash, safeActorType, actorAdminId, ipHash, reservationExpiresAt]
        );

        const inboxResult = await client.query(
            `INSERT INTO inboxes (local_part, domain_id, expires_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (local_part, domain_id)
             DO UPDATE SET expires_at = EXCLUDED.expires_at
             RETURNING *`,
            [safeLocalPart, domainId, reservationExpiresAt]
        );

        const reservation = reservationResult.rows[0];
        const address = `${safeLocalPart}@${domain.domain}`;
        await recordAudit({
            queryable: client,
            reservationId: reservation.id,
            address,
            action: protectExistingInbox ? 'existing_inbox_protected' : 'reserved',
            actorType: safeActorType,
            actorAdminId,
            metadata: {
                expiresAt: reservation.expires_at,
                preservedEmails: protectExistingInbox ? existingEmailCount : 0,
            },
        });

        await client.query('COMMIT');
        return {
            reservation,
            inbox: { ...inboxResult.rows[0], domain: domain.domain },
            convertedExistingInbox: protectExistingInbox,
            preservedEmails: protectExistingInbox ? existingEmailCount : 0,
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

export const updateReservation = async ({ reservationId, password, isActive, actorAdminId }) => {
    const passwordHash = password ? await bcrypt.hash(password, SALT_ROUNDS) : null;
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE inbox_reservations
             SET password_hash = COALESCE($1, password_hash),
                 is_active = COALESCE($2, is_active),
                 credential_version = credential_version + 1,
                 updated_at = NOW()
             WHERE id = $3
             RETURNING *`,
            [passwordHash, isActive, reservationId]
        );
        const reservation = result.rows[0];
        if (!reservation) {
            await client.query('ROLLBACK');
            return null;
        }
        const domainResult = await client.query('SELECT domain FROM domains WHERE id = $1', [reservation.domain_id]);
        const address = `${reservation.local_part}@${domainResult.rows[0].domain}`;
        await recordAudit({
            queryable: client,
            reservationId,
            address,
            action: password ? 'password_reset' : (isActive ? 'enabled' : 'disabled'),
            actorType: 'admin',
            actorAdminId,
        });
        await client.query('COMMIT');
        return reservation;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

// Backward-compatible export for existing callers.
export const updateReservationPassword = updateReservation;

export const getAllReservations = async ({ search = '', status = '', source = '' } = {}) => {
    const params = [];
    const conditions = [];
    if (search) {
        params.push(`%${String(search).trim().toLowerCase()}%`);
        conditions.push(`(r.local_part || '@' || d.domain) ILIKE $${params.length}`);
    }
    if (source === 'public' || source === 'admin') {
        params.push(source);
        conditions.push(`r.created_by = $${params.length}`);
    }
    if (status === 'active') conditions.push(`r.is_active = true AND (r.expires_at IS NULL OR r.expires_at > NOW())`);
    if (status === 'disabled') conditions.push('r.is_active = false');
    if (status === 'expired') conditions.push('r.expires_at IS NOT NULL AND r.expires_at <= NOW()');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await db.query(
        `SELECT r.id, r.local_part, r.domain_id, r.is_active, r.created_by,
                r.expires_at, r.last_accessed_at, r.created_at, r.updated_at, d.domain,
                COUNT(e.id)::int AS email_count,
                MAX(e.received_at) AS last_email_at
         FROM inbox_reservations r
         JOIN domains d ON d.id = r.domain_id
         LEFT JOIN inboxes i ON i.local_part = r.local_part AND i.domain_id = r.domain_id
         LEFT JOIN emails e ON e.inbox_id = i.id
         ${where}
         GROUP BY r.id, d.domain
         ORDER BY r.created_at DESC
         LIMIT 500`,
        params
    );
    return result.rows;
};

export const getReservationStats = async () => {
    const [reservationResult, failedResult] = await Promise.all([
        db.query(
            `SELECT
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE is_active = true AND (expires_at IS NULL OR expires_at > NOW()))::int AS active,
               COUNT(*) FILTER (WHERE is_active = false)::int AS disabled,
               COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= NOW())::int AS expired,
               COUNT(*) FILTER (WHERE created_by = 'public')::int AS public_count,
               COUNT(*) FILTER (WHERE created_by = 'admin')::int AS admin_count
             FROM inbox_reservations`
        ),
        db.query(
            `SELECT COUNT(*)::int AS count FROM inbox_reservation_audit
             WHERE action = 'unlock_failed' AND created_at >= NOW() - INTERVAL '24 hours'`
        ),
    ]);
    return { ...reservationResult.rows[0], failedUnlocks24h: failedResult.rows[0].count };
};

const getReservationForUpdate = async (client, reservationId) => {
    const result = await client.query(
        `SELECT r.*, d.domain FROM inbox_reservations r
         JOIN domains d ON d.id = r.domain_id WHERE r.id = $1 FOR UPDATE OF r`,
        [reservationId]
    );
    return result.rows[0] || null;
};

export const clearReservationInbox = async ({ reservationId, actorAdminId }) => {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const reservation = await getReservationForUpdate(client, reservationId);
        if (!reservation) {
            await client.query('ROLLBACK');
            return null;
        }
        const countResult = await client.query(
            `SELECT COUNT(e.id)::int AS count FROM inboxes i
             LEFT JOIN emails e ON e.inbox_id = i.id
             WHERE i.local_part = $1 AND i.domain_id = $2`,
            [reservation.local_part, reservation.domain_id]
        );
        await client.query('DELETE FROM inboxes WHERE local_part = $1 AND domain_id = $2', [reservation.local_part, reservation.domain_id]);
        await recordAudit({
            queryable: client,
            reservationId,
            address: `${reservation.local_part}@${reservation.domain}`,
            action: 'inbox_cleared',
            actorType: 'admin',
            actorAdminId,
            metadata: { deletedEmails: countResult.rows[0].count },
        });
        await client.query('COMMIT');
        return { deletedEmails: countResult.rows[0].count };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

export const releaseReservation = async ({ reservationId, actorAdminId }) => {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const reservation = await getReservationForUpdate(client, reservationId);
        if (!reservation) {
            await client.query('ROLLBACK');
            return null;
        }
        const address = `${reservation.local_part}@${reservation.domain}`;
        await client.query('DELETE FROM inboxes WHERE local_part = $1 AND domain_id = $2', [reservation.local_part, reservation.domain_id]);
        await recordAudit({
            queryable: client,
            reservationId,
            address,
            action: 'released',
            actorType: 'admin',
            actorAdminId,
        });
        await client.query('DELETE FROM inbox_reservations WHERE id = $1', [reservationId]);
        await client.query('COMMIT');
        return { address };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

export const getAuditLog = async ({ limit = 50 } = {}) => {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const result = await db.query(
        `SELECT id, reservation_id, address, action, actor_type, actor_admin_id, metadata, created_at
         FROM inbox_reservation_audit ORDER BY created_at DESC LIMIT $1`,
        [safeLimit]
    );
    return result.rows;
};

export const unlockAddress = async ({ address, password, ipHash = null }) => {
    const reservation = await getReservationByAddress(address);
    const isExpired = reservation?.expires_at && new Date(reservation.expires_at) <= new Date();
    const valid = reservation && reservation.is_active && !isExpired
        && await bcrypt.compare(password, reservation.password_hash);

    if (!valid) {
        await recordAudit({
            reservationId: reservation?.id || null,
            address,
            action: 'unlock_failed',
            actorType: 'public',
            metadata: {},
        });
        const error = new Error('Invalid email address or password');
        error.code = 'INVALID_PASSWORD';
        throw error;
    }

    const safeAddress = normaliseAddress(address);
    const token = jwt.sign(
        {
            type: 'inbox-access',
            reservationId: reservation.id,
            address: safeAddress,
            credentialVersion: reservation.credential_version,
        },
        getAccessSecret(),
        { expiresIn: ACCESS_TTL }
    );

    await Promise.all([
        db.query('UPDATE inbox_reservations SET last_accessed_at = NOW() WHERE id = $1', [reservation.id]),
        recordAudit({
            reservationId: reservation.id,
            address,
            action: 'unlock_success',
            actorType: 'public',
        }),
    ]);
    return { token, expiresIn: ACCESS_TTL };
};

/** Public inboxes are allowed; protected inboxes require a scoped token. */
export const checkInboxAccess = async (req, address) => {
    const reservation = await getReservationByAddress(address);
    if (!reservation) return { allowed: true, protected: false };
    const isExpired = reservation.expires_at && new Date(reservation.expires_at) <= new Date();
    if (!reservation.is_active || isExpired) return { allowed: false, protected: true };

    const token = req.headers['x-inbox-access'];
    if (!token || Array.isArray(token)) return { allowed: false, protected: true };

    try {
        const payload = jwt.verify(token, getAccessSecret());
        const allowed = payload.type === 'inbox-access'
            && payload.reservationId === reservation.id
            && payload.address === normaliseAddress(address)
            && payload.credentialVersion === reservation.credential_version;
        return { allowed, protected: true };
    } catch {
        return { allowed: false, protected: true };
    }
};

export default {
    hashClientIp,
    getReservationByAddress,
    isAddressProtected,
    reserveAddress,
    updateReservation,
    updateReservationPassword,
    getAllReservations,
    getReservationStats,
    clearReservationInbox,
    releaseReservation,
    getAuditLog,
    unlockAddress,
    checkInboxAccess,
};

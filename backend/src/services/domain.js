import { randomBytes } from 'crypto';
import { resolveTxt } from 'dns/promises';
import db from '../config/database.js';

export const DOMAIN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const normaliseDomain = (domain) => String(domain || '').trim().toLowerCase();

/** Domains are selectable only after both DNS verification and Postfix activation. */
export const getActiveDomains = async () => {
    const result = await db.query(
        `SELECT id, domain FROM domains
         WHERE is_active = true AND verification_status = 'active'
         ORDER BY domain`
    );
    return result.rows;
};

export const getAllDomains = async () => {
    const result = await db.query(
        `SELECT id, domain, is_active, verification_status, verification_token,
                verified_at, last_verification_check_at, sync_error, created_at
         FROM domains ORDER BY created_at DESC`
    );
    return result.rows;
};

export const getDomainById = async (id) => {
    const result = await db.query('SELECT * FROM domains WHERE id = $1', [id]);
    return result.rows[0];
};

export const getDomainByName = async (domain) => {
    const result = await db.query('SELECT * FROM domains WHERE domain = $1', [normaliseDomain(domain)]);
    return result.rows[0];
};

/** Create a pending domain. It cannot receive mail until DNS is verified. */
export const createDomain = async (domain) => {
    const verificationToken = randomBytes(24).toString('hex');
    const result = await db.query(
        `INSERT INTO domains (domain, is_active, verification_status, verification_token)
         VALUES ($1, false, 'pending_verification', $2)
         RETURNING *`,
        [normaliseDomain(domain), verificationToken]
    );
    return result.rows[0];
};

export const getVerificationInstructions = (domain) => ({
    txt: {
        type: 'TXT',
        name: '@',
        value: `hubify-mail-verification=${domain.verification_token}`,
    },
    mx: {
        type: 'MX',
        name: '@',
        value: process.env.MAIL_SERVER_HOSTNAME || 'mail.hubify.store',
        priority: 10,
    },
});

/** Check the exact TXT token through the system DNS resolver. */
export const verifyDomainDns = async (id) => {
    const domain = await getDomainById(id);
    if (!domain) {
        const error = new Error('Domain not found');
        error.code = 'DOMAIN_NOT_FOUND';
        throw error;
    }
    if (!domain.verification_token) {
        const error = new Error('This domain cannot be DNS verified. Re-add it to use the new flow.');
        error.code = 'NO_VERIFICATION_TOKEN';
        throw error;
    }

    let records;
    try {
        records = await resolveTxt(domain.domain);
    } catch (error) {
        await db.query('UPDATE domains SET last_verification_check_at = NOW() WHERE id = $1', [id]);
        const verificationError = new Error('TXT record was not found yet. DNS propagation can take time.');
        verificationError.code = 'TXT_NOT_FOUND';
        throw verificationError;
    }

    const expected = `hubify-mail-verification=${domain.verification_token}`;
    const found = records.map((parts) => parts.join('')).some((value) => value === expected);
    if (!found) {
        await db.query('UPDATE domains SET last_verification_check_at = NOW() WHERE id = $1', [id]);
        const verificationError = new Error('TXT verification value does not match.');
        verificationError.code = 'TXT_NOT_FOUND';
        throw verificationError;
    }

    const result = await db.query(
        `UPDATE domains
         SET verification_status = 'verified', is_active = false, verified_at = NOW(),
             last_verification_check_at = NOW(), sync_error = NULL
         WHERE id = $1
         RETURNING *`,
        [id]
    );
    return result.rows[0];
};

/** Mark a DNS-verified domain active before Postfix is synced. */
export const activateVerifiedDomain = async (id) => {
    const result = await db.query(
        `UPDATE domains
         SET is_active = true, verification_status = 'active', sync_error = NULL
         WHERE id = $1
           AND (
             verification_status IN ('verified', 'sync_failed', 'active')
             OR (verification_status = 'disabled' AND verified_at IS NOT NULL)
           )
         RETURNING *`,
        [id]
    );
    return result.rows[0] || null;
};

export const markDomainSyncFailed = async (id, errorMessage) => {
    const result = await db.query(
        `UPDATE domains
         SET is_active = false, verification_status = 'sync_failed', sync_error = $1
         WHERE id = $2
         RETURNING *`,
        [String(errorMessage || 'Postfix sync failed').slice(0, 2000), id]
    );
    return result.rows[0] || null;
};

export const disableDomain = async (id) => {
    const result = await db.query(
        `UPDATE domains
         SET is_active = false, verification_status = 'disabled',
             verified_at = CASE WHEN verification_status = 'active' THEN COALESCE(verified_at, NOW()) ELSE verified_at END,
             sync_error = NULL
         WHERE id = $1 RETURNING *`,
        [id]
    );
    return result.rows[0] || null;
};

/** Backward-compatible helper used by existing callers. Domain rename is not allowed. */
export const updateDomain = async (id, updates) => {
    if (updates.domain !== undefined) {
        const error = new Error('Domain names cannot be changed. Add and verify a new domain instead.');
        error.code = 'DOMAIN_RENAME_UNSUPPORTED';
        throw error;
    }
    if (updates.is_active === false) return disableDomain(id);
    if (updates.is_active === true) return activateVerifiedDomain(id);
    return getDomainById(id);
};

export const deleteDomain = async (id) => {
    await db.query('DELETE FROM domains WHERE id = $1', [id]);
};

export default {
    DOMAIN_PATTERN,
    getActiveDomains,
    getAllDomains,
    getDomainById,
    getDomainByName,
    createDomain,
    getVerificationInstructions,
    verifyDomainDns,
    activateVerifiedDomain,
    markDomainSyncFailed,
    disableDomain,
    updateDomain,
    deleteDomain,
};

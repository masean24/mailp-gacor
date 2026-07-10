import { Router } from 'express';
import { authMiddleware, generateToken } from '../middleware/auth.js';
import adminService from '../services/admin.js';
import domainService from '../services/domain.js';
import inboxService from '../services/inbox.js';
import cleanupService from '../services/cleanup.js';
import namesService from '../services/names.js';
import postfixSync from '../services/postfixSync.js';
import inboxAccessService from '../services/inboxAccess.js';

const router = Router();

/**
 * POST /api/admin/login
 * Admin login
 */
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                error: 'Username and password are required',
            });
        }

        const admin = await adminService.getAdminByUsername(username);

        if (!admin) {
            return res.status(401).json({
                success: false,
                error: 'Invalid credentials',
            });
        }

        const isValid = await adminService.verifyPassword(password, admin.password_hash);

        if (!isValid) {
            return res.status(401).json({
                success: false,
                error: 'Invalid credentials',
            });
        }

        const token = generateToken({
            id: admin.id,
            username: admin.username,
        });

        res.json({
            success: true,
            data: {
                token,
                username: admin.username,
            },
        });
    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({
            success: false,
            error: 'Login failed',
        });
    }
});

// Protected routes below
router.use(authMiddleware);

/**
 * GET /api/admin/stats
 * Get dashboard statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const [
            totalEmailsToday,
            totalEmailsAll,
            activeInboxes,
            emailsPerDomain,
            cleanupStats,
        ] = await Promise.all([
            inboxService.countEmails({ today: true }),
            inboxService.countEmails(),
            inboxService.countActiveInboxes(),
            inboxService.getEmailsPerDomain(),
            cleanupService.getCleanupStats(),
        ]);

        res.json({
            success: true,
            data: {
                totalEmailsToday,
                totalEmailsAll,
                activeInboxes,
                emailsPerDomain,
                expiredInboxes: cleanupStats.expiredInboxes,
            },
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch statistics',
        });
    }
});

/**
 * GET /api/admin/domains
 * Get all domains
 */
router.get('/domains', async (req, res) => {
    try {
        const domains = await domainService.getAllDomains();
        res.json({
            success: true,
            data: domains,
        });
    } catch (error) {
        console.error('Error fetching domains:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch domains',
        });
    }
});

/**
 * POST /api/admin/domains
 * Add new domain
 */
router.post('/domains', async (req, res) => {
    try {
        const { domain } = req.body;

        if (!domain) {
            return res.status(400).json({
                success: false,
                error: 'Domain is required',
            });
        }

        if (!domainService.DOMAIN_PATTERN.test(domain)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid domain format',
            });
        }

        // Check if domain already exists
        const existing = await domainService.getDomainByName(domain);
        if (existing) {
            return res.status(400).json({
                success: false,
                error: 'Domain already exists',
            });
        }

        const newDomain = await domainService.createDomain(domain);
        res.status(201).json({
            success: true,
            data: newDomain,
            setup: domainService.getVerificationInstructions(newDomain),
            message: 'Add the TXT and MX records, then verify this domain before it can receive email.',
        });
    } catch (error) {
        console.error('Error creating domain:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create domain',
        });
    }
});

/** Verify DNS ownership, then sync Postfix and activate the domain. */
router.post('/domains/:id/verify', async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await domainService.getDomainById(id);
        if (!existing) return res.status(404).json({ success: false, error: 'Domain not found' });

        const verified = await domainService.verifyDomainDns(id);
        const activated = await domainService.activateVerifiedDomain(id);
        if (!activated) {
            return res.status(409).json({ success: false, error: 'Domain is not ready to be activated' });
        }

        const syncResult = await postfixSync.syncPostfix();
        if (!syncResult.success || syncResult.skipped) {
            const failedDomain = await domainService.markDomainSyncFailed(
                id,
                syncResult.error || 'Postfix sync is disabled'
            );
            return res.status(502).json({
                success: false,
                error: 'DNS was verified, but Postfix was not updated. Enable POSTFIX_SYNC_ENABLED before activating this domain.',
                data: failedDomain,
            });
        }

        res.json({
            success: true,
            data: activated,
            setup: domainService.getVerificationInstructions(verified),
            message: 'Domain verified and activated for incoming email.',
        });
    } catch (error) {
        const status = ['TXT_NOT_FOUND', 'NO_VERIFICATION_TOKEN'].includes(error.code) ? 400
            : error.code === 'DOMAIN_NOT_FOUND' ? 404 : 500;
        if (status === 500) console.error('Error verifying domain:', error);
        res.status(status).json({ success: false, error: error.message || 'Failed to verify domain' });
    }
});

/**
 * PATCH /api/admin/domains/:id
 * Update domain
 */
router.patch('/domains/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { domain, is_active } = req.body;

        const existing = await domainService.getDomainById(id);
        if (!existing) {
            return res.status(404).json({
                success: false,
                error: 'Domain not found',
            });
        }

        if (domain !== undefined) {
            return res.status(400).json({ success: false, error: 'Domain names cannot be changed. Add and verify a new domain instead.' });
        }
        if (typeof is_active !== 'boolean') {
            return res.status(400).json({ success: false, error: 'is_active must be a boolean' });
        }
        if (is_active && existing.verification_status === 'pending_verification') {
            return res.status(409).json({ success: false, error: 'Verify the DNS TXT record before enabling this domain' });
        }

        const updated = await domainService.updateDomain(id, { is_active });
        if (!updated) return res.status(409).json({ success: false, error: 'Domain is not ready to be activated' });

        const syncResult = await postfixSync.syncPostfix();
        if (!syncResult.success || (is_active && syncResult.skipped)) {
            const failedDomain = is_active
                ? await domainService.markDomainSyncFailed(id, syncResult.error || 'Postfix sync is disabled')
                : updated;
            return res.status(502).json({
                success: false,
                error: 'Postfix config was not updated. The domain state was not activated.',
                data: failedDomain,
            });
        }

        res.json({ success: true, data: updated });
    } catch (error) {
        console.error('Error updating domain:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update domain',
        });
    }
});

/**
 * DELETE /api/admin/domains/:id
 * Delete domain
 */
router.delete('/domains/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const existing = await domainService.getDomainById(id);
        if (!existing) {
            return res.status(404).json({
                success: false,
                error: 'Domain not found',
            });
        }

        await domainService.deleteDomain(id);

        const syncResult = await postfixSync.syncPostfix();
        const payload = { success: true, message: 'Domain deleted successfully' };
        if (!syncResult.success && !syncResult.skipped) {
            payload.postfixSyncWarning = syncResult.error || 'Postfix config was not updated. Update virtual_mailbox_domains on the VPS manually.';
        }

        res.json(payload);
    } catch (error) {
        console.error('Error deleting domain:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete domain',
        });
    }
});

/**
 * GET /api/admin/emails/recent
 * Get recent emails
 */
router.get('/emails/recent', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const emails = await inboxService.getRecentEmails(limit);

        res.json({
            success: true,
            data: emails.map((e) => ({
                id: e.id,
                to: `${e.local_part}@${e.domain}`,
                from: e.from_address,
                subject: e.subject,
                receivedAt: e.received_at,
            })),
        });
    } catch (error) {
        console.error('Error fetching recent emails:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch recent emails',
        });
    }
});

/** Admin manages reservations but never receives a read bypass. */
router.get('/inbox-reservations', async (req, res) => {
    try {
        const reservations = await inboxAccessService.getAllReservations({
            search: req.query.search,
            status: req.query.status,
            source: req.query.source,
        });
        res.json({
            success: true,
            data: reservations.map((reservation) => ({
                id: reservation.id,
                email: `${reservation.local_part}@${reservation.domain}`,
                isActive: reservation.is_active,
                status: reservation.expires_at && new Date(reservation.expires_at) <= new Date()
                    ? 'expired' : (reservation.is_active ? 'active' : 'disabled'),
                source: reservation.created_by,
                emailCount: reservation.email_count,
                expiresAt: reservation.expires_at,
                lastAccessedAt: reservation.last_accessed_at,
                lastEmailAt: reservation.last_email_at,
                createdAt: reservation.created_at,
                updatedAt: reservation.updated_at,
            })),
        });
    } catch (error) {
        console.error('Error fetching inbox reservations:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch inbox reservations' });
    }
});

router.get('/inbox-reservations/stats', async (req, res) => {
    try {
        res.json({ success: true, data: await inboxAccessService.getReservationStats() });
    } catch (error) {
        console.error('Error fetching reservation stats:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch reservation statistics' });
    }
});

router.get('/inbox-reservations/audit', async (req, res) => {
    try {
        res.json({ success: true, data: await inboxAccessService.getAuditLog({ limit: req.query.limit }) });
    } catch (error) {
        console.error('Error fetching reservation audit:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch reservation audit' });
    }
});

router.post('/inbox-reservations', async (req, res) => {
    try {
        const {
            localPart,
            domainId,
            password,
            expiresInDays = null,
            protectExistingInbox = false,
        } = req.body;
        if (!localPart || !domainId || !password) {
            return res.status(400).json({ success: false, error: 'localPart, domainId, and password are required' });
        }
        if (!/^[a-zA-Z0-9._-]+$/.test(localPart)) {
            return res.status(400).json({ success: false, error: 'Invalid local part' });
        }
        if (typeof password !== 'string' || password.length < 10 || password.length > 256) {
            return res.status(400).json({ success: false, error: 'Password must be between 10 and 256 characters' });
        }
        if (typeof protectExistingInbox !== 'boolean') {
            return res.status(400).json({ success: false, error: 'protectExistingInbox must be a boolean' });
        }

        if (expiresInDays !== null && (!Number.isInteger(Number(expiresInDays)) || Number(expiresInDays) < 1 || Number(expiresInDays) > 3650)) {
            return res.status(400).json({ success: false, error: 'expiresInDays must be null or between 1 and 3650' });
        }

        const { inbox, reservation, convertedExistingInbox, preservedEmails } = await inboxAccessService.reserveAddress({
            localPart,
            domainId,
            password,
            actorType: 'admin',
            actorAdminId: req.admin.id,
            expiresInDays,
            protectExistingInbox,
        });
        res.status(201).json({
            success: true,
            data: {
                email: `${inbox.local_part}@${inbox.domain}`,
                protected: true,
                expiresAt: reservation.expires_at,
                convertedExistingInbox,
                preservedEmails,
            },
        });
    } catch (error) {
        const status = ['ALREADY_RESERVED', 'INBOX_HAS_EMAILS'].includes(error.code) ? 409
            : error.code === 'EXISTING_INBOX_NOT_FOUND' ? 404
                : ['DOMAIN_UNAVAILABLE', 'EXISTING_INBOX_FORBIDDEN'].includes(error.code) ? 400 : 500;
        if (status === 500) console.error('Error creating inbox reservation:', error);
        res.status(status).json({ success: false, error: error.message || 'Failed to reserve inbox' });
    }
});

router.patch('/inbox-reservations/:id', async (req, res) => {
    try {
        const reservationId = parseInt(req.params.id, 10);
        const { password, isActive } = req.body;
        if (!reservationId || (password === undefined && isActive === undefined)) {
            return res.status(400).json({ success: false, error: 'A password or isActive value is required' });
        }
        if (password !== undefined && (typeof password !== 'string' || password.length < 10 || password.length > 256)) {
            return res.status(400).json({ success: false, error: 'Password must be between 10 and 256 characters' });
        }
        if (isActive !== undefined && typeof isActive !== 'boolean') {
            return res.status(400).json({ success: false, error: 'isActive must be a boolean' });
        }

        const reservation = await inboxAccessService.updateReservation({
            reservationId,
            password,
            isActive,
            actorAdminId: req.admin.id,
        });
        if (!reservation) return res.status(404).json({ success: false, error: 'Reservation not found' });
        res.json({ success: true, data: reservation });
    } catch (error) {
        console.error('Error updating inbox reservation:', error);
        res.status(500).json({ success: false, error: 'Failed to update inbox reservation' });
    }
});

router.delete('/inbox-reservations/:id/inbox', async (req, res) => {
    try {
        const result = await inboxAccessService.clearReservationInbox({
            reservationId: parseInt(req.params.id, 10),
            actorAdminId: req.admin.id,
        });
        if (!result) return res.status(404).json({ success: false, error: 'Reservation not found' });
        res.json({ success: true, data: result, message: `Deleted ${result.deletedEmails} email(s); reservation remains protected.` });
    } catch (error) {
        console.error('Error clearing protected inbox:', error);
        res.status(500).json({ success: false, error: 'Failed to clear protected inbox' });
    }
});

router.delete('/inbox-reservations/:id', async (req, res) => {
    try {
        const result = await inboxAccessService.releaseReservation({
            reservationId: parseInt(req.params.id, 10),
            actorAdminId: req.admin.id,
        });
        if (!result) return res.status(404).json({ success: false, error: 'Reservation not found' });
        res.json({ success: true, data: result, message: 'Reservation released and protected email content deleted.' });
    } catch (error) {
        console.error('Error releasing inbox reservation:', error);
        res.status(500).json({ success: false, error: 'Failed to release reservation' });
    }
});

/**
 * POST /api/admin/cleanup
 * Trigger manual cleanup
 */
router.post('/cleanup', async (req, res) => {
    try {
        const releasedReservations = await cleanupService.cleanupExpiredReservations();
        const deletedCount = await cleanupService.cleanupExpiredInboxes();

        res.json({
            success: true,
            message: `Cleanup completed. Released ${releasedReservations} reservations and deleted ${deletedCount} expired inboxes.`,
            deletedCount,
            releasedReservations,
        });
    } catch (error) {
        console.error('Error during cleanup:', error);
        res.status(500).json({
            success: false,
            error: 'Cleanup failed',
        });
    }
});

// ============================
// NAMES MANAGEMENT ROUTES
// ============================

/**
 * GET /api/admin/names
 * Get all names
 */
router.get('/names', async (req, res) => {
    try {
        const names = await namesService.getAllNames();
        const stats = await namesService.getNamesCount();
        res.json({
            success: true,
            data: names,
            stats,
        });
    } catch (error) {
        console.error('Error fetching names:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch names',
        });
    }
});

/**
 * POST /api/admin/names
 * Add new name
 */
router.post('/names', async (req, res) => {
    try {
        const { name, gender } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                error: 'Name is required',
            });
        }

        // Validate name format (letters only, lowercase)
        if (!/^[a-zA-Z]+$/.test(name)) {
            return res.status(400).json({
                success: false,
                error: 'Name must contain only letters',
            });
        }

        const newName = await namesService.addName(name, gender || 'neutral');

        res.status(201).json({
            success: true,
            data: newName,
        });
    } catch (error) {
        console.error('Error creating name:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create name',
        });
    }
});

/**
 * PATCH /api/admin/names/:id
 * Update name
 */
router.patch('/names/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, gender, is_active } = req.body;

        const updated = await namesService.updateName(id, { name, gender, is_active });

        if (!updated) {
            return res.status(404).json({
                success: false,
                error: 'Name not found',
            });
        }

        res.json({
            success: true,
            data: updated,
        });
    } catch (error) {
        console.error('Error updating name:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update name',
        });
    }
});

/**
 * DELETE /api/admin/names/all
 * Delete all names
 * NOTE: must be declared BEFORE '/names/:id' so 'all' is not matched as an id.
 */
router.delete('/names/all', async (req, res) => {
    try {
        const result = await namesService.deleteAllNames();

        res.json({
            success: true,
            message: `Deleted ${result.count} names`,
            deletedCount: result.count,
        });
    } catch (error) {
        console.error('Error deleting all names:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete names',
        });
    }
});

/**
 * DELETE /api/admin/names/:id
 * Delete name
 */
router.delete('/names/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const deleted = await namesService.deleteName(id);

        if (!deleted) {
            return res.status(404).json({
                success: false,
                error: 'Name not found',
            });
        }

        res.json({
            success: true,
            message: 'Name deleted successfully',
        });
    } catch (error) {
        console.error('Error deleting name:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete name',
        });
    }
});

/**
 * DELETE /api/admin/names/all
 * (moved above /names/:id)
 */

/**
 * POST /api/admin/names/bulk
 * Bulk add names from file upload
 * Body: { names: string[] | { name: string, gender: string }[], gender?: string }
 */
router.post('/names/bulk', async (req, res) => {
    try {
        const { names, gender } = req.body;

        if (!names || !Array.isArray(names) || names.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Names array is required',
            });
        }

        // If gender is provided, apply it to all names
        const namesWithGender = gender
            ? names.map(n => ({ name: typeof n === 'string' ? n : n.name, gender }))
            : names;

        const result = await namesService.addBulkNames(namesWithGender);

        res.status(201).json({
            success: true,
            message: `Added ${result.added.length} names`,
            data: result,
        });
    } catch (error) {
        console.error('Error bulk adding names:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to bulk add names',
        });
    }
});

export default router;

import { Router } from 'express';
import { authMiddleware, generateToken } from '../middleware/auth.js';
import adminService from '../services/admin.js';
import domainService from '../services/domain.js';
import inboxService from '../services/inbox.js';
import cleanupService from '../services/cleanup.js';
import namesService from '../services/names.js';
import postfixSync from '../services/postfixSync.js';

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

        // Validate domain format
        if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
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

        const syncResult = await postfixSync.syncPostfix();
        const payload = { success: true, data: newDomain };
        if (!syncResult.success && !syncResult.skipped) {
            payload.postfixSyncWarning = syncResult.error || 'Postfix config was not updated. Update virtual_mailbox_domains on the VPS manually.';
        }

        res.status(201).json(payload);
    } catch (error) {
        console.error('Error creating domain:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create domain',
        });
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

        const updated = await domainService.updateDomain(id, { domain, is_active });

        const syncResult = await postfixSync.syncPostfix();
        const payload = { success: true, data: updated };
        if (!syncResult.success && !syncResult.skipped) {
            payload.postfixSyncWarning = syncResult.error || 'Postfix config was not updated. Update virtual_mailbox_domains on the VPS manually.';
        }

        res.json(payload);
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

/**
 * POST /api/admin/cleanup
 * Trigger manual cleanup
 */
router.post('/cleanup', async (req, res) => {
    try {
        const deletedCount = await cleanupService.cleanupExpiredInboxes();

        res.json({
            success: true,
            message: `Cleanup completed. Deleted ${deletedCount} expired inboxes.`,
            deletedCount,
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


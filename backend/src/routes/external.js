import { Router } from 'express';
import domainService from '../services/domain.js';
import inboxService from '../services/inbox.js';
import namesService from '../services/names.js';
import otpExtract from '../services/otpExtract.js';
import postfixSync from '../services/postfixSync.js';
import apiKeyAuth from '../middleware/apiKeyAuth.js';

const router = Router();

// All external routes require API key
router.use(apiKeyAuth());

/**
 * GET /api/ext/domains
 * List active domains
 */
router.get('/domains', async (req, res) => {
    try {
        const domains = await domainService.getActiveDomains();
        res.json({ success: true, data: domains });
    } catch (error) {
        console.error('Ext API - Error fetching domains:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch domains' });
    }
});

/**
 * POST /api/ext/domains
 * Add a new domain (add-only; no delete/disable exposed externally).
 * Body: { domain: string }
 * Triggers Postfix sync when POSTFIX_SYNC_ENABLED=true.
 */
router.post('/domains', async (req, res) => {
    try {
        const domain = (req.body?.domain || '').trim().toLowerCase();

        if (!domain) {
            return res.status(400).json({ success: false, error: 'Domain is required' });
        }

        // Validate domain format (same rule as admin API)
        if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
            return res.status(400).json({ success: false, error: 'Invalid domain format' });
        }

        // Check duplicate
        const existing = await domainService.getDomainByName(domain);
        if (existing) {
            return res.status(409).json({ success: false, error: 'Domain already exists' });
        }

        const newDomain = await domainService.createDomain(domain);

        const syncResult = await postfixSync.syncPostfix();
        const payload = { success: true, data: newDomain };
        if (!syncResult.success && !syncResult.skipped) {
            payload.postfixSyncWarning = syncResult.error || 'Postfix config was not updated. Update virtual_mailbox_domains on the VPS manually.';
        }

        res.status(201).json(payload);
    } catch (error) {
        console.error('Ext API - Error creating domain:', error);
        res.status(500).json({ success: false, error: 'Failed to create domain' });
    }
});

/**
 * POST /api/ext/inbox/create
 * Create email inbox (random or custom)
 * Body: { domainId?: number, localPart?: string, gender?: string }
 * - domainId omitted → random domain from active list
 * - localPart omitted → random human-like name
 */
router.post('/inbox/create', async (req, res) => {
    try {
        let { domainId, localPart, gender } = req.body || {};

        // If no domainId, pick random active domain
        if (!domainId) {
            const domains = await domainService.getActiveDomains();
            if (domains.length === 0) {
                return res.status(400).json({ success: false, error: 'No active domains available' });
            }
            domainId = domains[Math.floor(Math.random() * domains.length)].id;
        }

        // Validate domain
        const domain = await domainService.getDomainById(domainId);
        if (!domain || !domain.is_active) {
            return res.status(400).json({ success: false, error: 'Invalid or inactive domain' });
        }

        // Generate localPart if not provided
        if (!localPart) {
            const firstNameResult = await namesService.getRandomNameByGender(gender || 'random');
            const lastNameResult = await namesService.getRandomNameByGender(firstNameResult.gender);
            const randomNum = Math.floor(Math.random() * 90) + 10;
            localPart = (firstNameResult.name && lastNameResult.name)
                ? `${firstNameResult.name}${lastNameResult.name}${randomNum}`
                : inboxService.generateRandomLocalPart();
        } else {
            // Validate custom local part
            if (!/^[a-zA-Z0-9._-]+$/.test(localPart)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid local part. Use only letters, numbers, dots, dashes, and underscores.',
                });
            }
        }

        const inbox = await inboxService.getOrCreateInbox(localPart, domainId);

        res.json({
            success: true,
            data: {
                email: `${inbox.local_part}@${inbox.domain}`,
                localPart: inbox.local_part,
                domain: inbox.domain,
                domainId: domainId,
                expiresAt: inbox.expires_at,
            },
        });
    } catch (error) {
        console.error('Ext API - Error creating inbox:', error);
        res.status(500).json({ success: false, error: 'Failed to create email' });
    }
});

/**
 * GET /api/ext/inbox/:address
 * Get emails for an address
 */
router.get('/inbox/:address', async (req, res) => {
    try {
        const { address } = req.params;

        if (!address.includes('@')) {
            return res.status(400).json({ success: false, error: 'Invalid email address format' });
        }

        const inbox = await inboxService.getInboxByAddress(address);

        if (!inbox) {
            return res.json({
                success: true,
                data: { email: address, emails: [], expiresAt: null },
            });
        }

        const emails = await inboxService.getInboxEmails(inbox.id);

        res.json({
            success: true,
            data: {
                email: address,
                emails: emails.map((e) => ({
                    id: e.id,
                    from: e.from_address,
                    subject: e.subject,
                    preview: e.body_text?.substring(0, 100) || '',
                    hasAttachment: e.has_attachment,
                    receivedAt: e.received_at,
                })),
                expiresAt: inbox.expires_at,
            },
        });
    } catch (error) {
        console.error('Ext API - Error fetching inbox:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch inbox' });
    }
});

/**
 * GET /api/ext/inbox/:address/latest
 * Get most recent email for an address
 */
router.get('/inbox/:address/latest', async (req, res) => {
    try {
        const { address } = req.params;

        if (!address.includes('@')) {
            return res.status(400).json({ success: false, error: 'Invalid email address format' });
        }

        const inbox = await inboxService.getInboxByAddress(address);

        if (!inbox) {
            return res.json({ success: true, data: null });
        }

        const emails = await inboxService.getInboxEmails(inbox.id);
        const latest = emails[0] || null;

        if (!latest) {
            return res.json({ success: true, data: null });
        }

        res.json({
            success: true,
            data: {
                id: latest.id,
                from: latest.from_address,
                subject: latest.subject,
                bodyText: latest.body_text,
                bodyHtml: latest.body_html,
                hasAttachment: latest.has_attachment,
                receivedAt: latest.received_at,
            },
        });
    } catch (error) {
        console.error('Ext API - Error fetching latest email:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch latest email' });
    }
});

/**
 * GET /api/ext/inbox/:address/otp
 * Extract OTP code from latest email
 */
router.get('/inbox/:address/otp', async (req, res) => {
    try {
        const { address } = req.params;

        if (!address.includes('@')) {
            return res.status(400).json({ success: false, error: 'Invalid email address format' });
        }

        const inbox = await inboxService.getInboxByAddress(address);

        if (!inbox) {
            return res.json({
                success: true,
                data: { email: address, otp: null, from: null, subject: null },
            });
        }

        const emails = await inboxService.getInboxEmails(inbox.id);

        // Try to find OTP from most recent email first, then fallback to older ones
        for (const email of emails) {
            const otp = otpExtract.extractOtp(email.body_text, email.body_html, email.subject);
            if (otp) {
                return res.json({
                    success: true,
                    data: {
                        email: address,
                        otp,
                        from: email.from_address,
                        subject: email.subject,
                        receivedAt: email.received_at,
                    },
                });
            }
        }

        // No OTP found in any email
        res.json({
            success: true,
            data: { email: address, otp: null, from: null, subject: null },
        });
    } catch (error) {
        console.error('Ext API - Error extracting OTP:', error);
        res.status(500).json({ success: false, error: 'Failed to extract OTP' });
    }
});

/**
 * GET /api/ext/email/:id
 * Get single email detail
 */
router.get('/email/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ success: false, error: 'Invalid email id' });
        }

        const email = await inboxService.getEmailById(id);

        if (!email) {
            return res.status(404).json({ success: false, error: 'Email not found' });
        }

        res.json({
            success: true,
            data: {
                id: email.id,
                to: `${email.local_part}@${email.domain}`,
                from: email.from_address,
                subject: email.subject,
                bodyText: email.body_text,
                bodyHtml: email.body_html,
                hasAttachment: email.has_attachment,
                receivedAt: email.received_at,
            },
        });
    } catch (error) {
        console.error('Ext API - Error fetching email:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch email' });
    }
});

/**
 * DELETE /api/ext/inbox/:address
 * Delete inbox and all its emails
 */
router.delete('/inbox/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const inbox = await inboxService.getInboxByAddress(address);

        if (!inbox) {
            return res.status(404).json({ success: false, error: 'Inbox not found' });
        }

        await inboxService.deleteInbox(inbox.id);
        res.json({ success: true, message: 'Inbox deleted successfully' });
    } catch (error) {
        console.error('Ext API - Error deleting inbox:', error);
        res.status(500).json({ success: false, error: 'Failed to delete inbox' });
    }
});

export default router;

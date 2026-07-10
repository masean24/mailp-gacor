import { Router } from 'express';
import domainService from '../services/domain.js';
import inboxService from '../services/inbox.js';
import inboxAccessService from '../services/inboxAccess.js';
import namesService from '../services/names.js';
import otpExtract from '../services/otpExtract.js';
import apiKeyAuth from '../middleware/apiKeyAuth.js';

const router = Router();
const isActiveDomain = (domain) => domain?.is_active && domain?.verification_status === 'active';

// External API is deliberately limited to public inboxes. Its API key must
// never become a bypass for a password-reserved address.
const requirePublicInbox = async (res, address) => {
    if (!(await inboxAccessService.isAddressProtected(address))) return true;
    res.status(423).json({
        success: false,
        error: 'Inbox is protected and cannot be accessed through the external API',
        requiresPassword: true,
    });
    return false;
};

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
 * Creates a pending domain. DNS verification and Postfix activation must be
 * completed in the admin dashboard before it can receive email.
 */
router.post('/domains', async (req, res) => {
    try {
        const domain = (req.body?.domain || '').trim().toLowerCase();

        if (!domain) {
            return res.status(400).json({ success: false, error: 'Domain is required' });
        }

        if (!domainService.DOMAIN_PATTERN.test(domain)) {
            return res.status(400).json({ success: false, error: 'Invalid domain format' });
        }

        // Check duplicate
        const existing = await domainService.getDomainByName(domain);
        if (existing) {
            return res.status(409).json({ success: false, error: 'Domain already exists' });
        }

        const newDomain = await domainService.createDomain(domain);
        res.status(201).json({
            success: true,
            data: newDomain,
            setup: domainService.getVerificationInstructions(newDomain),
            message: 'Domain is pending DNS verification and admin activation.',
        });
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
        if (!isActiveDomain(domain)) {
            return res.status(400).json({ success: false, error: 'Invalid or inactive domain' });
        }

        // Generate localPart if not provided. Never return a reserved address
        // to the API, even by chance.
        if (!localPart) {
            for (let attempt = 0; attempt < 5; attempt += 1) {
                const firstNameResult = await namesService.getRandomNameByGender(gender || 'random');
                const lastNameResult = await namesService.getRandomNameByGender(firstNameResult.gender);
                const randomNum = Math.floor(Math.random() * 90) + 10;
                const candidate = (firstNameResult.name && lastNameResult.name)
                    ? `${firstNameResult.name}${lastNameResult.name}${randomNum}`
                    : inboxService.generateRandomLocalPart();
                if (!(await inboxAccessService.isAddressProtected(`${candidate}@${domain.domain}`))) {
                    localPart = candidate;
                    break;
                }
            }
            if (!localPart) {
                return res.status(503).json({ success: false, error: 'Unable to generate a public email. Please try again.' });
            }
        } else {
            // Validate custom local part
            if (!/^[a-zA-Z0-9._-]+$/.test(localPart)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid local part. Use only letters, numbers, dots, dashes, and underscores.',
                });
            }
        }

        if (!(await requirePublicInbox(res, `${localPart}@${domain.domain}`))) return;

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
        if (!(await requirePublicInbox(res, address))) return;

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
                    // Use the OTP extracted once at ingest. Fall back to a live
                    // parse only for legacy rows saved before otp_code existed.
                    otp: e.otp_code || otpExtract.extractOtp(e.body_text, e.body_html, e.subject) || null,
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
        if (!(await requirePublicInbox(res, address))) return;

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
 * GET /api/ext/inbox/:address/otp/latest
 * Lightweight polling endpoint: returns the latest email that already has a
 * stored otp_code. Queries a single indexed row and does NOT parse bodies,
 * so it's cheap to poll under high concurrency. Returns data:null if none yet.
 */
router.get('/inbox/:address/otp/latest', async (req, res) => {
    try {
        const { address } = req.params;

        if (!address.includes('@')) {
            return res.status(400).json({ success: false, error: 'Invalid email address format' });
        }
        if (!(await requirePublicInbox(res, address))) return;

        const inbox = await inboxService.getInboxByAddress(address);

        if (!inbox) {
            return res.json({ success: true, data: null });
        }

        const email = await inboxService.getLatestOtpEmail(inbox.id);

        if (!email) {
            return res.json({ success: true, data: null });
        }

        res.json({
            success: true,
            data: {
                email: address,
                otp: email.otp_code,
                from: email.from_address,
                subject: email.subject,
                receivedAt: email.received_at,
            },
        });
    } catch (error) {
        console.error('Ext API - Error fetching latest OTP:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch latest OTP' });
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
        if (!(await requirePublicInbox(res, address))) return;

        const inbox = await inboxService.getInboxByAddress(address);

        if (!inbox) {
            return res.json({
                success: true,
                data: { email: address, otp: null, from: null, subject: null },
            });
        }

        const emails = await inboxService.getInboxEmails(inbox.id);

        // Try to find OTP from most recent email first, then fallback to older ones.
        // Prefer the stored otp_code; only re-parse bodies for legacy rows that
        // were saved before otp_code existed.
        for (const email of emails) {
            const otp = email.otp_code || otpExtract.extractOtp(email.body_text, email.body_html, email.subject);
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

        if (!(await requirePublicInbox(res, `${email.local_part}@${email.domain}`))) return;

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
        if (!(await requirePublicInbox(res, address))) return;
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

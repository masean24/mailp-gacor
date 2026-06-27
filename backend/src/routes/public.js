import { Router } from 'express';
import domainService from '../services/domain.js';
import inboxService from '../services/inbox.js';
import namesService from '../services/names.js';
import otpExtract from '../services/otpExtract.js';

const router = Router();

/**
 * GET /api/domains
 * Get list of active domains
 */
router.get('/domains', async (req, res) => {
    try {
        const domains = await domainService.getActiveDomains();
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
 * POST /api/inbox/generate
 * Generate random email address using human names
 * Body: { domainId: number }
 */
router.post('/inbox/generate', async (req, res) => {
    try {
        const { domainId } = req.body;

        if (!domainId) {
            return res.status(400).json({
                success: false,
                error: 'domainId is required',
            });
        }

        // Check if domain exists and is active
        const domain = await domainService.getDomainById(domainId);
        if (!domain || !domain.is_active) {
            return res.status(400).json({
                success: false,
                error: 'Invalid or inactive domain',
            });
        }

        // Generate random local part using two human names (firstname + lastname) + 2 digits
        // Gender matching: if male, both names are male. if female, both names are female.
        const { gender } = req.body;
        const firstNameResult = await namesService.getRandomNameByGender(gender || 'random');
        const lastNameResult = await namesService.getRandomNameByGender(firstNameResult.gender);

        const randomNum = Math.floor(Math.random() * 90) + 10; // 2-digit number (10-99)
        const localPart = (firstNameResult.name && lastNameResult.name)
            ? `${firstNameResult.name}${lastNameResult.name}${randomNum}`
            : inboxService.generateRandomLocalPart();

        // Create inbox
        const inbox = await inboxService.getOrCreateInbox(localPart, domainId);

        res.json({
            success: true,
            data: {
                email: `${inbox.local_part}@${inbox.domain}`,
                localPart: inbox.local_part,
                domain: inbox.domain,
                expiresAt: inbox.expires_at,
            },
        });
    } catch (error) {
        console.error('Error generating inbox:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate email address',
        });
    }
});

/**
 * POST /api/inbox/custom
 * Create inbox with custom local part
 * Body: { localPart: string, domainId: number }
 */
router.post('/inbox/custom', async (req, res) => {
    try {
        const { localPart, domainId } = req.body;

        if (!localPart || !domainId) {
            return res.status(400).json({
                success: false,
                error: 'localPart and domainId are required',
            });
        }

        // Validate local part (alphanumeric, dash, underscore, dot)
        if (!/^[a-zA-Z0-9._-]+$/.test(localPart)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid email format. Use only letters, numbers, dots, dashes, and underscores.',
            });
        }

        // Check if domain exists and is active
        const domain = await domainService.getDomainById(domainId);
        if (!domain || !domain.is_active) {
            return res.status(400).json({
                success: false,
                error: 'Invalid or inactive domain',
            });
        }

        // Create inbox
        const inbox = await inboxService.getOrCreateInbox(localPart, domainId);

        res.json({
            success: true,
            data: {
                email: `${inbox.local_part}@${inbox.domain}`,
                localPart: inbox.local_part,
                domain: inbox.domain,
                expiresAt: inbox.expires_at,
            },
        });
    } catch (error) {
        console.error('Error creating custom inbox:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create email address',
        });
    }
});

/**
 * GET /api/otp/:address
 * Get inbox emails with extracted OTP codes (for OTP Finder page)
 */
router.get('/otp/:address', async (req, res) => {
    try {
        const { address } = req.params;

        if (!address.includes('@')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid email address format',
            });
        }

        const inbox = await inboxService.getInboxByAddress(address);

        if (!inbox) {
            return res.json({
                success: true,
                data: {
                    email: address,
                    items: [],
                },
            });
        }

        const emails = await inboxService.getInboxEmails(inbox.id);

        const items = emails.map((e) => ({
            id: e.id,
            from: e.from_address,
            subject: e.subject,
            receivedAt: e.received_at,
            // Prefer OTP extracted at ingest; re-parse only legacy rows.
            otp: e.otp_code || otpExtract.extractOtp(e.body_text, e.body_html, e.subject) || null,
        }));

        res.json({
            success: true,
            data: {
                email: address,
                items,
            },
        });
    } catch (error) {
        console.error('Error fetching OTP:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch OTP',
        });
    }
});

/**
 * GET /api/inbox/:address
 * Get emails for an address
 */
router.get('/inbox/:address', async (req, res) => {
    try {
        const { address } = req.params;

        // Validate email format
        if (!address.includes('@')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid email address format',
            });
        }

        const inbox = await inboxService.getInboxByAddress(address);

        if (!inbox) {
            // Return empty inbox (address might exist but no emails yet)
            return res.json({
                success: true,
                data: {
                    email: address,
                    emails: [],
                    expiresAt: null,
                },
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
                    // Prefer OTP extracted at ingest; re-parse only legacy rows.
                    otp: e.otp_code || otpExtract.extractOtp(e.body_text, e.body_html, e.subject) || null,
                    hasAttachment: e.has_attachment,
                    receivedAt: e.received_at,
                })),
                expiresAt: inbox.expires_at,
            },
        });
    } catch (error) {
        console.error('Error fetching inbox:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch inbox',
        });
    }
});

/**
 * GET /api/email/:id
 * Get single email detail
 */
router.get('/email/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid email id',
            });
        }

        const email = await inboxService.getEmailById(id);

        if (!email) {
            return res.status(404).json({
                success: false,
                error: 'Email not found',
            });
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
        console.error('Error fetching email:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch email',
        });
    }
});

/**
 * DELETE /api/inbox/:address
 * Delete inbox and all emails
 */
router.delete('/inbox/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const inbox = await inboxService.getInboxByAddress(address);

        if (!inbox) {
            return res.status(404).json({
                success: false,
                error: 'Inbox not found',
            });
        }

        await inboxService.deleteInbox(inbox.id);

        res.json({
            success: true,
            message: 'Inbox deleted successfully',
        });
    } catch (error) {
        console.error('Error deleting inbox:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete inbox',
        });
    }
});

export default router;

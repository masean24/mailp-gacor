import { Router } from 'express';
import domainService from '../services/domain.js';
import inboxService from '../services/inbox.js';
import inboxAccessService from '../services/inboxAccess.js';
import namesService from '../services/names.js';
import otpExtract from '../services/otpExtract.js';
import inboxUnlockRateLimit from '../middleware/inboxUnlockRateLimit.js';

const router = Router();
const LOCAL_PART_PATTERN = /^[a-zA-Z0-9._-]+$/;

const isActiveDomain = (domain) => domain?.is_active && domain?.verification_status === 'active';

const sendLocked = (res) => res.status(423).json({
    success: false,
    error: 'Inbox is protected',
    requiresPassword: true,
});

const requireInboxAccess = async (req, res, address) => {
    const access = await inboxAccessService.checkInboxAccess(req, address);
    if (!access.allowed) {
        sendLocked(res);
        return false;
    }
    return true;
};

const inboxPayload = (inbox, emails) => ({
    email: `${inbox.local_part}@${inbox.domain}`,
    emails: emails.map((email) => ({
        id: email.id,
        from: email.from_address,
        subject: email.subject,
        preview: email.body_text?.substring(0, 100) || '',
        otp: email.otp_code || otpExtract.extractOtp(email.body_text, email.body_html, email.subject) || null,
        hasAttachment: email.has_attachment,
        receivedAt: email.received_at,
    })),
    expiresAt: inbox.expires_at,
});

/** GET /api/domains - list domains that are ready to receive email. */
router.get('/domains', async (req, res) => {
    try {
        const domains = await domainService.getActiveDomains();
        res.json({ success: true, data: domains });
    } catch (error) {
        console.error('Error fetching domains:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch domains' });
    }
});

/** POST /api/inbox/generate - create a public random inbox. */
router.post('/inbox/generate', async (req, res) => {
    try {
        const { domainId, gender } = req.body;
        if (!domainId) return res.status(400).json({ success: false, error: 'domainId is required' });

        const domain = await domainService.getDomainById(domainId);
        if (!isActiveDomain(domain)) {
            return res.status(400).json({ success: false, error: 'Invalid or inactive domain' });
        }

        let inbox;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const firstName = await namesService.getRandomNameByGender(gender || 'random');
            const lastName = await namesService.getRandomNameByGender(firstName.gender);
            const randomNum = Math.floor(Math.random() * 90) + 10;
            const localPart = (firstName.name && lastName.name)
                ? `${firstName.name}${lastName.name}${randomNum}`
                : inboxService.generateRandomLocalPart();

            if (await inboxAccessService.isAddressProtected(`${localPart}@${domain.domain}`)) continue;
            inbox = await inboxService.getOrCreateInbox(localPart, domainId);
            break;
        }

        if (!inbox) {
            return res.status(503).json({ success: false, error: 'Unable to generate a public email. Please try again.' });
        }

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
        res.status(500).json({ success: false, error: 'Failed to generate email address' });
    }
});

/** POST /api/inbox/custom - create/use a public custom inbox. */
router.post('/inbox/custom', async (req, res) => {
    try {
        const { localPart, domainId } = req.body;
        if (!localPart || !domainId) {
            return res.status(400).json({ success: false, error: 'localPart and domainId are required' });
        }
        if (!LOCAL_PART_PATTERN.test(localPart)) {
            return res.status(400).json({ success: false, error: 'Invalid email format. Use only letters, numbers, dots, dashes, and underscores.' });
        }

        const domain = await domainService.getDomainById(domainId);
        if (!isActiveDomain(domain)) {
            return res.status(400).json({ success: false, error: 'Invalid or inactive domain' });
        }

        const address = `${localPart}@${domain.domain}`;
        if (!(await requireInboxAccess(req, res, address))) return;

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
        res.status(500).json({ success: false, error: 'Failed to create email address' });
    }
});

/**
 * POST /api/inbox/reserve
 * Body: { localPart, domainId, password }. This is intentionally separate
 * from the public custom endpoint so a password is never optional by mistake.
 */
router.post('/inbox/reserve', async (req, res) => {
    try {
        const { localPart, domainId, password } = req.body;
        if (!localPart || !domainId || !password) {
            return res.status(400).json({ success: false, error: 'localPart, domainId, and password are required' });
        }
        if (!LOCAL_PART_PATTERN.test(localPart)) {
            return res.status(400).json({ success: false, error: 'Invalid email format. Use only letters, numbers, dots, dashes, and underscores.' });
        }
        if (typeof password !== 'string' || password.length < 10 || password.length > 256) {
            return res.status(400).json({ success: false, error: 'Password must be between 10 and 256 characters' });
        }

        const ipHash = inboxAccessService.hashClientIp(req.ip || req.connection?.remoteAddress);
        const { inbox, reservation } = await inboxAccessService.reserveAddress({
            localPart,
            domainId,
            password,
            actorType: 'public',
            ipHash,
        });
        const access = await inboxAccessService.unlockAddress({
            address: `${inbox.local_part}@${inbox.domain}`,
            password,
            ipHash,
        });
        res.status(201).json({
            success: true,
            data: {
                email: `${inbox.local_part}@${inbox.domain}`,
                localPart: inbox.local_part,
                domain: inbox.domain,
                expiresAt: inbox.expires_at,
                protected: true,
                accessToken: access.token,
                accessExpiresIn: access.expiresIn,
                reservationExpiresAt: reservation.expires_at,
            },
        });
    } catch (error) {
        const status = error.code === 'RESERVATION_QUOTA' ? 429
            : ['ALREADY_RESERVED', 'INBOX_HAS_EMAILS'].includes(error.code) ? 409
            : error.code === 'DOMAIN_UNAVAILABLE' ? 400 : 500;
        if (status === 500) console.error('Error reserving inbox:', error);
        res.status(status).json({ success: false, error: error.message || 'Failed to reserve inbox' });
    }
});

/** POST /api/inbox/:address/unlock - exchange password for short-lived access. */
router.post('/inbox/:address/unlock', inboxUnlockRateLimit(), async (req, res) => {
    try {
        const { address } = req.params;
        const { password } = req.body;
        if (!address.includes('@') || typeof password !== 'string') {
            return res.status(400).json({ success: false, error: 'Email address and password are required' });
        }

        const access = await inboxAccessService.unlockAddress({
            address,
            password,
            ipHash: inboxAccessService.hashClientIp(req.ip || req.connection?.remoteAddress),
        });
        res.json({ success: true, data: { accessToken: access.token, expiresIn: access.expiresIn } });
    } catch (error) {
        if (error.code === 'INVALID_PASSWORD') {
            return res.status(401).json({ success: false, error: 'Invalid email address or password' });
        }
        console.error('Error unlocking inbox:', error);
        res.status(500).json({ success: false, error: 'Failed to unlock inbox' });
    }
});

/** GET /api/otp/:address - OTP Finder endpoint. */
router.get('/otp/:address', async (req, res) => {
    try {
        const { address } = req.params;
        if (!address.includes('@')) return res.status(400).json({ success: false, error: 'Invalid email address format' });
        if (!(await requireInboxAccess(req, res, address))) return;

        const inbox = await inboxService.getInboxByAddress(address);
        if (!inbox) return res.json({ success: true, data: { email: address, items: [] } });

        const emails = await inboxService.getInboxEmails(inbox.id);
        res.json({
            success: true,
            data: {
                email: address,
                items: emails.map((email) => ({
                    id: email.id,
                    from: email.from_address,
                    subject: email.subject,
                    receivedAt: email.received_at,
                    otp: email.otp_code || otpExtract.extractOtp(email.body_text, email.body_html, email.subject) || null,
                })),
            },
        });
    } catch (error) {
        console.error('Error fetching OTP:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch OTP' });
    }
});

/** GET /api/inbox/:address - list inbox email. */
router.get('/inbox/:address', async (req, res) => {
    try {
        const { address } = req.params;
        if (!address.includes('@')) return res.status(400).json({ success: false, error: 'Invalid email address format' });
        if (!(await requireInboxAccess(req, res, address))) return;

        const inbox = await inboxService.getInboxByAddress(address);
        if (!inbox) return res.json({ success: true, data: { email: address, emails: [], expiresAt: null } });

        const emails = await inboxService.getInboxEmails(inbox.id);
        res.json({ success: true, data: inboxPayload(inbox, emails) });
    } catch (error) {
        console.error('Error fetching inbox:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch inbox' });
    }
});

/** GET /api/email/:id - detail is authorised against the email's own inbox. */
router.get('/email/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, error: 'Invalid email id' });

        const email = await inboxService.getEmailById(id);
        if (!email) return res.status(404).json({ success: false, error: 'Email not found' });

        const address = `${email.local_part}@${email.domain}`;
        if (!(await requireInboxAccess(req, res, address))) return;

        res.json({
            success: true,
            data: {
                id: email.id,
                to: address,
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
        res.status(500).json({ success: false, error: 'Failed to fetch email' });
    }
});

/** DELETE /api/inbox/:address - delete a public or unlocked protected inbox. */
router.delete('/inbox/:address', async (req, res) => {
    try {
        const { address } = req.params;
        if (!(await requireInboxAccess(req, res, address))) return;

        const inbox = await inboxService.getInboxByAddress(address);
        if (!inbox) return res.status(404).json({ success: false, error: 'Inbox not found' });

        await inboxService.deleteInbox(inbox.id);
        res.json({ success: true, message: 'Inbox deleted successfully' });
    } catch (error) {
        console.error('Error deleting inbox:', error);
        res.status(500).json({ success: false, error: 'Failed to delete inbox' });
    }
});

export default router;

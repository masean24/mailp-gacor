#!/usr/bin/env node
/**
 * Postfix Pipe Handler
 * This script receives raw email from Postfix via stdin
 * and inserts it into the database
 * 
 * IMPORTANT: dotenv must be loaded BEFORE any other imports
 * because database.js reads process.env.DATABASE_URL on import
 */

// Load environment variables FIRST
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });

// Now import other modules (after dotenv is loaded)
import { parseEmail } from '../services/emailParser.js';
import inboxService from '../services/inbox.js';
import domainService from '../services/domain.js';
import discordService from '../services/discord.js';
import telegramService from '../services/telegram.js';
import otpExtract from '../services/otpExtract.js';
import inboxAccessService from '../services/inboxAccess.js';
import db from '../config/database.js';

/**
 * Read stdin as buffer
 */
async function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
        process.stdin.on('error', reject);
    });
}

/**
 * Main handler
 */
async function main() {
    try {
        // Read raw email from stdin
        const rawEmail = await readStdin();

        if (!rawEmail || rawEmail.length === 0) {
            console.error('No email data received');
            process.exit(1);
        }

        // Reject oversized emails. Exit 0 (success) so Postfix does NOT keep
        // retrying / deferring a message that will always be too big.
        const maxBytes = parseInt(process.env.MAX_EMAIL_BYTES, 10) || 1048576; // 1MB default
        if (rawEmail.length > maxBytes) {
            console.error(`Email too large: ${rawEmail.length} bytes > MAX_EMAIL_BYTES ${maxBytes}. Dropping.`);
            process.exit(0); // graceful drop — no Postfix retry loop
        }

        console.log(`📧 Received email (${rawEmail.length} bytes)`);

        // Parse email
        const parsed = await parseEmail(rawEmail);
        console.log(`📧 To: ${parsed.to}`);
        console.log(`📧 From: ${parsed.from}`);
        console.log(`📧 Subject: ${parsed.subject}`);

        // Extract local part and domain from "to" address
        const [localPart, domainName] = parsed.to.split('@');

        if (!localPart || !domainName) {
            console.error('Invalid recipient address:', parsed.to);
            process.exit(1);
        }

        // Find domain in database
        const domain = await domainService.getDomainByName(domainName);

        if (!domain) {
            console.error('Domain not found:', domainName);
            process.exit(0); // Exit gracefully - domain not registered
        }

        if (!domain.is_active || domain.verification_status !== 'active') {
            console.error('Domain is inactive:', domainName);
            process.exit(0);
        }

        // Get or create inbox
        const inbox = await inboxService.getOrCreateInbox(localPart, domain.id);
        console.log(`📬 Inbox ID: ${inbox.id}`);

        // Extract OTP ONCE at ingest time, then persist it on the email row so
        // read/polling endpoints never have to re-parse bodies per request.
        const otp = otpExtract.extractOtp(parsed.text, parsed.html, parsed.subject);

        // Insert email (with extracted otp_code)
        const email = await inboxService.insertEmail(inbox.id, {
            from: parsed.from,
            subject: parsed.subject,
            text: parsed.text,
            html: parsed.html,
            hasAttachment: parsed.hasAttachment,
            otpCode: otp || null,
        });

        console.log(`✅ Email saved with ID: ${email.id}${otp ? ` (OTP: ${otp})` : ''}`);

        // Notifications are best-effort and must NOT slow down or fail email
        // ingestion. The email is already saved above. Fire both with a short
        // timeout and wait only briefly so the Postfix pipe process can exit
        // promptly even under high concurrency.
        const NOTIFY_TIMEOUT_MS = parseInt(process.env.NOTIFY_TIMEOUT_MS, 10) || 3000;

        const withTimeout = (promise, label) =>
            Promise.race([
                Promise.resolve()
                    .then(() => promise)
                    .catch((err) => console.error(`⚠️ ${label} failed:`, err.message)),
                new Promise((resolve) =>
                    setTimeout(() => {
                        console.error(`⚠️ ${label} timed out after ${NOTIFY_TIMEOUT_MS}ms`);
                        resolve();
                    }, NOTIFY_TIMEOUT_MS)
                ),
            ]);

        // Sender, subject, and OTP notifications would otherwise bypass the
        // protected inbox password, so protected addresses stay silent here.
        if (await inboxAccessService.isAddressProtected(parsed.to)) {
            console.log('Protected inbox: external notifications skipped');
        } else {
            await Promise.all([
                withTimeout(
                    discordService.sendNewEmailNotification(parsed.to, parsed.from),
                    'Discord notify'
                ),
                withTimeout(
                    telegramService.notifyNewEmail(parsed.to, parsed.from, parsed.subject, otp),
                    'Telegram notify'
                ),
            ]);
        }

        // Close database connection
        await db.end();
        process.exit(0);
    } catch (error) {
        console.error('❌ Error processing email:', error);
        process.exit(1);
    }
}

main();

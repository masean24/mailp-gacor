import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';

import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';
import externalRoutes from './routes/external.js';
import rateLimit from './middleware/rateLimit.js';
import cleanupService from './services/cleanup.js';
import telegramService from './services/telegram.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
const allowedOrigins = configuredOrigins.length > 0
    ? configuredOrigins
    : (process.env.NODE_ENV === 'production' ? [] : ['http://localhost:5173']);

// Middleware
app.set('trust proxy', 1);
app.use(cors({
    origin(origin, callback) {
        // Same-origin server requests and API clients have no Origin header.
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed by CORS'));
    },
}));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
});
app.use(express.json());

// Routes
//
// IMPORTANT: route order matters for rate limiting.
// External API (/api/ext) is mounted FIRST and carries its own per-API-key
// rate limit (API_RATE_LIMIT_MAX) inside apiKeyAuth(). It must NOT be subject
// to the public IP rate limit (RATE_LIMIT_MAX_REQUESTS) so automation clients
// hitting high concurrency are governed only by API_RATE_LIMIT_MAX.
//
// Because Express matches mounts in registration order and a matched ext route
// sends its response, /api/ext traffic never falls through to the public
// limiter mounted on '/api' below.
app.use('/api/ext', externalRoutes);

// Admin keeps the public IP rate limiter (it is also JWT protected).
app.use('/api/admin', rateLimit(), adminRoutes);

// Public routes: governed by the public IP rate limit (RATE_LIMIT_MAX_REQUESTS).
app.use('/api', rateLimit(), publicRoutes);

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Not found',
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
    });
});

// Cron job - cleanup expired inboxes every hour
cron.schedule('0 * * * *', async () => {
    console.log('🧹 Running scheduled cleanup...');
    try {
        const releasedReservations = await cleanupService.cleanupExpiredReservations();
        const deletedCount = await cleanupService.cleanupExpiredInboxes();
        console.log(`Released ${releasedReservations} expired reservations.`);
        console.log(`🧹 Cleanup completed. Deleted ${deletedCount} expired inboxes.`);
    } catch (error) {
        console.error('❌ Cleanup failed:', error);
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`
  ╔═══════════════════════════════════════════════╗
  ║                                               ║
  ║   🚀 Hubify Mail API Server                   ║
  ║   Running on http://localhost:${PORT}           ║
  ║                                               ║
  ╚═══════════════════════════════════════════════╝
  `);

    // Start Telegram bot.
    // Under PM2 cluster mode, only ONE worker may run the long-polling bot;
    // otherwise Telegram returns 409 (getUpdates conflict). PM2 sets
    // NODE_APP_INSTANCE per worker, so we start the bot only on instance "0".
    // In single-process mode (no PM2) NODE_APP_INSTANCE is undefined → bot runs.
    const appInstance = process.env.NODE_APP_INSTANCE;
    if (appInstance === undefined || appInstance === '0') {
        telegramService.startBot();
    } else {
        console.log(`ℹ️  Telegram bot skipped on worker ${appInstance} (runs only on instance 0)`);
    }
});

export default app;

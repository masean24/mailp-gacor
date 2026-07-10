const attempts = new Map();

const getClientIp = (req) => req.ip || req.connection?.remoteAddress || 'unknown';

/** Limit password guesses by both client IP and requested address. */
export const inboxUnlockRateLimit = (options = {}) => {
    const windowMs = options.windowMs || parseInt(process.env.INBOX_UNLOCK_WINDOW_MS, 10) || 60000;
    const maxAttempts = options.max || parseInt(process.env.INBOX_UNLOCK_MAX_ATTEMPTS, 10) || 5;

    return (req, res, next) => {
        const key = `${getClientIp(req)}:${String(req.params.address || '').toLowerCase()}`;
        const now = Date.now();
        const record = attempts.get(key);

        if (!record || now - record.startedAt >= windowMs) {
            attempts.set(key, { count: 1, startedAt: now });
            return next();
        }

        if (record.count >= maxAttempts) {
            return res.status(429).json({
                success: false,
                error: 'Too many password attempts. Please try again later.',
                retryAfter: Math.ceil((record.startedAt + windowMs - now) / 1000),
            });
        }

        record.count += 1;
        next();
    };
};

export default inboxUnlockRateLimit;

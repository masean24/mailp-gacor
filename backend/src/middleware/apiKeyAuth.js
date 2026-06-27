/**
 * API Key Authentication Middleware
 * Validates X-API-Key header against the configured API_KEY.
 * Used for external programmatic API access (/api/ext/*).
 */

const apiKeyStore = new Map();

const apiKeyAuth = (options = {}) => {
    const windowMs = options.windowMs || 60000;
    const maxRequests = options.max || parseInt(process.env.API_RATE_LIMIT_MAX) || 5000;

    // Cleanup old entries every minute
    setInterval(() => {
        const now = Date.now();
        for (const [key, value] of apiKeyStore.entries()) {
            if (now - value.startTime > windowMs) {
                apiKeyStore.delete(key);
            }
        }
    }, 60000);

    return (req, res, next) => {
        const apiKey = req.headers['x-api-key'];
        const configuredKey = process.env.API_KEY;

        // Check if API key is configured
        if (!configuredKey) {
            return res.status(503).json({
                success: false,
                error: 'API key not configured on server',
            });
        }

        // Validate API key
        if (!apiKey || apiKey !== configuredKey) {
            return res.status(401).json({
                success: false,
                error: 'Invalid or missing API key. Set X-API-Key header.',
            });
        }

        // Rate limiting per API key
        const now = Date.now();
        if (!apiKeyStore.has(apiKey)) {
            apiKeyStore.set(apiKey, { count: 1, startTime: now });
            return next();
        }

        const record = apiKeyStore.get(apiKey);

        if (now - record.startTime > windowMs) {
            apiKeyStore.set(apiKey, { count: 1, startTime: now });
            return next();
        }

        if (record.count >= maxRequests) {
            return res.status(429).json({
                success: false,
                error: 'API rate limit exceeded.',
                retryAfter: Math.ceil((record.startTime + windowMs - now) / 1000),
            });
        }

        record.count++;
        next();
    };
};

export default apiKeyAuth;

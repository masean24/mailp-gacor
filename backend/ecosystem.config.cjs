/**
 * PM2 process configuration for the Hubify Mail backend.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 restart ecosystem.config.cjs --env production
 *
 * Cluster sizing:
 *   - PM2_INSTANCES controls worker count. Use "max" to span all CPU cores,
 *     or a number (e.g. 2). Defaults to 2 if unset.
 *   - Each worker opens its own PostgreSQL pool (PG_POOL_MAX connections).
 *     Make sure PostgreSQL max_connections >= PM2_INSTANCES * PG_POOL_MAX
 *     (plus headroom for the Postfix pipe handler and admin tools).
 *
 * IMPORTANT — Telegram bot:
 *   The Telegram long-polling bot starts inside src/index.js. Running it in
 *   every cluster worker would cause Telegram getUpdates conflicts (409).
 *   Set TELEGRAM_BOT_TOKEN only for a single-instance process, OR keep
 *   PM2_INSTANCES=1 if you rely on the bot. See docs for details.
 */

const instances = process.env.PM2_INSTANCES || 2;

module.exports = {
  apps: [
    {
      name: 'hubify-api',
      script: 'src/index.js',
      // cwd defaults to this file's directory so the relative script path and
      // the .env loaded by src/config/database.js (../../.env) resolve correctly.
      cwd: __dirname,
      instances,
      exec_mode: 'cluster',
      // Load .env from the backend directory. dotenv inside the app also loads
      // it, but declaring it here keeps env consistent across PM2 reloads.
      env_file: '.env',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '400M',
      // Give in-flight requests time to drain on reload.
      kill_timeout: 5000,
      wait_ready: false,
    },
  ],
};

import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env with absolute path (important for Postfix pipe)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });

const { Pool } = pg;

// Pool tuning via env for high-concurrency workloads.
// Defaults are conservative; raise PG_POOL_MAX for hundreds of concurrent
// polling clients (also size PostgreSQL max_connections accordingly).
const poolMax = parseInt(process.env.PG_POOL_MAX, 10) || 20;
const idleTimeoutMs = parseInt(process.env.PG_IDLE_TIMEOUT_MS, 10) || 30000;
const connectionTimeoutMs = parseInt(process.env.PG_CONNECTION_TIMEOUT_MS, 10) || 10000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: poolMax,
  idleTimeoutMillis: idleTimeoutMs,
  connectionTimeoutMillis: connectionTimeoutMs,
});

// Test connection
pool.on('connect', () => {
  console.log('📦 Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Database connection error:', err);
  process.exit(-1);
});

export default pool;

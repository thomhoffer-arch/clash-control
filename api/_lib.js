// ClashControl — Shared serverless utilities
// CORS handling and rate limiting used by all /api/* endpoints.
// The leading underscore prevents Vercel from routing this as an endpoint.

const ALLOWED_ORIGINS = [
  'https://www.clashcontrol.io',
  'http://localhost:3000',
  'http://localhost:5500',
];

function cors(req, res, methods) {
  var origin = req.headers.origin || '';
  // Exact-match required: substring/prefix matching lets attackers craft origins
  // like http://localhost:3000.evil.com that pass startsWith() checks.
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', (methods || 'POST') + ', OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CC-Consent');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

// In-memory rate limiter — resets per cold start, good enough for abuse prevention
var rateMap = {};
function rateLimit(ip, limit) {
  var now = Date.now();
  var bucket = rateMap[ip];
  if (!bucket || now - bucket.start > 60000) {
    rateMap[ip] = { start: now, count: 1 };
    return false;
  }
  bucket.count++;
  return bucket.count > limit;
}

function clientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
}

// Resolve a Postgres connection string from any of the env var names that
// Vercel Postgres / Neon / generic setups inject. Vercel Postgres auto-injects
// POSTGRES_URL (and several variants) when you link a database to the project.
function dbUrl() {
  return process.env.POSTGRES_URL
    || process.env.POSTGRES_URL_NON_POOLING
    || process.env.DATABASE_URL
    || null;
}

module.exports = { cors, rateLimit, clientIp, dbUrl };

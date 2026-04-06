// ClashControl — Health check endpoint
// Returns AI and DB connection status

var { cors, dbUrl } = require('./_lib');

module.exports = async function handler(req, res) {
  if (cors(req, res, 'GET')) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var status = { ai: false, db: false, model: null };

  // Check AI (Google AI Studio / Gemma 4)
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY) {
    status.ai = true;
    status.model = 'gemma-3-27b-it';
  }

  // Check DB (Vercel Postgres / Neon)
  var url = dbUrl();
  if (url) {
    try {
      var { neon } = require('@neondatabase/serverless');
      var sql = neon(url);
      await sql`SELECT 1`;
      status.db = true;
    } catch (e) {
      status.db = false;
    }
  }

  res.status(200).json(status);
};

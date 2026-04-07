// ClashControl — Health check endpoint
// Returns AI and DB connection status
// ?models=1 → also lists every Gemma/Gemini model the API key can call

var { cors, dbUrl } = require('./_lib');

module.exports = async function handler(req, res) {
  if (cors(req, res, 'GET')) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY || null;
  var status = { ai: false, db: false, model: null };

  // Check AI (Google AI Studio / Gemma)
  if (key) {
    status.ai = true;
    status.model = 'gemma-3-27b-it';
  }

  // Optional: list available models so we can discover the latest Gemma ID
  // without exposing the API key. Hit /api/health?models=1 in a browser.
  if (key && req.query && req.query.models) {
    try {
      var r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key));
      var data = await r.json();
      status.models = (data.models || [])
        .map(function(m) { return { name: m.name, displayName: m.displayName, methods: m.supportedGenerationMethods }; })
        .filter(function(m) { return /gemma|gemini/i.test(m.name); });
    } catch (e) {
      status.modelsError = String(e && e.message || e);
    }
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

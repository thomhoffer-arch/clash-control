#!/usr/bin/env node
// ── ClashControl Smart Bridge ─────────────────────────────────────
// Single binary that runs everything:
//   - WebSocket bridge to the browser (port 19802)
//   - REST API for ChatGPT / any LLM (port 19803)
//   - MCP server for Claude Desktop/Code (stdio, when --mcp flag is used)
//
// Usage:
//   ./clashcontrol-smart-bridge            # REST + WebSocket (default)
//   ./clashcontrol-smart-bridge --mcp      # MCP + WebSocket (for Claude Desktop)
//
// Claude Desktop config:
//   { "mcpServers": { "clashcontrol": {
//       "command": "/path/to/clashcontrol-smart-bridge", "args": ["--mcp"]
//   } } }

const http = require('http');
const WebSocket = require('ws');

const WS_PORT = 19802;
const REST_PORT = parseInt(process.env.PORT, 10) || 19803;
const REQUEST_TIMEOUT = 15000;
const MCP_MODE = process.argv.includes('--mcp');

// ── WebSocket bridge to browser ───────────────────────────────────

let wss = null;
let browserSocket = null;
let pendingRequests = new Map();
let requestId = 0;

function startWsBridge() {
  wss = new WebSocket.Server({ port: WS_PORT, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    browserSocket = ws;
    log('Browser connected via WebSocket');
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id != null && pendingRequests.has(msg.id)) {
          const req = pendingRequests.get(msg.id);
          clearTimeout(req.timer);
          pendingRequests.delete(msg.id);
          req.resolve(msg.result);
        }
      } catch (e) {
        log('Bad WS message: ' + e.message);
      }
    });
    ws.on('close', () => {
      browserSocket = null;
      log('Browser disconnected');
    });
  });
  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('WebSocket port ' + WS_PORT + ' in use — connecting as client');
      connectWsAsClient();
    } else {
      log('WebSocket error: ' + err.message);
    }
  });
}

function connectWsAsClient() {
  const ws = new WebSocket('ws://127.0.0.1:' + WS_PORT);
  ws.on('open', () => { browserSocket = ws; log('Connected to existing WebSocket bridge'); });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.id != null && pendingRequests.has(msg.id)) {
        const req = pendingRequests.get(msg.id);
        clearTimeout(req.timer);
        pendingRequests.delete(msg.id);
        req.resolve(msg.result);
      }
    } catch (e) {}
  });
  ws.on('close', () => { browserSocket = null; setTimeout(connectWsAsClient, 5000); });
  ws.on('error', () => {});
}

function sendToBrowser(action, params) {
  return new Promise((resolve, reject) => {
    if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) {
      reject(new Error('ClashControl is not connected. Open clashcontrol.io and enable the Smart Bridge addon.'));
      return;
    }
    const id = ++requestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Request timed out'));
    }, REQUEST_TIMEOUT);
    pendingRequests.set(id, { resolve, reject, timer });
    browserSocket.send(JSON.stringify({ id, action, params: params || {} }));
  });
}

// Logging helper — MCP mode writes to stderr (stdout is for MCP protocol)
function log(msg) {
  const line = '[Smart Bridge] ' + msg + '\n';
  if (MCP_MODE) process.stderr.write(line);
  else process.stdout.write(line);
}

// ── Tool definitions (shared by REST and MCP) ─────────────────────

const TOOLS = {
  get_status:          { desc: 'Get current state: loaded models, clash count, active project, detection rules.', params: {} },
  get_clashes:         { desc: 'Get the clash list with details.', params: { status: {t:'string',e:['open','resolved','all']}, limit: {t:'number'} } },
  get_issues:          { desc: 'Get the issues list.', params: { limit: {t:'number'} } },
  run_detection:       { desc: 'Run clash detection between model groups.', params: { modelA: {t:'string',r:1,d:'First side: model name, discipline, or "all". Use "+" for groups.'}, modelB: {t:'string',r:1,d:'Second side'}, maxGap: {t:'number',d:'Gap mm'}, hard: {t:'boolean'}, excludeSelf: {t:'boolean'} } },
  set_detection_rules: { desc: 'Update detection settings without running.', params: { maxGap: {t:'number'}, hard: {t:'boolean'}, excludeSelf: {t:'boolean'}, duplicates: {t:'boolean'} } },
  update_clash:        { desc: 'Update a specific clash.', params: { clashIndex: {t:'number',r:1}, status: {t:'string',e:['open','resolved']}, priority: {t:'string',e:['critical','high','normal','low']}, assignee: {t:'string'}, title: {t:'string'} } },
  batch_update_clashes:{ desc: 'Bulk update clashes.', params: { action: {t:'string',e:['resolve','set_priority','set_status'],r:1}, filter: {t:'string',e:['duplicates','soft','hard','all'],r:1}, value: {t:'string'} } },
  set_view:            { desc: 'Set camera to a preset angle.', params: { view: {t:'string',e:['top','front','back','left','right','isometric','reset'],r:1} } },
  set_render_style:    { desc: 'Change 3D rendering style.', params: { style: {t:'string',e:['wireframe','shaded','rendered','standard'],r:1} } },
  set_section:         { desc: 'Add or clear section cut plane.', params: { axis: {t:'string',e:['x','y','z','none'],r:1} } },
  color_by:            { desc: 'Color elements by property.', params: { by: {t:'string',e:['type','storey','discipline','material','none'],r:1} } },
  set_theme:           { desc: 'Switch UI theme.', params: { theme: {t:'string',e:['dark','light'],r:1} } },
  set_visibility:      { desc: 'Show or hide UI overlays.', params: { option: {t:'string',e:['grid','axes','markers'],r:1}, visible: {t:'boolean',r:1} } },
  restore_visibility:  { desc: 'Restore all hidden/ghosted elements.', params: {} },
  fly_to_clash:        { desc: 'Fly camera to a clash.', params: { clashIndex: {t:'number',r:1} } },
  navigate_tab:        { desc: 'Switch to a UI tab.', params: { tab: {t:'string',e:['models','clashes','issues','navigator','ai'],r:1} } },
  filter_clashes:      { desc: 'Filter the clash list.', params: { status: {t:'string',e:['open','resolved','all']}, priority: {t:'string',e:['critical','high','normal','low','all']} } },
  sort_clashes:        { desc: 'Sort the clash list.', params: { sortBy: {t:'string',e:['priority','status','type','storey','date','distance'],r:1} } },
  group_clashes:       { desc: 'Group clashes by category.', params: { groupBy: {t:'string',e:['storey','discipline','status','type','none'],r:1} } },
  export_bcf:          { desc: 'Export clashes/issues as BCF.', params: { version: {t:'string',e:['2.1','3.0']} } },
  create_project:      { desc: 'Create a new project.', params: { name: {t:'string',r:1} } },
  switch_project:      { desc: 'Switch to a project by name.', params: { name: {t:'string',r:1} } },
  measure:             { desc: 'Start or stop measurement mode.', params: { mode: {t:'string',e:['length','angle','area','stop','clear'],r:1} } },
  walk_mode:           { desc: 'Enter or exit walk mode.', params: { enabled: {t:'boolean',r:1} } },
};

// ── REST API ──────────────────────────────────────────────────────

function generateOpenAPISpec() {
  const paths = {};
  paths['/status'] = { get: { operationId: 'getStatus', summary: 'Bridge and browser connection status', responses: { '200': { description: 'Status', content: { 'application/json': { schema: { type: 'object' } } } } } } };
  paths['/tools'] = { get: { operationId: 'listTools', summary: 'List available tools', responses: { '200': { description: 'Tools', content: { 'application/json': { schema: { type: 'object' } } } } } } };

  for (const [name, tool] of Object.entries(TOOLS)) {
    const properties = {}; const required = [];
    for (const [pn, pd] of Object.entries(tool.params)) {
      properties[pn] = { type: pd.t || 'string' };
      if (pd.e) properties[pn].enum = pd.e;
      if (pd.d) properties[pn].description = pd.d;
      if (pd.r) required.push(pn);
    }
    paths['/call/' + name] = { post: {
      operationId: name, summary: tool.desc,
      ...(Object.keys(properties).length > 0 ? { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties, ...(required.length ? { required } : {}) } } } } } : {}),
      responses: { '200': { description: 'Result', content: { 'application/json': { schema: { type: 'object' } } } }, '502': { description: 'Browser not connected' }, '504': { description: 'Timed out' } }
    } };
  }

  return {
    openapi: '3.1.0',
    info: { title: 'ClashControl Smart Bridge', description: 'LLM bridge — control ClashControl BIM clash detection from Claude, ChatGPT, or any AI assistant.', version: '0.1.0' },
    servers: [{ url: 'http://localhost:' + REST_PORT }],
    paths
  };
}

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.method !== 'POST') { resolve({}); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); } });
  });
}

function startRestServer() {
  const srv = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const json = (s, d) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };

    if (path === '/status' && req.method === 'GET') {
      json(200, { bridge: 'running', browser: browserSocket && browserSocket.readyState === WebSocket.OPEN ? 'connected' : 'disconnected', wsPort: WS_PORT, tools: Object.keys(TOOLS).length, mcp: MCP_MODE });
      return;
    }
    if (path === '/tools' && req.method === 'GET') { json(200, { tools: TOOLS }); return; }
    if (path === '/openapi.json' && req.method === 'GET') { json(200, generateOpenAPISpec()); return; }

    const m = path.match(/^\/call\/([a-z_]+)$/);
    if (m && req.method === 'POST') {
      if (!TOOLS[m[1]]) { json(404, { error: 'Unknown tool: ' + m[1] }); return; }
      const params = await parseBody(req);
      try { const result = await sendToBrowser(m[1], params); json(200, { result }); }
      catch (e) { json(e.message.includes('not connected') ? 502 : 504, { error: e.message }); }
      return;
    }

    if (path === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>ClashControl Smart Bridge</title></head>
<body style="font-family:system-ui;max-width:700px;margin:2rem auto;padding:0 1rem;color:#e2e8f0;background:#0f172a">
<h1 style="color:#f59e0b">ClashControl Smart Bridge</h1>
<p>LLM bridge — connect Claude, ChatGPT, or any AI assistant to control ClashControl.</p>
<h3>Endpoints</h3>
<ul><li><code>GET /status</code></li><li><code>GET /tools</code></li><li><code>POST /call/{action}</code></li><li><code>GET /openapi.json</code> (ChatGPT Actions)</li></ul>
<h3>Setup</h3>
<p><b>ChatGPT:</b> Create custom GPT → Actions → Import URL → <code>http://localhost:${REST_PORT}/openapi.json</code></p>
<p><b>Claude Desktop:</b> Run with <code>--mcp</code> flag and add to Claude Desktop config</p>
<p><b>Any LLM:</b> POST to <code>/call/{tool}</code> with JSON body</p>
<p style="color:#94a3b8;font-size:0.85rem">Browser: <span id="s">checking...</span></p>
<script>fetch('/status').then(r=>r.json()).then(d=>{document.getElementById('s').textContent=d.browser;document.getElementById('s').style.color=d.browser==='connected'?'#22c55e':'#ef4444'})</script>
</body></html>`);
      return;
    }
    json(404, { error: 'Not found' });
  });

  srv.listen(REST_PORT, '127.0.0.1', () => {
    log('REST API:  http://127.0.0.1:' + REST_PORT);
    log('OpenAPI:   http://127.0.0.1:' + REST_PORT + '/openapi.json');
  });
}

// ── MCP Server (Claude Desktop) ──────────────────────────────────

async function startMcpServer() {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = require('zod');

  const mcp = new McpServer({ name: 'ClashControl', version: '0.1.0' });

  // Register all tools from the shared TOOLS definition
  for (const [name, tool] of Object.entries(TOOLS)) {
    const schema = {};
    for (const [pn, pd] of Object.entries(tool.params)) {
      if (pd.e) schema[pn] = pd.r ? z.enum(pd.e) : z.enum(pd.e).optional();
      else if (pd.t === 'number') schema[pn] = pd.r ? z.number() : z.number().optional();
      else if (pd.t === 'boolean') schema[pn] = pd.r ? z.boolean() : z.boolean().optional();
      else schema[pn] = pd.r ? z.string() : z.string().optional();
      if (pd.d && schema[pn].describe) schema[pn] = schema[pn].describe(pd.d);
    }

    mcp.tool(name, tool.desc, schema, async (params) => {
      try {
        const result = await sendToBrowser(name, params);
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
      }
    });
  }

  log('MCP server starting on stdio...');
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log('MCP connected to Claude');
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  startWsBridge();
  log('WebSocket:  ws://127.0.0.1:' + WS_PORT);

  // Always start REST (doesn't use stdio)
  startRestServer();

  // MCP mode: also start stdio MCP server for Claude Desktop
  if (MCP_MODE) {
    await startMcpServer();
  } else {
    log('');
    log('Waiting for ClashControl browser to connect...');
    log('Run with --mcp flag for Claude Desktop integration');
  }
}

main().catch((e) => {
  log('Fatal: ' + e.message);
  process.exit(1);
});

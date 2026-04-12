# Building the ClashControl MCP Server

Drop this file into the SmartBridge repo. It contains everything needed to add MCP server support that wraps the existing SmartBridge REST API, packaged as a `.mcpb` Desktop Extension.

---

## Architecture

```
Claude Desktop                 ClashControl PWA (browser)
     │                                  ▲
     │ stdio (JSON-RPC 2.0)             │ WebSocket :19802
     ▼                                  │
  MCP Server (this code)          SmartBridge binary
     │                                  ▲
     │ HTTP POST                        │
     └──────────────────────────────────┘
       POST /call/{tool_name}  :19803
```

The MCP server is a thin Node.js process that Claude Desktop spawns as a child. It receives tool calls over stdin, makes HTTP requests to SmartBridge's REST API at `127.0.0.1:19803`, and writes results back to stdout. It never touches the network beyond localhost.

**Critical rule:** stdout is sacred. Only JSON-RPC messages go to stdout. All logging uses `console.error()` (stderr). A single stray `console.log()` breaks the transport silently.

---

## Project setup

### Dependencies (3 total)

```json
{
  "name": "clashcontrol-mcp",
  "version": "1.0.0",
  "type": "module",
  "bin": { "clashcontrol-mcp": "./build/index.js" },
  "scripts": {
    "build": "tsc",
    "bundle": "esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.js --banner:js=\"#!/usr/bin/env node\"",
    "pack": "mcpb pack . --output clashcontrol-mcp.mcpb"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "esbuild": "^0.25.0",
    "@anthropic-ai/mcpb": "^2.1.0"
  }
}
```

No axios, no node-fetch. Node 18+ built-in `fetch` handles everything.

### TypeScript config

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "outDir": "build",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

### Import paths

The SDK uses ESM deep imports. In TypeScript source, include the `.js` extension:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
```

If these deep paths fail on your SDK version, try the flat import: `from "@modelcontextprotocol/server"`. Check the installed SDK's `package.json` exports map to confirm.

---

## Server initialization

```ts
const server = new McpServer(
  { name: "clashcontrol-mcp", version: "1.0.0" },
  {
    instructions:
      "Connects to ClashControl, a local IFC clash detection application. " +
      "Use these tools when users ask about BIM clashes, IFC model analysis, " +
      "element conflicts, spatial coordination, or clash resolution. " +
      "The SmartBridge must be running (ClashControl open in browser) for tools to work."
  }
);

// ... register all tools, resources, prompts here ...

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("ClashControl MCP server running");
```

Add process-level error handlers:

```ts
process.on("uncaughtException", (err) => { console.error("Fatal:", err); process.exit(1); });
process.on("unhandledRejection", (err) => { console.error("Unhandled:", err); process.exit(1); });
```

---

## HTTP bridge helper

Every tool handler calls this single function. It maps tool calls to `POST /call/{toolName}` on the SmartBridge REST API.

```ts
const PORT = process.env.CLASHCONTROL_PORT || "19803";
const BASE = `http://127.0.0.1:${PORT}`;

async function callBridge(toolName: string, params?: Record<string, unknown>) {
  try {
    const res = await fetch(`${BASE}/call/${toolName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text();
      return { content: [{ type: "text" as const, text: `SmartBridge error [${res.status}]: ${body}` }], isError: true };
    }

    const data = await res.json();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET")) {
      return {
        content: [{ type: "text" as const, text: "ClashControl SmartBridge is not running. Open ClashControl in your browser and enable the Smart Bridge addon." }],
        isError: true,
      };
    }
    if (err instanceof DOMException && err.name === "AbortError" || msg.includes("timeout")) {
      return {
        content: [{ type: "text" as const, text: "Request timed out. The operation may be processing a large IFC model." }],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: `Bridge error: ${msg}` }], isError: true };
  }
}
```

Key design choices:
- **30s timeout** — Claude Desktop has a hard 60s limit. 30s leaves room for JSON-RPC overhead.
- **`isError: true`** — MCP convention telling Claude the call failed. Claude informs the user instead of treating error text as data.
- **`CLASHCONTROL_PORT` env var** — override default 19803 if needed.

---

## Tool registration pattern

Use `server.registerTool()` exclusively (not the deprecated `server.tool()`).

Signature:
```ts
server.registerTool(
  "tool_name",                              // snake_case, verb_noun
  {
    title: "Human-Readable Title",
    description: "1-3 sentences. BIM domain language. When to use. What it returns.",
    inputSchema: { /* flat Zod object fields */ },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  async (params) => callBridge("tool_name", params)
);
```

Rules:
- Names: snake_case, under 64 chars, `^[a-zA-Z0-9_-]+$`
- Schemas: `z.object()` only — `z.discriminatedUnion()` is silently dropped (SDK bug)
- Keep schemas flat — Claude handles flat params better than nested objects
- Every Zod field gets `.describe()` with type, valid values, and example
- Every tool gets explicit `destructiveHint: false` (defaults to `true` in MCP spec if omitted)

---

## All 24 tools — complete definitions

These map 1:1 to the handler functions in the browser addon (`addons/smart-bridge.js` lines 259-377). The SmartBridge binary relays calls to the browser via WebSocket; the MCP server calls the binary via REST.

### Data query tools

```ts
server.registerTool("get_status", {
  title: "Get Project Status",
  description:
    "Returns a snapshot of the current ClashControl session: loaded IFC models with discipline and element counts, " +
    "total clash and issue counts, active detection rules (gap tolerance, hard/soft mode), current UI tab, " +
    "walk mode state, and theme. Use this first to understand what the user is working with.",
  inputSchema: {},
  annotations: { destructiveHint: false, idempotentHint: true },
}, async () => callBridge("get_status"));

server.registerTool("get_clashes", {
  title: "Get Clashes",
  description:
    "Retrieves detected clash pairs between IFC elements. Each clash includes its index, title, status " +
    "(open/resolved), priority, building storey, element types and names for both sides (A and B), " +
    "distance in mm, AI-assigned severity, and AI category. Filter by status and limit results. " +
    "Use when the user asks about conflicts, collisions, or coordination issues.",
  inputSchema: {
    status: z.enum(["all", "open", "resolved", "approved"]).optional()
      .describe("Filter clashes by status. Omit or 'all' for everything."),
    limit: z.number().min(1).max(500).optional()
      .describe("Max clashes to return. Default 50."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("get_clashes", params));

server.registerTool("get_issues", {
  title: "Get Issues",
  description:
    "Retrieves coordination issues (manually created or promoted from clashes). Each issue includes " +
    "index, title, status, priority, assignee, and description. Use when the user asks about tracked " +
    "coordination issues, assignments, or project tasks.",
  inputSchema: {
    status: z.enum(["all", "open", "in_progress", "resolved", "closed"]).optional()
      .describe("Filter issues by status. Omit or 'all' for everything."),
    limit: z.number().min(1).max(500).optional()
      .describe("Max issues to return. Default 50."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("get_issues", params));
```

### Detection tools

```ts
server.registerTool("run_detection", {
  title: "Run Clash Detection",
  description:
    "Starts clash detection between loaded IFC models. Optionally set which models to compare, " +
    "gap tolerance in mm, and whether to detect only hard clashes (physical intersections). " +
    "Results appear in get_clashes after detection completes. At least one model must be loaded.",
  inputSchema: {
    modelA: z.string().optional()
      .describe("Name of first model to test. 'all' or omit for all models."),
    modelB: z.string().optional()
      .describe("Name of second model to test against. 'all' or omit for all models."),
    maxGap: z.number().min(0).max(1000).optional()
      .describe("Gap tolerance in mm. Elements within this distance count as clashing. Default 10mm."),
    hard: z.boolean().optional()
      .describe("True = detect only hard clashes (physical intersections). False = include soft/clearance clashes."),
    excludeSelf: z.boolean().optional()
      .describe("True = skip clashes within the same model. Useful for inter-discipline checks."),
  },
  annotations: { destructiveHint: false, idempotentHint: false },
}, async (params) => callBridge("run_detection", params));

server.registerTool("set_detection_rules", {
  title: "Set Detection Rules",
  description:
    "Updates clash detection parameters without running detection. Configures gap tolerance, " +
    "hard/soft mode, self-clash exclusion, and duplicate handling for subsequent detection runs.",
  inputSchema: {
    maxGap: z.number().min(0).max(1000).optional()
      .describe("Gap tolerance in mm."),
    hard: z.boolean().optional()
      .describe("True = hard clashes only."),
    excludeSelf: z.boolean().optional()
      .describe("True = skip intra-model clashes."),
    duplicates: z.boolean().optional()
      .describe("True = include duplicate/overlapping element clashes."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("set_detection_rules", params));
```

### Clash management tools

```ts
server.registerTool("update_clash", {
  title: "Update Clash",
  description:
    "Updates a single clash by its index (0-based, from get_clashes). Change status, priority, " +
    "assignee, or title. Use when the user wants to resolve, approve, reassign, or rename a specific clash.",
  inputSchema: {
    clashIndex: z.number().min(0)
      .describe("0-based index of the clash from get_clashes results."),
    status: z.enum(["open", "resolved", "approved"]).optional()
      .describe("New status for the clash."),
    priority: z.enum(["low", "normal", "high", "critical"]).optional()
      .describe("New priority level."),
    assignee: z.string().optional()
      .describe("Person or team to assign this clash to."),
    title: z.string().optional()
      .describe("Override the clash title."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("update_clash", params));

server.registerTool("batch_update_clashes", {
  title: "Batch Update Clashes",
  description:
    "Applies a batch action to multiple clashes matching a filter. Uses natural language processing " +
    "to interpret the action and filter. Example: action='resolve', filter='all duct clashes on level 2'.",
  inputSchema: {
    action: z.string()
      .describe("The action to apply: 'resolve', 'approve', 'set priority high', etc."),
    filter: z.string()
      .describe("Natural language filter: 'all MEP clashes', 'clashes on storey 3', 'pipe vs duct', etc."),
  },
  annotations: { destructiveHint: false, idempotentHint: false },
}, async (params) => callBridge("batch_update_clashes", params));

server.registerTool("filter_clashes", {
  title: "Filter Clashes",
  description:
    "Applies status and/or priority filters to the clash list in the UI. " +
    "This changes what the user sees in the ClashControl panel.",
  inputSchema: {
    status: z.enum(["all", "open", "resolved", "approved"]).optional()
      .describe("Show only clashes with this status."),
    priority: z.enum(["all", "low", "normal", "high", "critical"]).optional()
      .describe("Show only clashes with this priority."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("filter_clashes", params));

server.registerTool("sort_clashes", {
  title: "Sort Clashes",
  description:
    "Sorts the clash list in the UI by a given field. Changes the display order in ClashControl.",
  inputSchema: {
    sortBy: z.string()
      .describe("Field to sort by: 'status', 'priority', 'storey', 'typeA', 'typeB', 'distance', 'severity'."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("sort_clashes", params));

server.registerTool("group_clashes", {
  title: "Group Clashes",
  description:
    "Groups the clash list by a field (storey, type, discipline, severity, category) or removes " +
    "grouping with 'none'. Helps identify clash clusters and patterns.",
  inputSchema: {
    groupBy: z.string()
      .describe("Field to group by: 'storey', 'typeA', 'typeB', 'aiSeverity', 'aiCategory', or 'none' to ungroup."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("group_clashes", params));
```

### Visualization tools

```ts
server.registerTool("set_view", {
  title: "Set Camera View",
  description:
    "Changes the 3D camera to a standard view. Use when the user asks to see the model from " +
    "a specific angle or wants to reset the camera position.",
  inputSchema: {
    view: z.enum(["top", "front", "back", "left", "right", "isometric", "reset"])
      .describe("The camera view to set."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("set_view", params));

server.registerTool("set_render_style", {
  title: "Set Render Style",
  description:
    "Changes how the 3D model is rendered. Affects visual appearance without modifying model data.",
  inputSchema: {
    style: z.string()
      .describe("Render style: 'standard', 'shaded', 'rendered', 'wireframe'."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("set_render_style", params));

server.registerTool("set_section", {
  title: "Set Section Cut",
  description:
    "Creates a section cutting plane along an axis to reveal interior geometry, or removes it. " +
    "Useful for inspecting clashes hidden inside walls, floors, or ceilings.",
  inputSchema: {
    axis: z.enum(["x", "y", "z", "none"])
      .describe("Cutting axis. 'none' removes the section plane."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("set_section", params));

server.registerTool("color_by", {
  title: "Color Elements By",
  description:
    "Colors all elements in the 3D view by a classification field. Helps visualize discipline " +
    "distribution, element types, or building stories at a glance. 'none' resets to original materials.",
  inputSchema: {
    by: z.string()
      .describe("Color scheme: 'discipline', 'type', 'storey', 'model', 'status', or 'none' to reset."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("color_by", params));

server.registerTool("set_theme", {
  title: "Set UI Theme",
  description: "Switches the ClashControl interface between dark and light themes.",
  inputSchema: {
    theme: z.enum(["dark", "light"]).describe("Theme to apply."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("set_theme", params));

server.registerTool("set_visibility", {
  title: "Set Visibility",
  description:
    "Toggles visibility of UI overlays in the 3D view: the reference grid, " +
    "coordinate axes, or clash markers.",
  inputSchema: {
    option: z.enum(["grid", "axes", "markers"])
      .describe("Which overlay to toggle."),
    visible: z.boolean()
      .describe("True to show, false to hide."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("set_visibility", params));

server.registerTool("restore_visibility", {
  title: "Restore All Visibility",
  description:
    "Unhides all ghosted/hidden IFC elements, restoring full model visibility. " +
    "Use when elements were isolated or hidden during clash investigation.",
  inputSchema: {},
  annotations: { destructiveHint: false, idempotentHint: true },
}, async () => callBridge("restore_visibility"));

server.registerTool("fly_to_clash", {
  title: "Fly To Clash",
  description:
    "Animates the 3D camera to focus on a specific clash by its index. Selects the clash " +
    "in the UI panel and highlights the two conflicting elements. Essential for visual inspection.",
  inputSchema: {
    clashIndex: z.number().min(0)
      .describe("0-based index of the clash to navigate to (from get_clashes)."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("fly_to_clash", params));
```

### Navigation and mode tools

```ts
server.registerTool("navigate_tab", {
  title: "Switch UI Tab",
  description: "Switches the active panel tab in ClashControl's sidebar.",
  inputSchema: {
    tab: z.string()
      .describe("Tab name: 'clashes', 'issues', 'models', 'settings', 'addons'."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("navigate_tab", params));

server.registerTool("measure", {
  title: "Measurement Mode",
  description:
    "Controls the measurement tool in the 3D view. Start point-to-point or edge measurement, " +
    "stop the active measurement, or clear all measurement annotations.",
  inputSchema: {
    mode: z.enum(["point", "edge", "stop", "clear"])
      .describe("'point' = point-to-point distance, 'edge' = edge measurement, 'stop' = deactivate, 'clear' = remove all."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("measure", params));

server.registerTool("walk_mode", {
  title: "Walk Mode",
  description:
    "Enables or disables first-person walk mode for navigating through the building model " +
    "at eye level. Automatically sets elevation to the ground floor.",
  inputSchema: {
    enabled: z.boolean()
      .describe("True to enter walk mode, false to exit."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("walk_mode", params));
```

### Export and project tools

```ts
server.registerTool("export_bcf", {
  title: "Export BCF",
  description:
    "Exports all clashes or issues as a BCF (BIM Collaboration Format) ZIP file. " +
    "BCF is the industry standard for sharing coordination issues between BIM tools " +
    "like Navisworks, Solibri, and BIMcollab.",
  inputSchema: {
    version: z.enum(["2.1", "3.0"]).optional()
      .describe("BCF version. Default '2.1' for maximum compatibility."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("export_bcf", params));

server.registerTool("create_project", {
  title: "Create Project",
  description: "Creates a new project in ClashControl to organize clashes and issues.",
  inputSchema: {
    name: z.string().min(1).describe("Project name, e.g. 'MEP Coordination Phase 2'."),
  },
  annotations: { destructiveHint: false, idempotentHint: false },
}, async (params) => callBridge("create_project", params));

server.registerTool("switch_project", {
  title: "Switch Project",
  description:
    "Switches to an existing project by name (fuzzy match). Loads that project's clashes, " +
    "issues, and detection rules.",
  inputSchema: {
    name: z.string().min(1)
      .describe("Project name or partial match, e.g. 'MEP' matches 'MEP Coordination'."),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async (params) => callBridge("switch_project", params));
```

---

## MCP Resources (2)

Resources are read-only context the user or client attaches to a conversation. They complement tools (which Claude calls on demand).

```ts
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

server.registerResource(
  "project-status",
  "clashcontrol://status",
  {
    title: "ClashControl Status",
    description: "Current session snapshot: loaded models, clash/issue counts, detection rules, active theme.",
    mimeType: "application/json",
  },
  async (uri) => {
    const result = await callBridge("get_status");
    return { contents: [{ uri: uri.href, text: result.content[0].text }] };
  }
);

server.registerResource(
  "clash-summary",
  "clashcontrol://clash-summary",
  {
    title: "Clash Summary",
    description: "All current clashes (up to 500) with status, severity, and category data.",
    mimeType: "application/json",
  },
  async (uri) => {
    const result = await callBridge("get_clashes", { limit: 500 });
    return { contents: [{ uri: uri.href, text: result.content[0].text }] };
  }
);
```

---

## MCP Prompts (4 BIM workflow templates)

Prompts are pre-built conversation starters shown in Claude Desktop's prompt menu. They guide users toward effective BIM workflows.

```ts
server.registerPrompt(
  "analyze-clashes",
  {
    title: "Analyze Clash Report",
    description: "Comprehensive analysis of all detected clashes grouped by severity, discipline, and storey.",
  },
  async () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          "Analyze the current clash detection results in ClashControl. " +
          "First call get_status to understand the loaded models, then get_clashes to retrieve all clashes. " +
          "Organize your analysis by:\n" +
          "1. Summary statistics (total, by status, by severity)\n" +
          "2. Discipline conflicts (which model/discipline pairs have the most clashes)\n" +
          "3. Hotspot storeys (which building levels have the most issues)\n" +
          "4. Top 5 most critical clashes with recommended resolution priority\n" +
          "5. Suggested next steps for the coordination team",
      },
    }],
  })
);

server.registerPrompt(
  "investigate-clash",
  {
    title: "Investigate Specific Clash",
    description: "Deep-dive into a single clash: what's conflicting, why, and how to resolve it.",
    argsSchema: {
      clashIndex: z.number().describe("0-based clash index from the clash list."),
    },
  },
  async ({ clashIndex }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Investigate clash at index ${clashIndex} in ClashControl. ` +
          "Call get_clashes to get its details (types, names, storey, severity, distance). " +
          "Then fly_to_clash to navigate to it visually. " +
          "Explain: what two elements are conflicting, what discipline each belongs to, " +
          "how severe the intersection is (based on distance), and suggest which element " +
          "should be moved or resized to resolve the conflict. " +
          "If possible, suggest whether this is a design error or a coordination gap.",
      },
    }],
  })
);

server.registerPrompt(
  "coordination-review",
  {
    title: "Coordination Review",
    description: "Systematic discipline-vs-discipline clash review for coordination meetings.",
  },
  async () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          "Prepare a coordination review report using ClashControl. " +
          "Call get_status to see loaded models and disciplines, then get_clashes with a high limit. " +
          "Group clashes by discipline pairs (e.g. Structural vs Mechanical, Architectural vs Plumbing). " +
          "For each pair, report: clash count, most common clash types, worst-affected storeys, " +
          "and recommended actions. Format as a meeting agenda that a BIM coordinator can present.",
      },
    }],
  })
);

server.registerPrompt(
  "compare-runs",
  {
    title: "Compare Detection Runs",
    description: "Identify new, resolved, and persistent clashes since last detection.",
  },
  async () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          "Compare the current clash detection results in ClashControl with previous state. " +
          "Call get_clashes to retrieve all current clashes. Identify: " +
          "1. Newly detected clashes (status 'open' without prior resolution history)\n" +
          "2. Resolved clashes (status 'resolved')\n" +
          "3. Persistent conflicts (open clashes that likely existed in prior runs)\n" +
          "Summarize the trend: is the project improving or are new issues appearing?",
      },
    }],
  })
);
```

---

## .mcpb Desktop Extension packaging

The `.mcpb` format is a ZIP archive that Claude Desktop installs with a double-click. Users need zero terminal knowledge, zero Node.js install — Claude Desktop's built-in runtime handles everything.

### manifest.json

```json
{
  "manifest_version": "0.3",
  "name": "clashcontrol-mcp",
  "display_name": "ClashControl for Claude",
  "version": "1.0.0",
  "description": "Connect Claude to ClashControl for AI-powered IFC clash detection analysis.",
  "long_description": "Gives Claude access to your local ClashControl session. Ask about clashes, run detection, inspect elements, export BCF reports, and get AI-powered coordination recommendations. Requires ClashControl open in your browser with the Smart Bridge addon enabled.",
  "author": {
    "name": "ClashControl"
  },
  "server": {
    "type": "node",
    "entry_point": "server/index.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/server/index.js"]
    }
  },
  "tools": [
    { "name": "get_status", "description": "Get project status: loaded models, clash counts, rules" },
    { "name": "get_clashes", "description": "List detected clashes with filtering and details" },
    { "name": "get_issues", "description": "List coordination issues" },
    { "name": "run_detection", "description": "Run clash detection between IFC models" },
    { "name": "set_detection_rules", "description": "Configure detection parameters" },
    { "name": "update_clash", "description": "Update a single clash status/priority/assignee" },
    { "name": "batch_update_clashes", "description": "Batch update clashes by natural language filter" },
    { "name": "filter_clashes", "description": "Filter the clash list by status or priority" },
    { "name": "sort_clashes", "description": "Sort the clash list" },
    { "name": "group_clashes", "description": "Group clashes by field" },
    { "name": "set_view", "description": "Set 3D camera view" },
    { "name": "set_render_style", "description": "Change render style" },
    { "name": "set_section", "description": "Create or remove section cutting plane" },
    { "name": "color_by", "description": "Color elements by classification" },
    { "name": "set_theme", "description": "Switch dark/light theme" },
    { "name": "set_visibility", "description": "Toggle grid, axes, or markers" },
    { "name": "restore_visibility", "description": "Unhide all ghosted elements" },
    { "name": "fly_to_clash", "description": "Navigate camera to a specific clash" },
    { "name": "navigate_tab", "description": "Switch UI panel tab" },
    { "name": "measure", "description": "Control measurement tool" },
    { "name": "walk_mode", "description": "Enable/disable first-person walk mode" },
    { "name": "export_bcf", "description": "Export clashes as BCF 2.1 or 3.0" },
    { "name": "create_project", "description": "Create a new project" },
    { "name": "switch_project", "description": "Switch to an existing project" }
  ],
  "tools_generated": false,
  "prompts": [
    { "name": "analyze-clashes", "description": "Comprehensive clash report analysis" },
    { "name": "investigate-clash", "description": "Deep-dive into a specific clash" },
    { "name": "coordination-review", "description": "Discipline review for coordination meetings" },
    { "name": "compare-runs", "description": "Compare current vs previous detection results" }
  ],
  "compatibility": {
    "platforms": ["darwin", "win32", "linux"],
    "runtimes": { "node": ">=18.0.0" }
  }
}
```

### .mcpbignore

```
src/
node_modules/
tsconfig.json
*.ts
.git/
.gitignore
build/
dist/
```

### Bundle directory layout for packing

```
clashcontrol-mcp/          <-- run `mcpb pack .` from here
  manifest.json
  server/
    index.js              <-- esbuild-bundled single file (from `npm run bundle`)
```

### Build and pack commands

```bash
# 1. Compile TypeScript
npm run build

# 2. Bundle into single file
npm run bundle
mkdir -p server && cp dist/index.js server/index.js

# 3. Validate manifest
npx mcpb validate manifest.json

# 4. Pack extension
npx mcpb pack . --output clashcontrol-mcp.mcpb
```

The output `clashcontrol-mcp.mcpb` is your distributable. Double-click installs in Claude Desktop.

---

## Manual install (alternative to .mcpb)

For development or older Claude Desktop versions, add to `claude_desktop_config.json`:

**File locations:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "clashcontrol": {
      "command": "node",
      "args": ["/absolute/path/to/clashcontrol-mcp/build/index.js"]
    }
  }
}
```

Or via npx (after npm publish):
```json
{
  "mcpServers": {
    "clashcontrol": {
      "command": "npx",
      "args": ["-y", "clashcontrol-mcp"]
    }
  }
}
```

Restart Claude Desktop fully (Cmd+Q / right-click tray > Quit, not just close window) after config changes.

---

## Testing

### MCP Inspector (first)

```bash
npx @modelcontextprotocol/inspector node build/index.js
```

Opens at `http://localhost:6274`. Verify:
- **Tools tab**: all 24 tools appear with correct names, descriptions, schemas
- **Resources tab**: `clashcontrol://status` and `clashcontrol://clash-summary`
- **Prompts tab**: 4 templates with argument schemas

### Claude Desktop (second)

Install via `.mcpb` or manual config. After restart, a hammer icon confirms tools are loaded. Test:
- "What models are loaded?" → should call `get_status`
- "Show me all clashes" → should call `get_clashes`
- "Fly to clash 3" → should call `fly_to_clash` with `clashIndex: 2`

### Error paths

With SmartBridge stopped, every tool should return:
```
"ClashControl SmartBridge is not running. Open ClashControl in your browser and enable the Smart Bridge addon."
```
with `isError: true`.

### Debug logs

- macOS: `~/Library/Logs/Claude/mcp-server-clashcontrol.log`
- Windows: `%APPDATA%\Claude\logs\mcp-server-clashcontrol.log`

---

## Post-session / team tasks

These are outside the builder's scope:

- **Code signing**: `mcpb sign clashcontrol-mcp.mcpb --self-signed` (or proper cert)
- **Marketplace publishing**: submit to Claude Desktop extension directory
- **GitHub Actions**: add `.mcpb` to release workflow alongside the binary artifacts
- **Installer scripts**: PowerShell/bash one-liners for non-.mcpb users
- **Real-world testing**: run with actual IFC models and BIM managers
- **Prompt refinement**: tune the 4 prompt templates based on real coordination workflows
- **Shared tools module**: extract tool name/schema definitions into a shared file that both the MCP server and SmartBridge binary import, eliminating duplication

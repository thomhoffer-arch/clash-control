# CLAUDE.md — Project Guide for AI Assistants

## What is this?
ClashControl is a free, open-source IFC clash detection web app. It lets users load IFC building models, detect geometric clashes between elements, create/manage issues, and export to BCF format.

## Architecture — Single File App
The **entire application** lives in `index.html` (~4000 lines). There is no build step, no bundler, no node_modules. Just open the file in a browser.

### Tech stack
- **Preact/React 18** via CDN (UMD) — UI framework
- **htm** — hand-written tagged template literal parser (inlined in the file, replaces JSX)
- **Three.js r128** via CDN — 3D rendering
- **JSZip** via CDN — BCF zip export/import
- **No other dependencies**

### Code structure inside index.html
The file follows this layout top to bottom:
1. **CDN script tags** — React, Three.js, JSZip
2. **htm parser** — custom tagged template engine (~80 lines)
3. **CSS** — all styles in a single `<style>` block, using CSS custom properties for theming
4. **Boot screen** — loading spinner shown before JS executes
5. **Main `<script>`** — everything else:
   - `startApp()` wraps the entire application
   - Constants, state shape (`INIT`), reducer
   - IFC loader (uses web-ifc WASM library, lazy-loaded via ESM)
   - Three.js scene setup, orbit controls, render loop
   - Fly-to system, ghost/highlight system, section planes, section box
   - Clash detection engine (OBB-based)
   - BCF import/export
   - All UI components as functions returning `html\`...\`` tagged templates
   - App component, mount

### Key patterns
- **Tagged templates**: `html\`<div>...</div>\`` instead of JSX. Uses `${expr}` for interpolation.
- **IIFE in templates**: Complex render logic uses `${condition && function(){ ... }()}` pattern.
- **Render on demand**: Global `invalidate(frames)` + `_needsRender` counter. The render loop skips GPU work when nothing changes. Call `invalidate()` after any visual change.
- **Conditional mounting**: UI components use `${condition && html\`...\``}` for lazy rendering — Preact only mounts when condition is true.
- **Material swapping**: Render styles (standard/shaded/rendered/wireframe) swap mesh materials. Original saved as `mesh._origMaterial`.
- **Ghost material**: Shared `MeshBasicMaterial({color:0x334155, opacity:0.08})` replaces mesh materials for transparency effect.
- **State management**: Single `useReducer` with action types like `{t:'LOAD_MODEL', ...}`. Dispatch available globally as `window._ccDispatch`.
- **CSS custom properties**: `:root` = dark theme, `[data-theme=light]` = light theme.

## Important conventions

### Versioning
- Version lives in `version.json` (major.minor.patch)
- `scripts/bump-version.sh` runs as a pre-commit hook when `index.html` is staged
- It auto-increments patch, updates `version.json`, injects version into `index.html`, updates `README.md` version badge, and appends commit message to `CHANGELOG.md`
- Current version: check `version.json`

### When making changes
- **Always edit `index.html`** — that's where all the code is
- **Call `invalidate()`** after any change that affects the 3D view (camera, materials, visibility, highlights, ghost, grid, etc.)
- **Don't add new files** unless absolutely necessary — this is a single-file app by design
- **Don't add npm/build tooling** — the app runs directly in the browser
- **Keep the CHANGELOG.md updated** — the bump script handles this automatically on commit
- **Test by opening index.html** in a browser after changes

### Things NOT to touch without good reason
- The htm parser at the top of the script — it's hand-written and tested
- The IFC loader (web-ifc integration) — complex but working, handles property/material extraction
- The OBB clash detection engine — geometrically sensitive code
- The render-on-demand system (`_needsRender` / `invalidate`) — breaking this causes either no rendering or constant GPU waste

### Known quirks
- Three.js r128 is used (not latest) — some newer Three.js APIs won't work
- The view cube uses quaternion inversion (`cubeGroup.quaternion.copy(camera.quaternion).invert()`) — don't switch to camera-position approach, it causes mirroring
- Fly-to auto-detects whether to preserve camera angle or re-orient based on travel distance vs current camera distance
- The pre-commit hook only triggers when `index.html` is in the staged files

## File overview
```
index.html                  — The entire application
version.json                — Current version numbers
CHANGELOG.md                — Version history (auto-updated on commit)
README.md                   — Project readme with version badge
LICENSE                     — License file
OPEN_SOURCE_COMPONENTS.md   — Third-party library credits
manifest.json               — PWA manifest for installable app
sw.js                       — Service worker for offline caching (excludes /api/*)
scripts/bump-version.sh     — Pre-commit version bump script
scripts/generate-sri.js     — Generate SRI hashes for CDN scripts
vercel.json                 — Vercel config: COOP/COEP headers, function durations
package.json                — Neon Postgres driver for serverless functions
api/health.js               — Health check: AI + DB status
api/nl.js                   — Gemma 4 NL proxy with native function calling
api/training.js             — Training data ingestion (replaces Google Forms)
api/project.js              — Shared issues sync (project key, no login)
api/title.js                — AI clash title generation (batch, Gemma 4)
```

## Backend (Vercel Serverless + Neon Postgres)

The app is deployed at `www.clashcontrol.io` on Vercel. The backend consists of serverless functions in the `api/` directory.

### Environment Variables (set in Vercel dashboard)
- `GEMINI_API_KEY` — Google AI Studio API key for Gemma 4 (legacy `GOOGLE_AI_KEY` also accepted)
- `POSTGRES_URL` — Vercel Postgres / Neon connection string (auto-injected when you link a Vercel Postgres database; legacy `DATABASE_URL` also accepted)

### API Endpoints
- `GET /api/health` — Returns `{ ai: bool, db: bool, model: string }`
- `POST /api/nl` — NL command proxy. Body: `{ command, context, replyContext }`. Returns `{ intent, ...params }`
- `POST /api/training` — Training data. Requires `X-CC-Consent: true` header. Types: `nl_command`, `clash_feedback`, `detection_run`
- `POST /api/project` — Create shared project. Returns `{ id, name }`
- `GET /api/project?id=KEY` — Pull all shared issues for a project
- `PUT /api/project?id=KEY` — Push issue changes. Body: `{ issues, user }`
- `POST /api/title` — Generate AI titles. Body: `{ clashes: [...] }` (max 20)

### NL Command Flow
1. Client sends command to `/api/nl` (Gemma 4, server-side)
2. Gemma 4 uses native function calling with 13 tool declarations
3. Server returns structured `{ intent, ...params }` — no fragile JSON parsing
4. On server failure, client falls back to regex matching (offline mode)

### Shared Issues
- No login required. Uses shareable project keys (e.g., `MEP-abc123`)
- Shared records are minimal (~250 bytes): identity (GlobalIds) + team decisions (status, priority, assignee, title)
- IFC metadata (types, names, storeys, materials) is derived locally from each user's loaded model
- Conflict resolution: last-write-wins per issue

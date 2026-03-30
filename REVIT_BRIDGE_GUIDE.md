# Revit Bridge Guide — ClashControl

The Revit Bridge lets you push clashes and issues from ClashControl directly into Autodesk Revit, and pull resolution status back — all through an AI-powered bridge using the Model Context Protocol (MCP).

## Architecture

```
ClashControl (browser)          Revit (desktop)
       |                             |
   AI API call (BYOK)         MCP Server (free)
       \                           /
         Claude / GPT / Gemini
         (translates between both)
```

The AI acts as the translator between ClashControl's data model and Revit's API. You bring your own API key — nothing is sent to our servers.

## Prerequisites

1. **An AI API key** (one of the following):
   - [Anthropic](https://console.anthropic.com/) — Claude Sonnet 4
   - [OpenAI](https://platform.openai.com/) — GPT-4o
   - [Google AI](https://aistudio.google.com/) — Gemini 2.0 Flash

2. **A Revit MCP server** running on your machine (requires Revit installed):
   - Recommended: [mcp-server-for-revit-python](https://github.com/mcp-servers-for-revit/mcp-server-for-revit-python) (99+ stars, actively maintained)
   - Alternative: [revit_mcp](https://github.com/PiggyAndrew/revit_mcp) (TypeScript)
   - Alternative: [Autodesk-Revit-MCP-Server](https://github.com/Sam-AEC/Autodesk-Revit-MCP-Server) (C#)

3. **Autodesk Revit** installed and running with your model open

## Setup Instructions

### Step 1: Install a Revit MCP Server

We recommend **mcp-server-for-revit-python**:

```bash
# Clone the repository
git clone https://github.com/mcp-servers-for-revit/mcp-server-for-revit-python.git
cd mcp-server-for-revit-python

# Install dependencies
pip install -r requirements.txt

# Start the MCP server
python main.py
```

The server will start on `localhost:8080` by default. Make sure Revit is open with your model loaded.

**What this server can do:**
- Read elements, properties, levels from your Revit model
- Place family instances (used for clash markers)
- Modify element parameters (used for tagging with ClashControl IDs)
- Color elements based on parameter values
- Export views as images
- Open/save/close documents
- Execute custom Python code in Revit

### Step 2: Get an AI API Key

Pick your preferred AI provider:

**Anthropic (Claude) — Recommended:**
1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Create an account and add billing
3. Go to API Keys and create a new key
4. Copy the key (starts with `sk-ant-`)

**OpenAI (GPT-4o):**
1. Go to [platform.openai.com](https://platform.openai.com/)
2. Create an account and add billing
3. Go to API Keys and create a new key
4. Copy the key (starts with `sk-`)

**Google (Gemini):**
1. Go to [aistudio.google.com](https://aistudio.google.com/)
2. Click "Get API Key"
3. Create a key (starts with `AIza`)

### Step 3: Configure ClashControl

1. Open ClashControl in your browser
2. Click the **Revit Bridge** button (lightning bolt icon) in the left sidebar
3. Select your AI provider from the dropdown
4. Paste your API key
5. Set the MCP server host and port (default: `localhost:8080`)
6. Click **Test Connection** to verify

Your API key is stored in your browser's localStorage only — it never leaves your machine except to call the AI API directly.

### Step 4: Push Clashes to Revit

1. Load your IFC models in ClashControl
2. Run clash detection
3. Open the Revit Bridge panel
4. Click **"Push to Revit"**

The AI will:
- Read all open clashes and issues from ClashControl
- Instruct the Revit MCP to place marker family instances at each clash point
- Tag Revit elements with shared parameters (`CC_ClashID`, `CC_Status`, `CC_Priority`)
- Create filtered 3D views for clash visualization
- Report a summary of what was pushed

### Step 5: Pull Status Back

After your team resolves clashes in Revit (moving ducts, resizing beams, etc.):

1. Open the Revit Bridge panel in ClashControl
2. Click **"Pull from Revit"**

The AI will:
- Query Revit MCP for elements tagged with ClashControl parameters
- Check if geometries have changed
- Update clash/issue statuses in ClashControl
- Add resolution comments

## What Gets Synced

| Data | Push to Revit | Pull from Revit |
|---|---|---|
| Clash locations (3D points) | Placed as marker instances | - |
| Clash status (open/resolved) | Set as element parameter | Updated in ClashControl |
| Clash priority | Set as element parameter | - |
| Issue details | Created as comments/markups | - |
| Element modifications | - | Detected via geometry check |
| Resolution comments | - | Added to clash/issue |

## Shared Parameters

When pushing to Revit, the bridge creates/uses these shared parameters on elements:

| Parameter | Type | Description |
|---|---|---|
| `CC_ClashID` | Text | Links back to ClashControl clash ID |
| `CC_Status` | Text | Current status: `open`, `resolved`, `closed` |
| `CC_Priority` | Text | Priority: `low`, `normal`, `high`, `critical` |
| `CC_IssueID` | Text | Links back to ClashControl issue ID |

## Troubleshooting

### "Connection failed"
- Check that your API key is correct and has billing enabled
- Check your internet connection
- For Anthropic: ensure your key has access to Claude Sonnet 4

### "Revit MCP not responding"
- Make sure Revit is running with a model open
- Make sure the MCP server is running (`python main.py`)
- Check the host and port in ClashControl match the MCP server config
- Default: `localhost:8080`

### "No clashes to push"
- Run clash detection first in ClashControl
- Make sure you have IFC models loaded

### CORS errors in browser console
- The Revit MCP server may need CORS headers configured
- For mcp-server-for-revit-python, this is usually handled automatically
- If not, start the server with `--cors` flag or add CORS middleware

## Cost Estimates

The AI bridge makes API calls on your behalf. Typical costs per operation:

| Operation | Tokens (approx.) | Cost (approx.) |
|---|---|---|
| Push 50 clashes | ~4,000 tokens | $0.01-0.05 |
| Pull status update | ~2,000 tokens | $0.005-0.02 |
| Test connection | ~200 tokens | < $0.001 |

Costs vary by provider. Google Gemini Flash is the cheapest, Anthropic Claude is the most capable.

## Privacy & Security

- Your API key is stored in **localStorage** in your browser only
- API calls go directly from your browser to the AI provider (Anthropic/OpenAI/Google)
- No data is sent to ClashControl servers (there are none — it's a static web app)
- The Revit MCP server runs on your local machine
- Your BIM data stays on your machine and in your AI provider's API (subject to their data policies)

## Without Revit (BCF Fallback)

If you don't have Revit or don't want to set up MCP, ClashControl already supports BCF export/import:

1. Export clashes as BCF from ClashControl (left sidebar export button)
2. Import BCF into Revit (Add-ins > BCF Manager)
3. Resolve clashes in Revit
4. Export updated BCF from Revit
5. Import back into ClashControl

The Revit Bridge makes this process automated and bidirectional — but BCF is the universal fallback.

## Supported Revit MCP Servers

| Server | Language | Stars | Read | Write | Link |
|---|---|---|---|---|---|
| mcp-server-for-revit-python | Python | 99+ | Yes | Yes | [GitHub](https://github.com/mcp-servers-for-revit/mcp-server-for-revit-python) |
| mcp-servers-for-revit | C# | 52+ | Yes | Yes | [GitHub](https://github.com/mcp-servers-for-revit/mcp-servers-for-revit) |
| revit_mcp | TypeScript | 19+ | Yes | Yes | [GitHub](https://github.com/PiggyAndrew/revit_mcp) |
| Autodesk-Revit-MCP-Server | C# | 10+ | Yes | Yes | [GitHub](https://github.com/Sam-AEC/Autodesk-Revit-MCP-Server) |

## Future Roadmap

- **Phase 2**: Direct .rvt file reading in the browser (when tooling matures)
- **Speckle Integration**: Load models directly from Speckle servers (cloud or self-hosted) into ClashControl, bypassing IFC export entirely. Speckle connects to Revit, Rhino, ArchiCAD, SketchUp, and 20+ other tools — making ClashControl the clash detection engine for the Speckle ecosystem. See `FEATURE_RESEARCH.md` for full details.
- **Auto-sync**: Scheduled polling for status changes
- **Multi-tool MCP**: Connect to Navisworks, Tekla, ArchiCAD via their MCP servers
- **AI clash resolution suggestions**: AI recommends how to fix clashes based on model constraints

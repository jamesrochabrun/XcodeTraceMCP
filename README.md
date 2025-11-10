# Xcode Instruments Trace Analyzer (MCP)

> Intelligent performance analysis for Xcode Instruments traces, powered by AI via Model Context Protocol.

Ask Claude to analyze your app's performance, detect regressions, and get actionable optimization recommendations—all through natural conversation.

---

## Quick Start

### 1. Build

```bash
pnpm install
pnpm build
```

### 2. Configure Your Claude Client

#### Option A: Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "xctrace-analyzer": {
      "command": "node",
      "args": ["/absolute/path/to/XcodeTraceMCP/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop.

#### Option B: Claude Code (Web)

1. Open this project in Claude Code
2. Create `.claude/mcp_settings.json` in the project root:

```json
{
  "mcpServers": {
    "xctrace-analyzer": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"]
    }
  }
}
```

3. Reload the window

The MCP server will now be available in Claude Code for this project.

#### Option C: Claude Code CLI

Add to `~/.config/claude/config.json`:

```json
{
  "mcpServers": {
    "xctrace-analyzer": {
      "command": "node",
      "args": ["/absolute/path/to/XcodeTraceMCP/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Restart your terminal session.

### 3. Use with Claude

```
You: Analyze my app's performance trace at ~/traces/myapp.trace

Claude: I've analyzed your trace. Found 2 critical bottlenecks:
        1. ImageProcessor.resize() - 450ms (67% of time)
           💡 Implement NSCache to avoid repeated processing
        ...
```

**That's it!** Claude can now analyze traces, detect regressions, and suggest optimizations.

---

## What It Does

### Analyze Traces
```
You: Analyze /path/to/app.trace
Claude: [Identifies bottlenecks, provides recommendations with code examples]
```

### Detect Regressions
```
You: Compare baseline.trace with current.trace
Claude: [Shows performance delta, regressions, improvements]
```

### List Available Tools
```
You: What Instruments templates are available?
Claude: [Lists all templates on your system]
```

---

## Features

- 🔍 **Automatic bottleneck detection** - Finds slow functions, calculates impact
- 📊 **Regression analysis** - Compare builds to catch performance issues
- 💡 **Smart recommendations** - Pattern-based suggestions with Swift code examples
- 🤖 **Natural language interface** - Just ask Claude in plain English
- ⚡️ **Fast** - Analyzes typical traces in < 2 seconds

---

## Architecture

Monorepo with two packages:

### [@xctrace-analyzer/core](./packages/core)
Reusable TypeScript library for trace analysis.

```typescript
import { analyzeTraceFile } from '@xctrace-analyzer/core';

const analysis = await analyzeTraceFile('/path/to/trace.trace');
console.log(analysis.bottlenecks);
console.log(analysis.recommendations);
```

### [@xctrace-analyzer/mcp-server](./packages/mcp-server)
MCP server exposing the core library to AI assistants.

**Tools:**
- `analyze_trace` - Analyze performance bottlenecks
- `compare_traces` - Detect regressions between builds
- `list_templates`, `list_devices`, `check_xctrace`

---

## Requirements

- **macOS** with Xcode Command Line Tools
- **Node.js** 18+
- **pnpm** (or npm/yarn)
- **Claude Desktop**, **Claude Code (Web/CLI)**, or another MCP-compatible client

---

## Documentation

- [Core Library Documentation](./packages/core/README.md)
- [MCP Server Documentation](./packages/mcp-server/README.md)
- [Research & Architecture](./MCP_RESEARCH_AND_ARCHITECTURE.md) - Deep dive into design decisions
- [Implementation Options](./IMPLEMENTATION_OPTIONS.md) - Why we chose this architecture

---

## Examples

### Analyze a trace
```
You: Check the performance of my latest build at ~/traces/v2.0.trace

Claude:
📊 Analysis Summary: Total time 5.2s across 3 threads.

🐌 Bottlenecks:
1. ImageProcessor.resize() - 450ms (critical)
2. JSONDecoder.decode() - 120ms (high)

💡 Recommendations:
- Implement NSCache for image caching (save ~400ms)
- Move JSON parsing to background thread
```

### Compare builds
```
You: Compare baseline.trace with current.trace and tell me if we regressed

Claude:
⚠️ Performance regressed by 15% (+0.65s)

Regressions:
🔴 NetworkClient.parseJSON() - 50ms → 85ms (+70%)

Improvements:
✅ DatabaseManager.fetch() - 200ms → 120ms (-40%)

The NetworkClient regression is concerning. Should I investigate?
```

---

## Contributing

This is a working MVP. To contribute:

1. Test with real trace files and report issues
2. Add support for more Instruments templates (Memory, Network, etc.)
3. Improve recommendation patterns
4. Add unit tests

---

## License

MIT

---

**Built by research-first approach.** See [MCP_RESEARCH_AND_ARCHITECTURE.md](./MCP_RESEARCH_AND_ARCHITECTURE.md) for the full story of how this was designed.

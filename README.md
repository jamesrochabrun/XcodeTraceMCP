# Xcode Instruments Trace Analyzer (MCP)

> Intelligent performance analysis for Xcode Instruments traces, powered by AI via Model Context Protocol.

Ask Claude to record and analyze Xcode Instruments traces, detect Time Profiler regressions, and get actionable optimization recommendations through a local MCP server.

This project is a **headless Instruments companion**, not a full replacement for Instruments.app. It automates the parts Apple exposes through `xcrun xctrace`: recording, TOC/XML/HAR export, symbolication, parsing, reports, and regression checks. When a template or Instruments view is not exportable, the server reports that limitation instead of inventing data.

---

## Installation

> ⚠️ **Not yet published to npm.** For now, you need to build from source (see below).

### 1. Clone and Build

```bash
git clone https://github.com/jamesrochabrun/XcodeTraceMCP.git
cd XcodeTraceMCP
pnpm install --frozen-lockfile
pnpm verify
```

### 2. Configure Your Claude Client

**Claude Desktop**
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

**Claude Code (Web)**
Create `.claude/mcp_settings.json` in your project:

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

**Claude Code CLI**
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

### 3. Restart your Claude client

---

## Usage

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

### Profile Running Apps
```
You: Profile the running app MyApp for 60 seconds with the full preset
Claude: [Records one combined xctrace session and reports CPU, leaks, allocations, and network findings]
```

### Analyze Existing Traces
```
You: Analyze /path/to/app.trace
Claude: [Identifies Time Profiler bottlenecks and Memory, Network, Energy, Allocations, or Leaks findings when those instruments are present]
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
- 🎥 **Automated recording** - Attach to a running app, capture a trace, and analyze it in one MCP call
- 🧭 **Multi-instrument analysis** - Auto-detects Memory, Network, Energy, Allocations, and Leaks data
- 📊 **Regression analysis** - Compare builds to catch performance issues
- 💡 **Smart recommendations** - Pattern-based suggestions with Swift code examples
- 🤖 **Natural language interface** - Just ask Claude in plain English
- 🧾 **Honest diagnostics** - Reports support status, export attempts, and non-exportable data

## Supported Scope

This repository is a local, repo-installable MCP server. `profile_running_app` can attach to a process, launch a target, or record all processes with one combined `xcrun xctrace record` session, save the `.trace`, and analyze it. `track_running_app` records one specific template. `analyze_trace` auto-detects Time Profiler, Memory, Network, Energy, Allocations, and Leaks data exported by `xcrun xctrace`; each area is reported as supported, partial, not exportable, or unsupported. `compare_traces` remains focused on Time Profiler regressions. Public npm publishing, a standalone CLI, and full Instruments.app GUI parity are out of scope for the current internal production target.

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
- `profile_advisor` - First-step helper for vague requests like "profile my app"; suggests the best workflow and exact next MCP tool call
- `profile_running_app` - Run one combined profiling recording against a running app and return one report. For macOS, the default `full` preset records Time Profiler with Leaks, Allocations, and HTTP Traffic instruments. Use `full-ios` when profiling iOS/iPadOS and you want Power Profiler too.
- `track_running_app` - Attach to a running app, capture a trace, and optionally analyze it immediately
- `analyze_trace` - Analyze Time Profiler bottlenecks plus supported Memory, Network, Energy, Allocations, and Leaks data; supports optional dSYM symbolication and JSON output
- `compare_traces` - Detect Time Profiler regressions between builds; supports optional dSYM symbolication and JSON output
- `list_templates`, `list_devices`, `check_xctrace`

---

## MCP Tool Reference

### `profile_advisor`

Use this first when the request is vague, such as "profile my app" or "what can we inspect?" It infers the likely intent, checks local `xctrace` capabilities, and returns a recommended tool call plus alternatives.

A user should be able to start from an app repo with a simple prompt:

```text
Profile this app for hangs and CPU bottlenecks.
```

For reliable validation, prefer attach-by-PID for already-running macOS apps. Launch mode is useful for startup-specific issues, but some Xcode/macOS combinations can save a `.trace` that later fails `xctrace export --toc` with `Document Missing Template Error`; treat that as a malformed or partial trace, not as a clean "no issues" result.

Hang results are scoped to the captured trace window. If the report says no exported hang events were found, that does not rule out startup or interaction hangs that happened outside the recording.

It can suggest:
- `profile_running_app` with `full`, `cpu`, `memory`, `network`, or `full-ios`
- `track_running_app` when a specific template is more appropriate
- `analyze_trace` for an existing `.trace`
- `compare_traces` for baseline/current regression checks

### `profile_running_app`

Best default tool when a user says "start profiling", "record performance", or "give me a full report" for an app that is already running.

It performs one `xcrun xctrace record` call. For the macOS `full` preset, it uses `Time Profiler` as the base template and adds `Leaks`, `Allocations`, and `HTTP Traffic` as Instruments. A `durationSeconds` value of `60` means one 60-second recording, plus save/export/analyze time.

Report sections include:
- Summary, trace path, process, preset, and recording strategy
- Support matrix and export diagnostics
- CPU / Time Profiler bottlenecks
- Leaks findings when exportable
- Allocation metrics and churn findings when exportable
- Network request metrics and failures when HAR/CFNetwork data is exportable
- Prioritized recommendations aggregated across all findings

Presets:
- `full`: Time Profiler + Leaks + Allocations + HTTP Traffic
- `full-ios`: Time Profiler + Leaks + Allocations + HTTP Traffic + Power Profiler
- `cpu`: Time Profiler only
- `memory`: Allocations + Leaks
- `network`: Time Profiler + HTTP Traffic
- `energy`: Power Profiler only; intended for iOS/iPadOS targets

### `track_running_app`

Use this when the user wants a specific Instruments template rather than a full preset. It records one trace with the requested template, then optionally analyzes it. It supports attach, launch, and all-processes targets; `processName` remains the attach shorthand.

Common templates:
- `Leaks` for memory leak checks
- `Allocations` for allocation churn
- `Network` for network-only traces
- `Time Profiler` for CPU sampling

### `analyze_trace`

Use this for an existing `.trace` file. The parser reads `xcrun xctrace export --toc`, exports supported schemas, and normalizes results into one analysis model.

It can report:
- Time Profiler bottlenecks, hot functions, and recommendations
- Additional Memory, Network, Energy, Allocations, and Leaks sections when Xcode exposes usable tables
- Clear no-data findings when a schema exists but Xcode does not export usable rows
- Machine-readable JSON via `outputFormat: "json"` or Markdown plus JSON via `outputFormat: "both"`

### `compare_traces`

Use this for Time Profiler regression checks between a baseline and current trace. It compares total time and function-level deltas, then can mark the MCP call as an error when `failOnRegression` is true.

### Discovery And Health Tools

- `list_templates`: shows Instruments templates available on the machine
- `list_devices`: shows physical devices and simulators available to `xctrace`
- `check_xctrace`: verifies `xcrun xctrace` availability and reports the installed version

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

### Profile a running app
```
You: Start profiling MyApp for 60 seconds and report all issues

Claude:
# Profiling Report

- Process: MyApp
- Preset: full
- Recording strategy: combined
- Duration: 60s
- Base template: Time Profiler
- Instruments: Leaks, Allocations, HTTP Traffic

## Summary
- Overall status: critical issues found
- Traces recorded: 1/1
- Traces analyzed: 1/1

## CPU / Time Profiler
Top bottlenecks and slow functions.

## Leaks
Leak count, leaked bytes, and leak findings.

## Allocations
Allocation volume and churn findings.

## Network
Requests, failures, bytes transferred, and hosts.

For iOS/iPadOS, use the `full-ios` preset to include Energy / Power data.
```

### Track a running app for leaks
```
You: Track MyApp for leaks for 60 seconds on the iPhone 16 Pro Simulator

Claude:
# Running App Trace Report

- Process: MyApp
- Template: Leaks
- Duration: 60s
- Device: iPhone 16 Pro Simulator
- Trace: /path/to/XcodeTraceMCP/test-traces/MyApp-Leaks-2026-05-02T16-30-00-000Z.trace

## Additional Instrument Analysis
### Leaks Analysis
3 leaks were detected.
```

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

Contributions welcome.

Before sending changes, run:

```bash
pnpm verify
```

To smoke-test the local Xcode/xctrace installation:

```bash
pnpm test:integration
```

To inspect the schemas exposed by local traces without committing trace files:

```bash
pnpm inspect:trace test-traces/memory.trace test-traces/network.trace
```

To contribute production support:

1. Fork, clone, and branch from `main`
2. Add or update real exported XML/HAR fixtures, not committed raw `.trace` files
3. Update the support matrix and docs for any newly supported template/schema
4. Improve recommendation patterns only when backed by parsed evidence
5. Add unit tests plus optional local integration validation
6. Submit a PR

Publishing to npm remains future work.

---

## License

MIT

---

**Built by research-first approach.** See [MCP_RESEARCH_AND_ARCHITECTURE.md](./MCP_RESEARCH_AND_ARCHITECTURE.md) for the full story of how this was designed.

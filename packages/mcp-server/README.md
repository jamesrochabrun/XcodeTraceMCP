# Xcode Instruments Trace Analyzer MCP Server

> Model Context Protocol server for intelligent Xcode Instruments trace analysis

This MCP server provides AI assistants like Claude with the ability to automate headless `xcrun xctrace` workflows: record traces, symbolicate traces, export TOC/XML/HAR data, detect Time Profiler bottlenecks, summarize exportable Memory/Network/Energy/Allocations/Leaks data, identify Time Profiler regressions, and provide actionable recommendations.

It is an **honest headless companion** for Instruments.app, not a complete GUI replacement. Any template or view that `xctrace` cannot export is reported as unsupported or not exportable.

## Features

- 🔍 **Intelligent Analysis** - Automatically identifies performance bottlenecks
- 🎥 **Automated Recording** - Attach to a running app, save a trace, and analyze it in one tool call
- 🧭 **Multi-Instrument Analysis** - Auto-detects Memory, Network, Energy, Allocations, and Leaks data when exportable
- 📊 **Regression Detection** - Compare traces to find performance regressions
- 💡 **Actionable Recommendations** - Get specific optimization suggestions with code examples
- 🧾 **Structured Diagnostics** - Support matrix, export attempts, and JSON output for CI or agents
- 🤖 **Natural Language Interface** - Use Claude to interact with your performance data
- ⚙️ **Local-first** - Runs through your installed Xcode Command Line Tools

## Installation

### Using with Claude Desktop

Add to your Claude Desktop configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "xctrace-analyzer": {
      "command": "node",
      "args": ["/path/to/XcodeTraceMCP/packages/mcp-server/dist/index.js"]
    }
  }
}
```

### Building from Source

```bash
# From the monorepo root
pnpm install --frozen-lockfile
pnpm verify
```

## Available Tools

## Tool Selection Guide

- Use `profile_running_app` for "start profiling", "full report", or "record all issues" requests against an already-running app.
- Use `profile_advisor` first when the request is vague and the user needs to choose what kind of profiling to run.
- Use `track_running_app` for a single explicit Instruments template such as Leaks or Allocations.
- Use `analyze_trace` when the user already has a `.trace` file.
- Use `compare_traces` when the user asks whether a current build regressed against a baseline.
- Use `list_templates`, `list_devices`, and `check_xctrace` for setup and troubleshooting.

### `profile_advisor`

Suggest the best profiling workflow before recording or analyzing anything. This is the best first tool for requests like "profile my app", "what can we inspect?", or "I don't know which Instruments template to use."

**Parameters:**
- `request` (optional): Natural-language profiling goal
- `processName`, `launchCommand`, `tracePath`, `baselinePath`, `currentPath` (optional): Known context
- `platform` (optional): `macos`, `ios`, or `unknown`
- `durationSeconds` (optional): Preferred recording duration
- `outputFormat` (optional): `markdown`, `json`, or `both`

The response includes a recommended next tool call and alternatives for full, CPU, memory/leaks, network, existing trace analysis, and regression comparison.

Recommended first prompt from an app repo:

```text
Use xctrace-analyzer profile_advisor first. I want to profile this app for hangs and CPU bottlenecks. Prefer attach-by-PID if the app is already running. Use outputFormat both. If launch-mode traces fail TOC export, report that as an exportability failure and retry with attach mode.
```

For already-running macOS apps, attach by PID is usually the most reliable path, especially when multiple processes share the same name. Use launch mode when startup behavior is the target, but treat `Document Missing Template Error` from `xctrace export --toc` as a saved-but-not-exportable trace rather than a valid "no issues" result.

### `profile_running_app`

Record a running app once with a profiling preset and return one combined report. `durationSeconds: 60` means one 60-second recording. The preset uses a base template plus additional Instruments where Xcode supports it.

**Parameters:**
- `processName` (optional): Running process name or pid to attach to; required for attach mode
- `target` (optional): `attach`, `launch`, or `all-processes`
- `launchCommand`, `launchArguments`, `environment` (optional): launch target details
- `preset` (optional): `full`, `full-ios`, `cpu`, `memory`, `network`, or `energy` (default: `full`)
- `durationSeconds` (optional): Total recording duration in seconds (default: 60)
- `device` (optional): Device or simulator name/UDID
- `outputDirectory` (optional): Directory where generated `.trace` files should be saved (default: `test-traces`)
- `analyze` (optional): Analyze after recording (default: true)
- `outputFormat` (optional): `markdown`, `json`, or `both` (default: `markdown`)

Preset recordings:
- `full`: Time Profiler base with Leaks, Allocations, and HTTP Traffic instruments
- `full-ios`: Time Profiler base with Leaks, Allocations, HTTP Traffic, and Power Profiler instruments
- `cpu`: Time Profiler
- `memory`: Allocations base with Leaks instrument
- `network`: Time Profiler base with HTTP Traffic instrument
- `energy`: Power Profiler. This is for iOS/iPadOS targets; Xcode reports it as unsupported for macOS recordings.

Report contents:
- Recording metadata: process, preset, duration, trace path, base template, and instruments
- Support matrix and export diagnostics
- CPU / Time Profiler: bottlenecks, top functions, threads, slow function count, and CPU recommendations
- Leaks: leak count, leaked bytes, top leak sites, and leak findings when Xcode exports usable data
- Allocations: allocation counts, allocated bytes, top allocation sites, and churn findings when exportable
- Network: request count, failed requests, transferred bytes, top hosts, and network failure findings when HAR/CFNetwork data is available
- Prioritized Recommendations: deduplicated CPU and instrument recommendations sorted for review

**Example with Claude:**
```
Start profiling MyApp for 60 seconds and report all issues
```

### `track_running_app`

Attach to a running process with `xcrun xctrace record`, save the generated `.trace`, and optionally analyze it immediately.

**Parameters:**
- `processName` (optional): Running process name or pid to attach to; required for attach mode
- `target` (optional): `attach`, `launch`, or `all-processes`
- `launchCommand`, `launchArguments`, `environment` (optional): launch target details
- `template` (optional): Instruments template, for example `Leaks`, `Allocations`, `Network`, `Power Profiler`, or `Time Profiler` (default: `Leaks`)
- `durationSeconds` (optional): Recording duration in seconds (default: 60)
- `device` (optional): Device or simulator name/UDID
- `outputDirectory` (optional): Directory where the `.trace` file should be saved (default: `test-traces`)
- `outputPath` (optional): Exact output `.trace` path. Overrides `outputDirectory`
- `analyze` (optional): Analyze after recording (default: true)
- `outputFormat` (optional): `markdown`, `json`, or `both` (default: `markdown`)

**Example with Claude:**
```
Track MyApp for leaks for 60 seconds on the iPhone 16 Pro Simulator
```

Use this tool when the user names a template. For broad profiling, prefer `profile_running_app`.

### `analyze_trace`

Analyze a single trace file for performance issues. The server auto-detects supported Time Profiler, Memory, Network, Energy, Allocations, and Leaks data from the trace TOC.

**Parameters:**
- `tracePath` (required): Path to .trace file
- `slowThreshold` (optional): Threshold in ms for slow functions (default: 100)
- `topN` (optional): Number of top functions to show (default: 10)
- `dsymPath` (optional): dSYM file or directory. The server writes a temporary symbolicated trace before analysis.
- `outputFormat` (optional): `markdown`, `json`, or `both`

**Example with Claude:**
```
Analyze /Users/me/app.trace and show me the performance bottlenecks
```

This tool does not record anything. It only reads trace files that already exist.

### `compare_traces`

Compare two Time Profiler traces to detect regressions or improvements.

**Parameters:**
- `baselinePath` (required): Path to baseline .trace file
- `currentPath` (required): Path to current .trace file
- `regressionThreshold` (optional): % increase to flag (default: 10)
- `failOnRegression` (optional): Mark the MCP tool result as an error if a regression is detected (default: false)
- `baselineDsymPath`, `currentDsymPath` (optional): dSYM paths used to symbolicate temporary traces before comparison
- `outputFormat` (optional): `markdown`, `json`, or `both`

**Example with Claude:**
```
Compare baseline.trace with current.trace and tell me if performance regressed
```

This comparison currently focuses on Time Profiler data. Additional instrument comparison is future work.

### `list_templates`

List all available Instruments templates on the system.

**Example with Claude:**
```
What Instruments templates are available?
```

### `list_devices`

List available devices for profiling.

**Example with Claude:**
```
Show me available devices for profiling
```

### `check_xctrace`

Check if xctrace is available and report command capabilities, templates, devices, instruments, export modes, and warnings.

**Example with Claude:**
```
Is xctrace available on this system?
```

## Usage Examples

### Full Profiling Report

```
You: Start profiling MyApp for 60 seconds and report all issues.

Claude: I'll record the full profiling preset and combine the results.

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

## Trace Files
- Time Profiler: /path/to/test-traces/MyApp-full-...trace
## Prioritized Recommendations
- critical Leaks Analysis: Leaks detected - The trace contains leaked memory.
```

### Automated Leak Tracking

```
You: Track MyApp for memory leaks for 60 seconds.

Claude: I'll record the running app with the Leaks template and analyze the trace.

# Running App Trace Report

- Process: MyApp
- Template: Leaks
- Duration: 60s
- Trace: /path/to/XcodeTraceMCP/test-traces/MyApp-Leaks-2026-05-02T16-30-00-000Z.trace

## Additional Instrument Analysis

### Leaks Analysis
3 leaks were detected.
```

### Basic Analysis

```
You: Claude, analyze my latest performance trace at ~/traces/myapp.trace

Claude: I've analyzed your trace. Here's what I found:

# Performance Analysis Report

**Duration:** 5.2s
**Template:** Time Profiler

## Summary
⚠️ Found 1 critical performance issue.
Total execution time: 5.2s across 3 threads.
Primary bottleneck: ImageProcessor.resize() (450ms, 8.7% of time).

## Performance Bottlenecks

### 🔴 1. ImageProcessor.resize()
- **Impact:** critical
- **Duration:** 450ms (8.7% of total)
- **Call count:** 24
- **Suggestion:** Consider caching rendered images or using lower resolution

## Optimization Recommendations

### ⚠️ Implement Image Caching
**Priority:** high | **Type:** caching

Frequent image operations detected. Consider implementing NSCache
or disk-based caching to avoid repeated processing.

**Potential improvement:** 50-70% reduction in image processing time

**Example:**
```swift
let imageCache = NSCache<NSString, UIImage>()

func cachedImage(for key: String) -> UIImage? {
    if let cached = imageCache.object(forKey: key as NSString) {
        return cached
    }
    let image = processImage(key)
    imageCache.setObject(image, forKey: key as NSString)
    return image
}
```
```

### Comparing Traces

```
You: Compare my baseline trace with the current build.
     Baseline: ~/traces/v1.0.trace
     Current: ~/traces/v2.0.trace

Claude: I've compared the two traces. Here's the analysis:

# Trace Comparison Report

**Baseline:** v1.0.trace
**Current:** v2.0.trace

## Summary
⚠️ Performance regressed by 15.3% (+0.65s slower).
🔴 Found 2 critical regressions.

## Performance Delta
⚠️ Total time change: +0.65s (+15.3%)
- Regressions: 3
- Improvements: 2
- Unchanged: 15

## Regressions

🔴 **NetworkClient.parseJSON()** (critical)
  50ms → 85ms (+70%)

🟠 **DatabaseManager.fetchAll()** (major)
  120ms → 180ms (+50%)

## Improvements

✅ **ImageProcessor.cache()***
  200ms → 80ms (-60%)

The NetworkClient regression is concerning and should be investigated.
```

### Development Workflow

```
You: I just profiled my app. Analyze the latest trace and help me optimize.

Claude: Let me analyze the latest trace...

[Analyzes trace]

I found 3 optimization opportunities:

1. 🎯 **High Impact** - ImageCache missing (save ~400ms)
2. 🎯 **Medium Impact** - JSON parsing on main thread (save ~150ms)
3. 🎯 **Low Impact** - Multiple small allocations (save ~50ms)

Would you like me to help implement any of these optimizations?

You: Yes, help with #1

Claude: Great! Let's implement image caching...
[Provides implementation guidance]
```

## Requirements

- **macOS** with Xcode Command Line Tools installed
- **Node.js** 18+ (for running the MCP server)
- **Claude Desktop** or another MCP-compatible client
- Time Profiler, Memory, Network, Energy, Allocations, or Leaks `.trace` files. Exported table availability depends on Xcode and the trace template.

## How It Works

1. **MCP Request**: The client calls a JSON-RPC tool such as `profile_running_app`.
2. **Capability Check**: The server can inspect local `xctrace` version, templates, devices, instruments, export modes, and symbolication support.
3. **xctrace Record**: Recording tools call `xcrun xctrace record` with attach, launch, or all-processes targets.
4. **xctrace Export**: Analysis calls `xcrun xctrace export --toc`, TOC-discovered XPath table exports, and HAR export when available.
5. **XML / HAR Parsing**: The core parser normalizes Time Profiler rows and supported instrument tables into typed data with export diagnostics.
6. **Analysis Engine**: The analyzer finds bottlenecks, instrument findings, support status, and recommendations.
7. **MCP Response**: The server returns Markdown, JSON, or both.

## Troubleshooting

### xctrace not found

Make sure Xcode Command Line Tools are installed:
```bash
xcode-select --install
```

### Permission errors

The .trace files must be readable. Check file permissions:
```bash
ls -la /path/to/trace.trace
```

### No supported data

The server reads supported tables from `xcrun xctrace export --toc` and uses HAR export for Network traces when available. If Xcode does not expose usable tables for a template, analysis may return a clear no-data section instead of findings.

### pnpm/Corepack warnings

The root `package.json` pins `pnpm` through `packageManager`. Use Corepack or install pnpm 10.6.3:
```bash
corepack enable
pnpm install --frozen-lockfile
```

### Server not connecting

1. Check Claude Desktop config file syntax (must be valid JSON)
2. Verify the path to index.js is correct
3. Restart Claude Desktop after config changes

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Typecheck, test, and build
pnpm verify

# Inspect schemas exposed by local traces
pnpm inspect:trace test-traces/memory.trace

# Development with watch mode
pnpm dev:mcp
```

## Architecture

```
MCP Client (Claude)
    ↓ JSON-RPC 2.0
MCP Server (this package)
    ↓
@xctrace-analyzer/core
    ↓
xcrun xctrace (macOS)
```

## License

MIT

## Contributing

Contributions welcome! Please see the main repository README for guidelines.

# Xcode Instruments Trace Analyzer MCP Server

> Model Context Protocol server for intelligent Xcode Instruments trace analysis

This MCP server provides AI assistants like Claude with the ability to analyze Xcode Instruments performance traces, detect bottlenecks, identify regressions, and provide actionable optimization recommendations.

## Features

- 🔍 **Intelligent Analysis** - Automatically identifies performance bottlenecks
- 📊 **Regression Detection** - Compare traces to find performance regressions
- 💡 **Actionable Recommendations** - Get specific optimization suggestions with code examples
- 🤖 **Natural Language Interface** - Use Claude to interact with your performance data
- ⚡️ **Fast** - Built on TypeScript with efficient parsing

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
pnpm install
pnpm build

# Or just the MCP server
cd packages/mcp-server
pnpm install
pnpm build
```

## Available Tools

### `analyze_trace`

Analyze a single trace file for performance issues.

**Parameters:**
- `tracePath` (required): Path to .trace file
- `slowThreshold` (optional): Threshold in ms for slow functions (default: 100)
- `topN` (optional): Number of top functions to show (default: 10)

**Example with Claude:**
```
Analyze /Users/me/app.trace and show me the performance bottlenecks
```

### `compare_traces`

Compare two traces to detect regressions or improvements.

**Parameters:**
- `baselinePath` (required): Path to baseline .trace file
- `currentPath` (required): Path to current .trace file
- `regressionThreshold` (optional): % increase to flag (default: 10)
- `failOnRegression` (optional): Fail if regression detected (default: false)

**Example with Claude:**
```
Compare baseline.trace with current.trace and tell me if performance regressed
```

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

Check if xctrace is available and working.

**Example with Claude:**
```
Is xctrace available on this system?
```

## Usage Examples

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

## How It Works

1. **xctrace Export**: The server calls `xcrun xctrace export` to extract data from .trace files
2. **XML Parsing**: Parses the Time Profiler XML output using fast-xml-parser
3. **Analysis Engine**: Analyzes function profiles, identifies bottlenecks, generates recommendations
4. **MCP Protocol**: Exposes tools via JSON-RPC 2.0 for AI assistants to call

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

# Development with watch mode
pnpm dev
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

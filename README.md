# Xcode Instruments Trace Analyzer (MCP)

> Intelligent Xcode Instruments trace analysis via Model Context Protocol - Built on comprehensive research and designed for AI assistants like Claude.

## 🎉 Status: MVP COMPLETE!

This repository contains both the **research documentation** and the **working implementation** of an MCP server that provides intelligent analysis of Xcode Instruments performance traces.

## 🚀 Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Build all packages
pnpm build

# 3. Configure Claude Desktop
# Add to ~/Library/Application Support/Claude/claude_desktop_config.json:
{
  "mcpServers": {
    "xctrace-analyzer": {
      "command": "node",
      "args": ["/path/to/XcodeTraceMCP/packages/mcp-server/dist/index.js"]
    }
  }
}

# 4. Restart Claude Desktop and start analyzing!
```

**Example conversation:**
```
You: Analyze my app's performance trace at ~/traces/myapp.trace
Claude: I've analyzed your trace and found 2 critical bottlenecks...
```

See [packages/mcp-server/README.md](./packages/mcp-server/README.md) for detailed usage.

---

## 📦 Packages

This is a monorepo containing two main packages:

### [@xctrace-analyzer/core](./packages/core)
Core TypeScript library for parsing and analyzing Xcode Instruments traces.

**Features:**
- Parse Time Profiler traces from xctrace XML
- Identify performance bottlenecks automatically
- Compare traces for regression detection
- Generate actionable optimization recommendations
- Pattern-based suggestion engine

**Usage:**
```typescript
import { analyzeTraceFile, compareTraceFiles } from '@xctrace-analyzer/core';

const analysis = await analyzeTraceFile('/path/to/app.trace');
console.log(analysis.bottlenecks);
console.log(analysis.recommendations);
```

[📖 Full Core Library Documentation](./packages/core/README.md)

### [@xctrace-analyzer/mcp-server](./packages/mcp-server)
MCP server that exposes the core library via Model Context Protocol.

**MCP Tools:**
- `analyze_trace` - Analyze single trace for bottlenecks
- `compare_traces` - Compare two traces, detect regressions
- `list_templates` - List available Instruments templates
- `list_devices` - List available devices for profiling
- `check_xctrace` - Check xctrace availability

[📖 Full MCP Server Documentation](./packages/mcp-server/README.md)

---

## 📚 Documentation

### Research Documents

1. **[MCP_RESEARCH_AND_ARCHITECTURE.md](./MCP_RESEARCH_AND_ARCHITECTURE.md)** - Comprehensive research findings
   - MCP protocol overview and best practices
   - xctrace CLI capabilities and limitations
   - Analysis of existing tools (xctools-mcp-server)
   - Detailed architecture design with diagrams
   - Component specifications and data models
   - Implementation phases and timeline
   - Example usage scenarios

2. **[IMPLEMENTATION_OPTIONS.md](./IMPLEMENTATION_OPTIONS.md)** - Implementation strategy guide
   - Three implementation options with pros/cons
   - Detailed comparison matrix
   - Recommended approach (Hybrid architecture)
   - Quick start guides for each option
   - Decision framework to choose the right path
   - Technical stack recommendations

## 🎯 Project Goal

Build an **intelligent MCP server** that analyzes Xcode Instruments `.trace` files and provides:
- 🔍 Automatic performance bottleneck detection
- 📊 Regression analysis (compare builds)
- 💡 Actionable optimization recommendations
- 🤖 Natural language interface via Claude
- 🚀 CI/CD integration for automated performance testing

## 🔑 Key Findings

### What Exists Today
- **Instruments.app** - Manual GUI-based analysis
- **xctrace CLI** - Raw data export (XML), no analysis
- **xctools-mcp-server** - Basic MCP wrapper for xctrace (recording/export only)

### The Gap (Our Opportunity)
None of the existing tools provide:
- ❌ Intelligent performance analysis
- ❌ Automated regression detection
- ❌ Actionable recommendations
- ❌ Natural language interface
- ❌ CI/CD-ready workflows

### Our Solution
An **Analysis-First MCP Server** that focuses on:
- ✅ Interpreting trace data intelligently
- ✅ Identifying bottlenecks automatically
- ✅ Comparing traces for regression detection
- ✅ Providing specific optimization recommendations
- ✅ Enabling AI-assisted performance optimization

## 🏗️ Recommended Architecture

**Hybrid Approach (3 Packages):**

```
xctrace-analyzer/
├── packages/
│   ├── core/              # Pure analysis library (reusable)
│   ├── mcp-server/        # MCP wrapper
│   └── cli/               # CLI tool (optional)
```

**Why Hybrid?**
- ✅ Reusable core library for multiple use cases
- ✅ Clean separation of concerns
- ✅ Future-proof (VS Code extension, web app, etc.)
- ✅ Best portfolio showcase
- ✅ Easier to test and maintain

## 🚀 Quick Summary of Options

| Option | Time | Best For | Portfolio Impact |
|--------|------|----------|------------------|
| **1. Extend xctools-mcp** | 2-3 weeks | Fast MVP | Medium |
| **2. New TypeScript Server** | 4-5 weeks | Full control | High |
| **3. Hybrid Library + MCP** | 4-5 weeks | **Maximum flexibility** | **Very High** ⭐️ |

**Recommended:** Option 3 (Hybrid)

## 💡 Core Features

### MCP Tools (Model-Driven)
- `analyze_trace` - Analyze single trace for bottlenecks
- `compare_traces` - Compare two traces, detect regressions
- `find_bottlenecks` - Identify slow functions
- `generate_report` - Create formatted reports
- `list_traces` - Find available trace files
- `record_trace` - Record new performance trace

### MCP Resources (App-Driven)
- `trace:///{path}` - Access trace data and analysis
- `trace-list:///` - Browse available traces
- `performance-history:///{app}` - Historical trends

### MCP Prompts (User-Driven Workflows)
- `analyze-latest-build` - Quick analysis of most recent build
- `detect-regression` - Compare with baseline
- `performance-report` - Generate comprehensive report

## 🎨 Example Usage

```
Developer: "Claude, analyze my app's performance"

Claude (using our MCP server):
  ✅ Finds latest trace automatically
  ✅ Parses and analyzes
  ✅ Identifies slow functions
  ✅ Provides recommendations

  "I found a bottleneck in ImageProcessor.resize()
   taking 450ms (67% of time). Consider implementing
   an image cache to avoid repeated resizing."
```

```
Developer: "Compare with yesterday's build"

Claude:
  ✅ Locates baseline trace
  ✅ Performs comparison
  ✅ Highlights regressions

  "Performance regressed by 15%:
   - NetworkClient.parse() 50ms → 85ms (+70%)
   This is concerning. Should I investigate?"
```

## 📦 Technology Stack

**Language:** TypeScript
- Official MCP SDK support
- npm ecosystem
- Type safety
- Easy deployment (npx)

**Key Libraries:**
- `@modelcontextprotocol/sdk` - MCP server/client
- `fast-xml-parser` - Parse xctrace XML exports
- `chokidar` - File system watching
- `vitest` - Testing

**Distribution:**
- npm packages
- Docker container
- Homebrew (future)

## 📅 Implementation Timeline

### Week 1-2: Core Library
- TraceParser (xctrace XML → TypeScript models)
- PerformanceAnalyzer (bottleneck detection)
- ComparativeAnalyzer (regression detection)
- RecommendationEngine (optimization suggestions)

### Week 3: MCP Server
- Tool implementations
- Resource providers
- Prompt templates
- Claude Desktop integration

### Week 4: CLI & Polish
- CLI tool using core library
- Documentation
- Examples
- CI/CD setup

### Week 5: Launch
- Demo video
- Blog post
- Community outreach

## 🎯 Success Metrics

**Developer Value:**
- ✅ Reduces performance issue identification from hours to seconds
- ✅ Enables automated regression detection in CI/CD
- ✅ Provides actionable recommendations, not raw data
- ✅ Natural language interface via AI assistants

**Technical Excellence:**
- ✅ Sub-second analysis for typical traces
- ✅ Handles traces up to 1GB
- ✅ 90%+ accuracy in bottleneck identification
- ✅ >80% test coverage

**Community Impact:**
- ✅ First MCP server for intelligent Instruments analysis
- ✅ Fills gap between xctrace CLI and Instruments.app
- ✅ Enables new AI-assisted performance optimization workflows

## 🔗 Related Projects

**MCP Ecosystem:**
- [Model Context Protocol](https://modelcontextprotocol.io) - Official specification
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Servers](https://github.com/modelcontextprotocol/servers) - Official examples

**Xcode/Instruments Tools:**
- [xctools-mcp-server](https://github.com/nzrsky/xctools-mcp-server) - Basic xctrace MCP wrapper
- [TraceUtility](https://github.com/Qusic/TraceUtility) - Extract data from traces (Swift)
- [instrumentsToPprof](https://github.com/google/instrumentsToPprof) - Convert to pprof format

## 🚀 Next Steps

### If You're Building This

1. **Read the docs**
   - Review [MCP_RESEARCH_AND_ARCHITECTURE.md](./MCP_RESEARCH_AND_ARCHITECTURE.md) for deep dive
   - Review [IMPLEMENTATION_OPTIONS.md](./IMPLEMENTATION_OPTIONS.md) for implementation choices

2. **Choose your path**
   - Extend existing xctools-mcp-server (fastest)
   - Build new TypeScript server (full control)
   - **Hybrid approach (recommended)** - Reusable library + MCP wrapper

3. **Start building**
   - Set up project structure
   - Begin with core library
   - Add MCP wrapper
   - Test with Claude Desktop

4. **Share with community**
   - Open source on GitHub
   - Publish to npm
   - Share on Twitter, Reddit, iOS dev communities

## 📖 Additional Resources

### Learning MCP
- [MCP Best Practices](https://modelcontextprotocol.info/docs/best-practices/)
- [Building MCP Servers Guide](https://www.freecodecamp.org/news/how-to-build-a-custom-mcp-server-with-typescript-a-handbook-for-developers/)
- [MCP Examples](https://github.com/modelcontextprotocol/servers)

### Xcode Instruments
- Run `man xctrace` on macOS
- [Stack Overflow: xctrace tag](https://stackoverflow.com/questions/tagged/xctrace)
- [Apple Developer Forums](https://developer.apple.com/forums)

### Performance Analysis
- [WWDC Videos on Instruments](https://developer.apple.com/videos/)
- [Optimizing Swift Performance](https://www.swift.org/documentation/)

## 🤝 Contributing

This is a research repository. If you're building this tool:

1. **Share your implementation** - Let others learn from your work
2. **Provide feedback** - Are these docs helpful? What's missing?
3. **Add resources** - Found useful tools or articles? Add them!

## 📄 License

This research documentation is provided as-is for educational and planning purposes.

---

**Ready to build?** Start with the detailed architecture document and choose your implementation path!

**Questions?** Open an issue or discussion in this repository.

**Let's make iOS/macOS performance analysis AI-powered!** 🚀

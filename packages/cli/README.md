# Xcode Instruments Trace Analyzer CLI

Command-line interface for recording, analyzing, comparing, and cleaning up Xcode Instruments `.trace` bundles.

```bash
npx -y @xctrace-analyzer/cli doctor
npx -y @xctrace-analyzer/cli analyze ./App.trace --format both
npx -y @xctrace-analyzer/cli record --process 123 --duration 60 --preset full
npx -y @xctrace-analyzer/cli track Leaks --process 123 --duration 60
npx -y @xctrace-analyzer/cli compare baseline.trace current.trace --fail-on-regression
```

The CLI uses `@xctrace-analyzer/core` directly and is intended for humans, CI, and agents that need a reliable process boundary. The MCP server remains the typed assistant integration layer.

## How It Fits

- `@xctrace-analyzer/core` owns shared xctrace recording, export, parsing, analysis, recommendations, and comparisons.
- `@xctrace-analyzer/cli` is the durable process boundary for terminal workflows, CI, and shell-based agents. Use it when startup time, client timeouts, exit codes, logs, or supervision matter.
- `@xctrace-analyzer/mcp-server` exposes typed tools for MCP-compatible assistants. Use it when the assistant needs tool schemas, progress notifications, and structured tool responses.
- `skills/xctrace-profiler` is the planning layer. It can choose MCP tools in MCP clients or equivalent CLI commands in terminal/CI contexts while hiding implementation details from users.

Future iOS debugging tools should be exposed here first when they need reliable local execution, then wrapped by MCP and skill guidance when useful.

## Security Defaults

Attach profiling and trace analysis are enabled by default. Launch profiling, all-process profiling, output outside the trace root, and destructive cleanup outside the trace root must be explicitly enabled through environment variables:

```bash
XCTRACE_ANALYZER_ALLOW_LAUNCH=1
XCTRACE_ANALYZER_ALLOW_ALL_PROCESSES=1
XCTRACE_ANALYZER_ALLOW_EXTERNAL_OUTPUT=1
XCTRACE_ANALYZER_ALLOW_EXTERNAL_CLEANUP=1
XCTRACE_ANALYZER_TRACE_ROOT="/path/to/traces"
XCTRACE_ANALYZER_MAX_DURATION_SECONDS=300
XCTRACE_ANALYZER_REDACTION=balanced
```

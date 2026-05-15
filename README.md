# Xcode Instruments Trace Analyzer (MCP)

https://github.com/user-attachments/assets/e92cbd43-cd6c-4ec9-9392-d0d2408a648d

> Intelligent performance analysis for Xcode Instruments traces, powered by AI via Model Context Protocol.

Record and analyze Xcode Instruments traces from a CLI, CI job, local agent shell, or MCP-compatible assistant. Claude/Codex users still get the natural-language MCP workflow, while the CLI provides a durable execution surface for long-running profiling commands.

This project is an **Instruments companion**, not a full replacement for Instruments.app. It automates the parts Apple exposes through `xcrun xctrace`: recording, TOC/XML/HAR export, symbolication, parsing, reports, regression checks, and safe trace cleanup. Recording tools open the saved `.trace` in Instruments.app by default so areas that are not present in the trace or not exportable can be verified in the GUI. When a template or Instruments view is not exportable, the server reports that limitation instead of inventing data.

---

## Installation

### Claude Code

```bash
claude mcp add --transport stdio --scope user xctrace-analyzer -- npx -y @xctrace-analyzer/mcp-server@latest
```

Verify the local `xcrun xctrace` setup:

```bash
npx -y @xctrace-analyzer/mcp-server@latest --check
```

### Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "xctrace-analyzer": {
      "command": "npx",
      "args": ["-y", "@xctrace-analyzer/mcp-server@latest"]
    }
  }
}
```

### Codex CLI

```bash
codex mcp add xctrace-analyzer -- npx -y @xctrace-analyzer/mcp-server@latest
```

Check that Codex registered the server:

```bash
codex mcp list
```

### Optional Environment Settings

Claude Desktop-style MCP configs can pass security settings through `env`:

```json
{
  "mcpServers": {
    "xctrace-analyzer": {
      "command": "npx",
      "args": ["-y", "@xctrace-analyzer/mcp-server@latest"],
      "env": {
        "XCTRACE_ANALYZER_TRACE_ROOT": "/Users/you/Library/Application Support/xctrace-analyzer/traces",
        "XCTRACE_ANALYZER_ALLOW_LAUNCH": "1"
      }
    }
  }
}
```

Codex can pass the same settings with `--env`:

```bash
codex mcp add xctrace-analyzer \
  --env XCTRACE_ANALYZER_TRACE_ROOT="/Users/you/Library/Application Support/xctrace-analyzer/traces" \
  --env XCTRACE_ANALYZER_ALLOW_LAUNCH=1 \
  -- npx -y @xctrace-analyzer/mcp-server@latest
```

### Build From Source

```bash
git clone https://github.com/jamesrochabrun/XcodeTraceMCP.git
cd XcodeTraceMCP
pnpm install --frozen-lockfile
pnpm verify
```

For local source installs, point your MCP client at `packages/mcp-server/dist/index.js`.

### CLI

Use the CLI when you want the same recording and analysis workflows from a terminal, CI job, or agent shell without starting an MCP server:

```bash
npx -y @xctrace-analyzer/cli@latest doctor
npx -y @xctrace-analyzer/cli@latest analyze ./App.trace --format both
npx -y @xctrace-analyzer/cli@latest record --process 123 --duration 60 --preset full
npx -y @xctrace-analyzer/cli@latest track Leaks --process 123 --duration 60
npx -y @xctrace-analyzer/cli@latest compare baseline.trace current.trace --fail-on-regression
```

### How The CLI, MCP, And Skill Work Together

`@xctrace-analyzer/core` owns the durable implementation: `xcrun xctrace` command construction, recording, symbolication, exports, parsing, analysis, recommendations, and comparison logic. New diagnostics should start there when they need shared logic.

`@xctrace-analyzer/cli` is the process boundary for humans, CI, and agents that need reliability outside MCP startup and stdio lifecycles. Use it for terminal workflows, scripted checks, and long-running captures where exit codes, logs, shell supervision, and retry behavior matter.

`@xctrace-analyzer/mcp-server` remains the typed assistant integration layer. It should stay fast to start, validate tool arguments, expose MCP-friendly schemas, format Markdown/JSON responses, and delegate real work to shared core functionality.

The bundled `xctrace-profiler` skill is the planning layer. It lets users ask for outcomes like "Profile this app" or "Find why this hang happened", then chooses the MCP tools or CLI commands needed for the environment. The skill should hide JSON/tool details from users and explain the resulting trace support matrix, export diagnostics, and app-owned code findings.

Future iOS debugging capabilities should follow the same shape: implement reusable behavior in `core` where practical, expose a stable CLI command first, then add MCP tools and skill guidance when an assistant workflow needs them.

---

## Avoiding Recording Interruptions

Trace recording runs as a single uninterrupted `xcrun xctrace` session. If your assistant pauses mid-recording to ask for tool approval, the capture window can drift or the run may need to be restarted. To keep recordings clean, before starting a profile:

- **Claude Code**: switch to **auto** permission mode (Shift+Tab or `/permissions`) so MCP tool calls are not gated by approval prompts during recording.
- **Codex**: enable **auto-review** so recording is not interrupted by approval gates.

Re-enable interactive approvals afterward if you prefer a stricter mode for the rest of your session.

---

## Recommended User Experience

For clients that support skills, register the bundled skill at [`skills/xctrace-profiler`](./skills/xctrace-profiler/SKILL.md). npm installs also include the same skill at `node_modules/@xctrace-analyzer/mcp-server/skills/xctrace-profiler`. Once the skill is available, users can start from normal language:

```text
Profile this app.
```

Useful prompts:

```text
Find why this app is slow.
Profile this app for hangs and tell me which of my code is responsible.
Check this build for leaks and allocation churn.
Analyze network activity.
Launch this app and profile startup hangs.
I will launch MyApp; record it for 60 seconds when it appears.
Analyze this trace.
Compare these two traces.
Clean up profiling traces when we are done.
```

The skill is the user-facing planner. It chooses the target, selects the recording or analysis workflow, records or analyzes with `outputFormat: "both"` when diagnostics matter, can wait for a manually launched app and attach to the first valid PID without a second prompt, can rerun `analyze_trace` with `timeRangeMs` around a hang so the final answer names app-owned code from `## Top User-Code Frames`, and offers `cleanup_traces` once the saved trace is no longer needed.

Use the raw MCP tools directly only when building another integration, test, or scripted workflow.

---

## Usage

```
You: Profile this app.

Claude: I'll choose the profiling workflow, record or analyze the trace, and report the app-owned code responsible.
```

**That's it.** Claude can now profile apps, analyze traces, detect regressions, and suggest optimizations.

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
- 🎥 **Automated recording** - Attach to a running app, capture a trace, open it in Instruments.app by default, and analyze it in one MCP call
- 🧭 **Multi-instrument analysis** - Auto-detects Memory, Network, Energy, Allocations, and Leaks data
- 🧊 **Hang-focused workflow** - Captures hang events, scopes follow-up analysis to the hang window, and attributes samples to app code
- 📊 **Regression analysis** - Compare builds to catch performance issues
- 💡 **Smart recommendations** - Pattern-based suggestions with Swift code examples
- 🤖 **Natural language interface** - Just ask Claude in plain English
- 🧾 **Honest diagnostics** - Reports support status, export attempts, and non-exportable data
- 🧹 **Safe trace cleanup** - Preview or delete `.trace` bundles after the user is done inspecting them

## Supported Scope

This repository is a local diagnostics toolkit distributed through npm/npx and usable from source. The CLI and MCP server both use the shared core analyzer. `record` / `profile_running_app` can attach to a process, launch a target, or record all processes with one combined `xcrun xctrace record` session, save the `.trace`, open it in Instruments.app by default where applicable, and analyze it. `track` / `track_running_app` records one specific template and can also analyze the saved trace. Recorded traces are retained so users can inspect them in Instruments.app; `cleanup` / `cleanup_traces` previews or deletes `.trace` bundles after the user confirms they are no longer needed. `analyze` / `analyze_trace` auto-detects Time Profiler, Memory, Network, Energy, Allocations, and Leaks data exported by `xcrun xctrace`; each area is reported as available, partial, not exportable, or not present in the trace. If a GUI track such as Leaks is visible in Instruments.app but `xcrun export --toc` exposes no exportable table schema, the report marks that family as `not_exportable`, not as "no issues." Existing traces can be scoped with `timeRangeMs` to answer "what ran during this hang window?" without re-recording, and Top User-Code Frames attribute Time Profiler samples to app binaries instead of system frames. If Time Profiler export or parsing fails, the report says it failed to parse instead of presenting zero-thread CPU data as a valid result. `compare` / `compare_traces` remains focused on Time Profiler regressions. Full Instruments.app GUI parity remains out of scope.

---

## Architecture

Monorepo with three packages:

### [@xctrace-analyzer/core](./packages/core)
Reusable TypeScript library for trace analysis.

```typescript
import { analyzeTraceFile } from '@xctrace-analyzer/core';

const analysis = await analyzeTraceFile('/path/to/trace.trace');
console.log(analysis.bottlenecks);
console.log(analysis.recommendations);
```

### [@xctrace-analyzer/cli](./packages/cli)
CLI-first execution surface for humans, CI, and agents. It calls `@xctrace-analyzer/core` directly and exposes setup checks, template/device discovery, trace analysis, trace comparison, preset recording, single-template tracking, and safe cleanup through the `xctrace-analyzer` binary.

```bash
xctrace-analyzer doctor
xctrace-analyzer analyze ./App.trace --format json
xctrace-analyzer record --process 123 --preset full --duration 60
```

### [@xctrace-analyzer/mcp-server](./packages/mcp-server)
MCP server exposing the core library to AI assistants.

**Tools:**
- `profile_running_app` - Run one combined profiling recording against a running app and return one report. For macOS, the default `full` preset records Time Profiler with Leaks, Allocations, and HTTP Traffic instruments. Use `full-ios` when profiling iOS/iPadOS and you want Power Profiler too.
- `track_running_app` - Attach to a running app, capture a trace, and optionally analyze it immediately
- `analyze_trace` - Analyze Time Profiler bottlenecks plus supported Memory, Network, Energy, Allocations, and Leaks data; supports optional dSYM symbolication, time-window scoping, user-code frame attribution, and JSON output
- `compare_traces` - Detect Time Profiler regressions between builds; supports optional dSYM symbolication and JSON output
- `cleanup_traces` - Preview or delete generated `.trace` bundles after inspection
- `list_templates`, `list_devices`, `check_xctrace`

### Security Defaults

The MCP server keeps normal attach profiling and existing trace analysis available by default. These settings do not remove Time Profiler, Leaks, Allocations, HTTP Traffic, or other Instruments from normal recordings. They only restrict operations that can execute local programs, capture unrelated app activity, write arbitrary paths, delete arbitrary traces, or print sensitive details in reports.

| Option | Default | Why it matters | When to enable |
| --- | --- | --- | --- |
| `XCTRACE_ANALYZER_ALLOW_LAUNCH=1` | Disabled | Launch profiling can execute local programs through `xcrun xctrace --launch`; this is useful for startup profiling but equivalent to granting the MCP server permission to run the requested app or command. | Trusted local sessions where you need true cold-start or launch-time capture. |
| `XCTRACE_ANALYZER_ALLOW_ALL_PROCESSES=1` | Disabled | All-process traces can include activity from unrelated apps and background services, not just the target under investigation. | System-wide investigations where the user explicitly accepts broader capture. |
| `XCTRACE_ANALYZER_TRACE_ROOT=/path/to/traces` | `~/Library/Application Support/xctrace-analyzer/traces` | Keeps generated traces in a predictable user-level location. | Use a larger local scratch directory or project-specific trace folder. |
| `XCTRACE_ANALYZER_ALLOW_EXTERNAL_OUTPUT=1` | Disabled | Prevents writes outside the trace root, including launch stdin/stdout redirection paths. | Trusted automation that must save traces or launch streams to a known external directory. |
| `XCTRACE_ANALYZER_ALLOW_EXTERNAL_CLEANUP=1` | Disabled | Prevents destructive cleanup outside the trace root, except exact traces recorded by the current server instance. | Trusted maintenance scripts after a dry-run preview. |
| `XCTRACE_ANALYZER_MAX_DURATION_SECONDS=300` | `300` | Bounds trace size and recording time so an accidental request does not capture indefinitely or produce huge exports. | Longer repros where the user expects larger traces. |
| `XCTRACE_ANALYZER_REDACTION=balanced` | `balanced` | Redacts common secrets and local user paths in MCP output. `strict` also redacts hosts; `off` preserves full local details. | Use `strict` for shared reports; use `off` only in trusted local debugging. |

For startup profiling without enabling launch mode, start the app manually and attach by exact PID as soon as it appears. For trusted local startup profiling, start the MCP server with launch enabled:

```bash
XCTRACE_ANALYZER_ALLOW_LAUNCH=1 npx -y @xctrace-analyzer/mcp-server@latest
```

---

## MCP Tool Reference

### `profile_running_app`

Best default tool when a user says "start profiling", "record performance", or "give me a full report" for an app that is already running.

It performs one `xcrun xctrace record` call. For the macOS `full` preset, it uses `Time Profiler` as the base template and adds `Leaks`, `Allocations`, and `HTTP Traffic` as Instruments. A `durationSeconds` value of `60` means one 60-second recording, plus save/export/analyze time.

Report sections include:
- Summary, trace path, process, preset, recording strategy, and whether Instruments.app opened
- Support matrix and export diagnostics
- CPU / Time Profiler bottlenecks
- Main-thread hang events; severe hangs are reported as critical findings even if no CPU function crosses the Time Profiler bottleneck threshold
- Top User-Code Frames for app-attributed CPU work
- Time Profiler parse-failure callouts when CPU samples could not be parsed
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

`profile_running_app` opens the saved trace in Instruments.app by default after recording. Pass `openInInstruments: false` for CI or headless automation. The report keeps the trace path visible and reminds agents to use `cleanup_traces` after the user is done with the trace.

### `track_running_app`

Use this when the user wants a specific Instruments template rather than a full preset. It records one trace with the requested template, then optionally analyzes it. It supports attach, launch, and all-processes targets; `processName` remains the attach shorthand.

`track_running_app` opens the saved trace in Instruments.app by default after recording. Pass `openInInstruments: false` for CI or headless automation. The report keeps the trace path visible and reminds agents to use `cleanup_traces` after the user is done with the trace.

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
- Clear status when a family is available, partial, not exportable, or not present in the trace
- Scoped Time Profiler samples and hang events with `timeRangeMs: { startMs, endMs }`
- Top User-Code Frames, using trace process metadata plus optional `userBinaryHints`
- A Time Profiler parse-failure message when CPU samples could not be parsed; this is an analyzer/export issue, not evidence of zero CPU work
- Machine-readable JSON via `outputFormat: "json"` or Markdown plus JSON via `outputFormat: "both"`

Example scoped follow-up after a hang starts near 2 seconds and lasts about 5 seconds:

```json
{
  "tracePath": "/path/to/app.trace",
  "timeRangeMs": { "startMs": 2000, "endMs": 7000 },
  "userBinaryHints": ["MyApp"],
  "outputFormat": "both"
}
```

### `compare_traces`

Use this for Time Profiler regression checks between a baseline and current trace. It compares total time and function-level deltas, then can mark the MCP call as an error when `failOnRegression` is true.

### `cleanup_traces`

Use this after a profiling session when the user has finished inspecting the saved `.trace` in Instruments.app. The tool only acts on paths ending in `.trace`.

Safe defaults:
- `dryRun` defaults to `true`, so the first call previews what would be deleted.
- Exact `tracePaths` can be deleted with `dryRun: false` after confirmation.
- Directory cleanup requires `olderThanMinutes` when `dryRun: false`; this avoids accidentally deleting every trace in a folder.

Example after a report:

```json
{
  "tracePaths": ["/path/to/MyApp-full.trace"],
  "dryRun": false
}
```

### Discovery And Health Tools

- `list_templates`: shows Instruments templates available on the machine
- `list_devices`: shows physical devices and simulators available to `xctrace`
- `check_xctrace`: verifies `xcrun xctrace` availability and reports the installed version

---

## Requirements

- **macOS** with Xcode Command Line Tools
- **Node.js** 18+
- **pnpm** only for source development
- **Claude Desktop**, **Claude Code (Web/CLI)**, or another MCP-compatible client

---

## Documentation

- [Bundled Xcode Trace Profiler Skill](./skills/xctrace-profiler/SKILL.md)
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

### Record a manual launch
```
You: I will launch MyApp; record it for 60 seconds when it appears.

Claude:
I'm watching for MyApp now; launch it when ready.

# Profiling Report

- Target: MyApp PID 12345, attached immediately after launch
- Duration: 60s
- Preset: full
- Trace: ~/Library/Application Support/xctrace-analyzer/traces/MyApp-full-...trace
- Instruments.app: opened
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
- Trace: ~/Library/Application Support/xctrace-analyzer/traces/MyApp-Leaks-2026-05-02T16-30-00-000Z.trace

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

To run the packaged MCP stdio smoke test:

```bash
pnpm build
pnpm test:mcp-smoke
```

To contribute production support:

1. Fork, clone, and branch from `main`
2. Add or update real exported XML/HAR fixtures, not committed raw `.trace` files
3. Update the support matrix and docs for any newly supported template/schema
4. Improve recommendation patterns only when backed by parsed evidence
5. Add unit tests plus optional local integration validation
6. Submit a PR

Public npm packages are released from tagged builds after `pnpm verify` and the MCP stdio smoke test pass.

Release checklist:

1. Create and control the `@xctrace-analyzer` npm organization.
2. Set `NPM_TOKEN` in the GitHub repository secrets, or switch the release workflow to npm trusted publishing.
3. Push a `vX.Y.Z` tag after updating package versions and `server.json`.
4. After npm publish succeeds, authenticate with the MCP Registry and run `mcp-publisher publish` from the repo root.

---

## License

MIT

---

**Built by research-first approach.** See [MCP_RESEARCH_AND_ARCHITECTURE.md](./MCP_RESEARCH_AND_ARCHITECTURE.md) for the full story of how this was designed.

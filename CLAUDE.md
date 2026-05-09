# Agent Guide

This repository contains a local Model Context Protocol (MCP) server for Xcode Instruments profiling. Treat it as an honest `xcrun xctrace` companion, not a replacement for Instruments.app. The server records, opens saved traces in Instruments.app by default, symbolicates, exports, parses, and analyzes what Apple exposes through `xctrace`, then reports unsupported or non-exportable data explicitly.

## Project Architecture

The repo is a pnpm workspace with two packages:

- `packages/core`: reusable TypeScript library for `xcrun xctrace` capability checks, recording/exporting, symbolication, trace parsing, analysis, recommendations, and Time Profiler comparisons.
- `packages/mcp-server`: MCP stdio server that exposes the core library as assistant-callable tools.

High-level flow:

1. An MCP client calls a tool such as `profile_running_app`.
2. The MCP server validates arguments and delegates to `@xctrace-analyzer/core`.
3. Core runs `xcrun xctrace` using `execFile` argument arrays.
4. Core parses `xctrace export --toc`, TOC-driven XPath table XML, and HAR output when available.
5. Core returns typed analysis objects with support status and export attempts.
6. The MCP server formats those objects into Markdown, JSON, or both.

## User-Facing Skill

This repo includes a bundled skill at `skills/xctrace-profiler`. Use it as the primary human-facing entry point for profiling, trace analysis, hangs, CPU bottlenecks, leaks, allocations, network, energy, startup slowness, and trace comparisons.

Users should be able to say simple prompts like:

```text
Profile this app.
Find why this app is slow.
Profile this app for hangs.
Profile this app for hangs and tell me which of my code is responsible.
Check this build for leaks and allocation churn.
Analyze network activity.
Launch this app and profile startup hangs.
Analyze this trace.
Compare these two traces.
```

The skill should hide MCP JSON and tool names. It is the planning layer. It chooses between `profile_running_app`, `track_running_app`, `analyze_trace`, `compare_traces`, `check_xctrace`, `list_templates`, and `list_devices`, records or analyzes with `outputFormat: "both"` when diagnostics matter, reads Support Matrix / Export Diagnostics, and can rerun `analyze_trace` with `timeRangeMs` around the longest hang so `## Top User-Code Frames` answers the app-owned code question.

## MCP Tools

When driving the MCP from another app repository, a user should be able to start with a simple prompt:

```text
Profile this app.
```

Recommended workflow:

1. For normal user prompts, use the bundled `xctrace-profiler` skill as the planning layer.
2. If the app is already running, prefer `profile_running_app` with a PID in `processName`, especially when several processes share the same name.
3. Use `outputFormat: "both"` while validating a workflow so the response includes Markdown plus structured `supportStatus` and `exportAttempts`.
4. Use launch mode only when startup behavior is the target. If the trace is saved but `xctrace export --toc` fails with `Document Missing Template Error`, treat the run as not exportable and retry with attach-by-PID.
5. For hangs, record for long enough to reproduce the issue, then inspect `## Hangs`, Support Matrix, and Export Diagnostics before drawing conclusions from "no issues" summaries.
6. If `## Hangs` reports no exported events, interpret that as trace-window scoped. It does not rule out startup or interaction hangs outside the captured window.
7. Interpret `partial` as "some usable rows parsed" and `not_exportable` as "Xcode exposed schemas but exported no usable rows." Do not treat `not_exportable` as evidence of no issues.
   `not_exportable` can also mean the Instruments.app GUI track exists but `xcrun export --toc` exposes no table schema for it.
8. If Time Profiler reports "failed to parse," treat CPU samples as unavailable and inspect Export Diagnostics; the trace may still contain usable Hangs, Memory, Network, Allocations, or Leaks data.
9. After identifying a hang start and duration, rerun `analyze_trace` with `timeRangeMs: { startMs, endMs }` around that interval to answer "what ran during the hang?"
10. Use `## Top User-Code Frames` to answer "which of my code was slow?" Pass `userBinaryHints` if module names do not match the process names discovered from the TOC.
11. Recording tools open saved traces in Instruments.app by default. Use `openInInstruments: false` only for CI or headless automation.
12. Do not delete a trace immediately after reporting while the user may still need Instruments.app verification. Once the user says the trace is no longer needed, call `cleanup_traces` with exact `tracePaths` and `dryRun: false`. For broad directory cleanup, preview first or require `olderThanMinutes`.

## Security Considerations

The secure defaults do not disable Time Profiler, Leaks, Allocations, HTTP Traffic, or other Instruments in normal attach recordings. They limit MCP operations that can execute local programs, capture unrelated processes, write outside the trace root, delete outside the trace root, or expose sensitive output.

- `XCTRACE_ANALYZER_ALLOW_LAUNCH=1` enables launch profiling. It is useful for true startup and cold-launch captures, but it lets the MCP server execute the requested local app or command through `xcrun xctrace --launch`. Without this setting, use manual launch plus attach-by-exact-PID, or tell the user the server must be restarted with launch enabled for trusted local startup profiling.
- `XCTRACE_ANALYZER_ALLOW_ALL_PROCESSES=1` enables all-process recording. It is useful for system-wide investigations, but traces may include unrelated apps, services, symbols, paths, URLs, and network metadata. Do not use it as a default fallback for a missing PID.
- `XCTRACE_ANALYZER_TRACE_ROOT` sets the allowed trace output root and defaults to `~/Library/Application Support/xctrace-analyzer/traces`. Prefer this, `test-traces/`, or another ignored local trace directory.
- `XCTRACE_ANALYZER_ALLOW_EXTERNAL_OUTPUT=1` allows trace output and launch stream redirection outside the trace root. Use it only when the user intentionally needs an external output directory.
- `XCTRACE_ANALYZER_ALLOW_EXTERNAL_CLEANUP=1` allows destructive cleanup outside the trace root. Prefer exact `tracePaths`; for directory cleanup, run a dry run first or require `olderThanMinutes`.
- `XCTRACE_ANALYZER_MAX_DURATION_SECONDS` defaults to `300`. If a longer repro is needed, explain that raising it increases trace size, capture time, and the amount of recorded data.
- `XCTRACE_ANALYZER_REDACTION` defaults to `balanced`. Use `strict` for shared reports and `off` only for trusted local debugging where full paths, hosts, and tokens are acceptable in MCP output.

### `profile_running_app`

Use this for broad profiling requests like "start profiling MyApp for 60 seconds" or "give me a full performance report." It records one combined trace, then analyzes it. It supports attach, launch, and all-processes target modes; `processName` is the attach shorthand.

Default macOS `full` preset:

- Base template: `Time Profiler`
- Additional instruments: `Leaks`, `Allocations`, `HTTP Traffic`
- Duration semantics: `durationSeconds: 60` means one 60-second recording, not 60 seconds per section.

Other presets:

- `cpu`: Time Profiler only
- `memory`: Allocations base with Leaks instrument
- `network`: Time Profiler base with HTTP Traffic instrument
- `energy`: Power Profiler only; intended for iOS/iPadOS
- `full-ios`: Time Profiler base with Leaks, Allocations, HTTP Traffic, and Power Profiler

Report contents:

- Recording metadata and saved trace path
- Support matrix and export diagnostics
- Main-thread hang events; severe hangs should affect overall status and prioritized recommendations even when no Time Profiler CPU function crosses the bottleneck threshold
- CPU / Time Profiler bottlenecks
- Top User-Code Frames for app-attributed CPU work
- Time Profiler parse-failure callouts when CPU samples could not be parsed
- Leaks findings when exportable
- Allocation metrics and churn findings when exportable
- Network requests/failures/transferred bytes when HAR or CFNetwork data is exportable
- Prioritized recommendations

### `track_running_app`

Use this when the user names one specific Instruments template, such as `Leaks` or `Allocations`. It records one template and optionally analyzes the trace. It supports attach, launch, and all-processes target modes.

### `analyze_trace`

Use this when the user already has a `.trace` file. It does not record. It can optionally symbolicate to a temporary trace with `dsymPath`, exports the trace TOC, discovers supported schemas, parses Time Profiler and supported instrument data, then returns one analysis report. Use `timeRangeMs` to restrict Time Profiler samples and hang events to a trace-relative window. Use `userBinaryHints` to supplement app/module names for Top User-Code Frames when TOC metadata is insufficient. Use `outputFormat: "json"` or `"both"` when callers need structured output. If Time Profiler parsing fails, report it as an analyzer/export failure rather than zero CPU work.

### `compare_traces`

Use this for Time Profiler baseline/current regression checks. It reports total-time deltas, function regressions, improvements, and can mark the MCP result as an error when `failOnRegression` is true.

### `cleanup_traces`

Use this as the trace garbage collector after recording workflows. It previews by default and only deletes paths ending in `.trace`.

Recommended UX:

1. After a report, keep the trace and mention that it can be cleaned up when the user is done inspecting it.
2. If the user says to clean the last run, pass the exact trace path or paths with `dryRun: false`.
3. For stale trace directories, run a dry run first or pass `olderThanMinutes` for destructive cleanup.

### Discovery Tools

- `list_templates`: list Instruments templates available on the machine
- `list_devices`: list physical devices and simulators visible to `xctrace`
- `check_xctrace`: verify `xcrun xctrace` availability and report version, templates, devices, instruments, export modes, record modes, symbolication support, and warnings

## Operational Notes

- Trace recording is one uninterrupted `xcrun xctrace` session. Mid-run approval prompts can drift the capture window or force a restart. Before invoking `profile_running_app` or `track_running_app`, advise the user to switch Claude Code to auto permission mode (Shift+Tab or `/permissions`), or enable Codex auto-review, so MCP tool calls are not gated on approvals during recording.
- macOS Power Profiler is not supported by Xcode; use `full` for macOS and `full-ios` or `energy` for iOS/iPadOS targets.
- Do not run separate `xctrace record` sessions in parallel for full profiling. They can contend for kperf/ktrace locks. Use the combined recording path in `profile_running_app`.
- `xctrace` can save malformed or partial traces even when recording exits nonzero. Surface the underlying `xctrace` stderr/stdout details in reports.
- `profile_running_app` and `track_running_app` should open the saved `.trace` in Instruments.app by default after recording; report the open status, but never treat an open failure as a recording failure.
- Recorded `.trace` bundles can be large. Keep them for GUI verification, then use `cleanup_traces`; do not delete non-`.trace` paths.
- Xcode export schemas vary by Xcode version and template. Prefer TOC-driven schema discovery over hard-coded table names.
- Network analysis should prefer HAR export when available and fall back to XML table exports.
- Every analysis family should be reported as `supported`, `partial`, `not_exportable`, or `unsupported`; do not imply Instruments.app GUI parity.
- GUI-only instrument tracks such as Leaks should be treated as `not_exportable` when they appear in the TOC but have no exportable table schema.
- Support status must come from export attempts: `supported` has successful exports, `partial` has successful exports plus failed/empty/skipped attempts, `not_exportable` has schemas but no successful exports, and `unsupported` has no matching schemas.
- Failed Time Profiler parsing should be surfaced through `PerformanceStats.timeProfileError` and MCP Export Diagnostics, not hidden behind "0 threads" summaries.
- When exported hang events exist, do not pair them with a global green/no-issues summary. `No Time Profiler CPU functions crossed the bottleneck threshold` is a scoped CPU statement, not an all-clear; severe hangs are critical profile findings.
- `timeRangeMs` is trace-relative milliseconds. Filter Time Profiler samples before aggregation and include hang events that overlap the window. It scopes analysis; it does not mutate or crop the source `.trace`.
- Top User-Code Frames should use TOC-derived user process names plus `AnalysisOptions.userBinaryHints`, walk sample backtraces from leaf to root, and aggregate the deepest matching module frame by sample weight.
- Use temp output paths for XML/HAR exports and symbolication so commands do not dirty the repo or mutate source traces.
- Real `.trace` files should stay out of git. Use ignored local directories such as `test-traces/` for manual validation.

## Development Commands

From the repo root:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm test:integration
pnpm inspect:trace test-traces/example.trace
```

`pnpm verify` runs typecheck, tests, and build. Run it before claiming a change is complete or opening a PR.
`pnpm test:integration` smoke-tests the local `xcrun xctrace` command surface; it is machine-dependent and intended for local validation.

## Coding Guidelines

- Keep MCP argument validation in `packages/mcp-server/src/index.ts`.
- Keep recording/export shell boundaries in `packages/core/src/utils/xctrace-runner.ts`.
- Keep trace parsing and schema normalization in `packages/core/src/parser/trace-parser.ts`.
- Keep recommendations in `packages/core/src/analyzer/recommendation-engine.ts`.
- Preserve injectable dependencies in tests so MCP behavior can be tested without launching real `xctrace`.
- Prefer focused tests around command construction, parser shapes, and MCP formatted output.

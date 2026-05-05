# Agent Guide

This repository contains a local Model Context Protocol (MCP) server for headless Xcode Instruments profiling. Treat it as an honest `xcrun xctrace` companion, not a replacement for Instruments.app. The server records, symbolicates, exports, parses, and analyzes what Apple exposes through `xctrace`, then reports unsupported or non-exportable data explicitly.

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

## MCP Tools

### `profile_advisor`

Use this first when the user says something vague like "profile my app", "let's profile", or "what can we inspect?" It suggests the best workflow and returns exact next tool-call arguments for `profile_running_app`, `track_running_app`, `analyze_trace`, or `compare_traces`.

When driving the MCP from another app repository, prefer this prompt first:

```text
Use xctrace-analyzer profile_advisor first. I want to profile this app for hangs and CPU bottlenecks. Prefer attach-by-PID if the app is already running. Use outputFormat both. If launch-mode traces fail TOC export, report that as an exportability failure and retry with attach mode.
```

Recommended workflow:

1. Use `profile_advisor` for vague requests.
2. If the app is already running, prefer `profile_running_app` with a PID in `processName`, especially when several processes share the same name.
3. Use `outputFormat: "both"` while validating a workflow so the response includes Markdown plus structured `supportStatus` and `exportAttempts`.
4. Use launch mode only when startup behavior is the target. If the trace is saved but `xctrace export --toc` fails with `Document Missing Template Error`, treat the run as not exportable and retry with attach-by-PID.
5. For hangs, record for long enough to reproduce the issue, then inspect `## Hangs`, Support Matrix, and Export Diagnostics before drawing conclusions from "no issues" summaries.

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
- CPU / Time Profiler bottlenecks
- Leaks findings when exportable
- Allocation metrics and churn findings when exportable
- Network requests/failures/transferred bytes when HAR or CFNetwork data is exportable
- Prioritized recommendations

### `track_running_app`

Use this when the user names one specific Instruments template, such as `Leaks` or `Allocations`. It records one template and optionally analyzes the trace. It supports attach, launch, and all-processes target modes.

### `analyze_trace`

Use this when the user already has a `.trace` file. It does not record. It can optionally symbolicate to a temporary trace with `dsymPath`, exports the trace TOC, discovers supported schemas, parses Time Profiler and supported instrument data, then returns one analysis report. Use `outputFormat: "json"` or `"both"` when callers need structured output.

### `compare_traces`

Use this for Time Profiler baseline/current regression checks. It reports total-time deltas, function regressions, improvements, and can mark the MCP result as an error when `failOnRegression` is true.

### Discovery Tools

- `list_templates`: list Instruments templates available on the machine
- `list_devices`: list physical devices and simulators visible to `xctrace`
- `check_xctrace`: verify `xcrun xctrace` availability and report version, templates, devices, instruments, export modes, record modes, symbolication support, and warnings

## Operational Notes

- macOS Power Profiler is not supported by Xcode; use `full` for macOS and `full-ios` or `energy` for iOS/iPadOS targets.
- Do not run separate `xctrace record` sessions in parallel for full profiling. They can contend for kperf/ktrace locks. Use the combined recording path in `profile_running_app`.
- `xctrace` can save malformed or partial traces even when recording exits nonzero. Surface the underlying `xctrace` stderr/stdout details in reports.
- Xcode export schemas vary by Xcode version and template. Prefer TOC-driven schema discovery over hard-coded table names.
- Network analysis should prefer HAR export when available and fall back to XML table exports.
- Every analysis family should be reported as `supported`, `partial`, `not_exportable`, or `unsupported`; do not imply Instruments.app GUI parity.
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

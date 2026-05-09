---
name: xctrace-profiler
description: Profile Xcode/macOS/iOS apps and Instruments traces with the xctrace-analyzer MCP server. Use for simple requests like "profile this app", "record my app on launch", "find why my app is slow", "check hangs", "find leaks", "inspect allocations", "analyze network", "profile startup", "analyze this .trace", "compare these traces", or "clean up profiling traces"; choose and run the right MCP execution tools without exposing MCP JSON to the user.
---

# Xcode Trace Profiler

## Goal

Be the user-facing profiler for xctrace-analyzer. Users should ask in plain language; do not ask them to know MCP tool names or JSON. Choose the workflow, call the MCP execution tools, and report what xctrace could and could not export.

## Simple Prompts

- "Profile this app."
- "Profile this app for hangs."
- "Find why this app is slow."
- "Check this build for leaks and allocation churn."
- "Analyze network activity."
- "Launch the app and profile startup."
- "Record my app on launch."
- "I will launch MyApp; record it for 60 seconds when it appears."
- "Analyze this trace."
- "Compare these two traces."

## What It Can Track

- CPU and Time Profiler bottlenecks
- Hangs, freezes, stutters, microhangs, and severe hangs
- Top User-Code Frames that attribute samples to app binaries
- Leaks and allocation churn when Xcode exports usable rows
- Network requests, failures, transfer volume, and top hosts when HAR or CFNetwork data is exportable
- Energy / Power Profiler data where Xcode supports it, mainly iOS/iPadOS
- Existing `.trace` files, optional dSYM symbolication, scoped `timeRangeMs` analysis, and Time Profiler regressions
- Safe cleanup of generated `.trace` bundles after the user is done inspecting them

## Workflow

1. Classify the request.
   - Cleanup / delete traces: call `cleanup_traces`.
   - Existing `.trace`: call `analyze_trace`.
   - Baseline/current or regression: call `compare_traces`.
   - Explicit single template such as Leaks, Allocations, Network, or Time Profiler: call `track_running_app`.
   - Broad, vague, hangs, CPU, leaks, memory, allocations, network, energy, startup, or "profile this app": call `profile_running_app`.

2. Establish the target.
   - Inspect the project for obvious Xcode targets, schemes, bundle names, app products, or trace paths before asking.
   - If shell access is available and the app may already be running, discover candidate PIDs and prefer the exact PID.
   - Use attach-by-PID for already-running apps, especially when several processes share a name.
   - Use launch mode only for explicit startup/cold-launch profiling.
   - If the user says "I will launch MyApp; record for 60 seconds", "record my app on launch", "profile when I launch it", or similar, treat that as permission to arm manual-launch observation immediately. Do not ask for another confirmation and do not wait for the user to say the app has launched.
   - For manual launch observation, infer or ask once for the expected executable, bundle process, app name, or bundle id if it is not discoverable. Then poll every 200-500 ms for up to 60 seconds while the user launches the app. As soon as one valid PID is visible, call the recording tool with `target: "attach"`, `processName` set to that exact PID, and `durationSeconds` set from the user's requested duration so recording starts as close to launch as possible.
   - While observing, a short status such as "I'm watching for MyApp now; launch it when ready." is enough. Keep polling after sending that status.
   - If multiple matching PIDs appear during observation, prefer the newest app executable PID over helper processes. If ambiguity remains, keep observing briefly for a stable main-app PID; ask only if the candidates are still ambiguous.
   - If no PID appears before the observation timeout, tell the user no launch was detected and ask them to relaunch or provide the exact app name, bundle id, or PID.
   - If no target can be discovered, ask one concise question for the app path, scheme, bundle id, process name, or PID.
   - Infer `userBinaryHints` from the app, scheme, executable, module, or bundle name.

3. Choose the preset.
   - `full`: best macOS default; Time Profiler + Leaks + Allocations + HTTP Traffic.
   - `full-ios`: iOS/iPadOS default when energy is relevant; adds Power Profiler.
   - `cpu`: narrow CPU, hangs, freezes, hot functions, or slow UI checks.
   - `memory`: leaks, retain cycles, memory growth, allocation churn.
   - `network`: HTTP/network request analysis.
   - `energy`: Power Profiler only; mainly iOS/iPadOS.

4. Run with diagnostics.
   - Use `outputFormat: "both"` for profiling, trace analysis, and scoped follow-up analysis unless the user explicitly requests only Markdown or only JSON. The structured result preserves `supportStatus`, `exportAttempts`, hang timing, and user-code frame details needed for a complete report.
   - Recording tools open the saved `.trace` in Instruments.app by default with `openInInstruments: true`; pass `false` only for CI or headless automation.
   - Use `durationSeconds: 60` by default; use 20-30 seconds only for explicit startup checks or longer when the repro needs it.
   - Use temp or ignored output locations such as `test-traces/`; do not commit `.trace` files.
   - Secure defaults block launch profiling, all-process recording, external trace output, and destructive cleanup outside the trace root unless the MCP server was explicitly configured to allow them.
   - Keep recorded traces until the user has had a chance to inspect Instruments.app or asks for cleanup.
   - Use `check_xctrace`, `list_templates`, or `list_devices` only for setup, device selection, or troubleshooting.

5. Interpret support status before conclusions.
   - `supported`: usable exported rows were parsed.
   - `partial`: usable rows were parsed, but other schemas failed, were empty, or were skipped.
   - `not_exportable`: Xcode exposed schemas but no usable rows were exported; this is unavailable data, not "no issues."
   - `not_exportable` may also mean the GUI track exists in Instruments.app but `xcrun export --toc` does not expose an exportable table schema.
   - `unsupported`: no matching schema was present in this trace TOC. This usually means the recording template/platform did not include that analysis family or Xcode did not expose it for this run; it does not mean the analyzer code is missing.
   - If Time Profiler failed to parse, CPU attribution is unavailable for that run; inspect Export Diagnostics.
   - If Leaks, Allocations, Memory, Network, or Energy are `unsupported` / `not_exportable`, say the automated MCP report cannot validate that area and use the opened Instruments trace for GUI verification.
   - Memory is distinct from Allocations and Leaks. A macOS `full` run can show `Memory: unsupported` while Allocations/Leaks are present or `not_exportable`; that means the trace TOC did not expose generic memory/resident/dirty/VM schemas, not that allocation or leak recording was disabled.
   - Energy / Power depends on the Power Profiler instrument. It is mainly for iOS/iPadOS; macOS `full` does not include it, and macOS Power Profiler recordings may be rejected by Xcode or absent from the TOC. Report that as platform/template support, not an analyzer implementation gap.

6. Follow up when needed.
   - For hangs, choose the longest Severe Hang, otherwise the longest Hang. Rerun `analyze_trace` on the saved trace with `timeRangeMs`: `startMs = max(0, hang.startMs - 500)`, `endMs = hang.startMs + hang.durationMs + 500`. Include the scoped report in the final answer; if rerunning is impossible, say why.
   - Use `## Top User-Code Frames` from the scoped report to answer which app-owned code was running.
   - If Top User-Code Frames is empty but Time Profiler succeeded, rerun with better `userBinaryHints` or a dSYM.
   - Map important app frame names to source files with project search (`rg`) when source is available, then include concrete file:line pointers. If source is unavailable, list the most relevant symbols or modules instead.
   - If launch mode saves a trace but TOC export fails, retry by launching the app manually and attaching by exact PID.
   - Once the user says the trace is no longer needed, call `cleanup_traces` with the exact trace path(s) and `dryRun: false`.
   - For broad stale-trace cleanup, call `cleanup_traces` with `dryRun: true` first, or use `olderThanMinutes` before destructive directory cleanup.

## Detailed Report Shape

For profiling and trace-analysis reports, default to a detailed diagnostic report, not a short summary. Use concise prose, but include all relevant evidence from the Markdown and structured result. Only be terse for setup checks, cleanup, template/device listing, or when the user explicitly asks for a brief answer.

Include these sections when data is available:

- `Trace`: target app/process/PID, attach vs launch timing, duration, preset/template and instruments, trace path, Instruments.app open status, and whether the trace was retained.
- `Overall Result`: status, the primary finding in plain language, and whether the issue is CPU, hangs, memory, network, energy, exportability, or a trace-capture problem.
- `Hangs`: table of hang start time, type, and duration; total stalled main-thread time; longest hang; and a warning that no exported hang rows only scopes to the captured window.
- `CPU / Time Profiler`: parse/support status, whether bottlenecks crossed threshold, captured duration, thread count, slow function count, average/max function time, hang data availability, and broad hot-path families.
- `Top User-Code Frames`: full-run app-attributed frames with samples/time. If empty, explain whether Time Profiler was unavailable, no app frames matched, or better `userBinaryHints`/dSYM are needed.
- `Scoped Severe Hang` or `Scoped Hang`: scoped window, contained hangs, scoped thread/slow-function stats, top scoped frames, and a short interpretation of what those frames suggest.
- Requested domains such as `Leaks`, `Allocations`, `Memory`, `Network`, or `Energy / Power`: include metrics, top findings, and confidence caveats.
- `Support Matrix`: every analysis family with `supported`, `partial`, `not_exportable`, or `unsupported` plus the reason. Explicitly distinguish "not present/exportable in this trace" from "no issue found."
- `Export Diagnostics`: failed, empty, or skipped exports that affect confidence, especially TOC failures, Time Profiler parse failures, GUI-only tracks, empty Hangs schemas, HAR failures, Leaks, Allocations, Memory, Network, and Energy.
- `Source Areas To Inspect`: file:line pointers found from relevant app frames, plus symbols/modules when file lookup is unavailable.
- `Next Step`: the most useful next investigation step in Instruments.app or source, and cleanup state for retained traces.

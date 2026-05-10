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
   - For already-running apps, use attach-by-PID immediately, especially when several processes share a name. Do not ask launch-prep questions for active app profiling.
   - Use launch mode only for explicit startup/cold-launch profiling.
   - For launch or startup prompts such as "get ready, I will launch my app", "record my app on launch", "profile when I launch it", or "cold launch profile", first establish what process should be watched.
   - If exactly one likely app target is discoverable, announce it and start manual-launch observation immediately: "I found MyApp. I'm watching for its PID now; launch it when ready."
   - If the app identity is missing or ambiguous, ask one concise question for the app name, bundle id, app path, or scheme, and offer observation as the easy fallback: "I can also start observing now and you can launch it after I say I'm watching."
   - Once manual launch observation starts, poll every 200-500 ms for up to 60 seconds while the user launches the app. As soon as one valid PID is visible, call the recording tool with `target: "attach"`, `processName` set to that exact PID, and `durationSeconds` set from the user's requested duration so recording starts as close to launch as possible.
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
   - For normal recordings, omit `outputDirectory` and let the MCP server write under its configured trace root.
   - Use repo-local or temp output locations such as `test-traces/` only when `XCTRACE_ANALYZER_TRACE_ROOT` points there or `XCTRACE_ANALYZER_ALLOW_EXTERNAL_OUTPUT=1` is explicitly enabled. If an external output path is rejected, retry immediately without `outputDirectory`.
   - Secure defaults block launch profiling, all-process recording, external trace output, and destructive cleanup outside the trace root unless the MCP server was explicitly configured to allow them.
   - Keep recorded traces until the user has had a chance to inspect Instruments.app or asks for cleanup.
   - At the end of every report that retains a generated trace, proactively remind the user to ask for trace cleanup before ending the session if they are done inspecting it. Do not delete automatically.
   - Use `check_xctrace`, `list_templates`, or `list_devices` only for setup, device selection, or troubleshooting.

5. Interpret support status before conclusions.
   - `supported`: usable exported rows were parsed.
   - `partial`: usable rows were parsed, but other schemas failed, were empty, or were skipped.
   - `not_exportable`: Xcode exposed schemas but no usable rows were exported; this is unavailable data, not "no issues."
   - `not_exportable` may also mean the GUI track exists in Instruments.app but `xcrun export --toc` does not expose an exportable table schema.
   - `unsupported` is a structured status only; in human reports, phrase it as `not present in trace`. It means no matching schema was present in this trace TOC, usually because the recording template/platform did not include that analysis family or Xcode did not expose it for this run. It does not mean the analyzer code is missing.
   - If Time Profiler failed to parse, CPU attribution is unavailable for that run; inspect Export Diagnostics.
   - If Leaks, Allocations, Memory, Network, or Energy are structurally `unsupported` / `not_exportable`, say the automated MCP report cannot validate that area and use the opened Instruments trace for GUI verification. Render `unsupported` as `not present in trace` for users.
   - Memory is distinct from Allocations and Leaks. A macOS `full` run can show `Memory: not present in trace` while Allocations/Leaks are present or `not_exportable`; that means the trace TOC did not expose generic memory/resident/dirty/VM schemas, not that allocation or leak recording was disabled.
   - Energy / Power depends on the Power Profiler instrument. It is mainly for iOS/iPadOS; macOS `full` does not include it, and macOS Power Profiler recordings may be rejected by Xcode or absent from the TOC. Report that as `not present in trace` due to platform/template/export availability, not an analyzer implementation gap.

6. Follow up when needed.
   - For hangs, choose the longest Severe Hang, otherwise the longest Hang. Rerun `analyze_trace` on the saved trace with `timeRangeMs`: `startMs = max(0, hang.startMs - 500)`, `endMs = hang.startMs + hang.durationMs + 500`. Include the scoped report in the final answer; if rerunning is impossible, say why.
   - Use `## Top User-Code Frames` from the scoped report to answer which app-owned code was running.
   - If Top User-Code Frames is empty but Time Profiler succeeded, rerun with better `userBinaryHints` or a dSYM.
   - Map important app frame names to source files with project search (`rg`) when source is available, then include concrete file:line pointers. If source is unavailable, list the most relevant symbols or modules instead.
   - If launch mode saves a trace but TOC export fails, retry by launching the app manually and attaching by exact PID.
   - Once the user says the trace is no longer needed, call `cleanup_traces` with the exact trace path(s) and `dryRun: false`.
   - For broad stale-trace cleanup, call `cleanup_traces` with `dryRun: true` first, or use `olderThanMinutes` before destructive directory cleanup.

## Detailed Report Shape

For profiling and trace-analysis reports, default to a full readable diagnostic report, not a short summary. Include everything meaningful the run found: exported hangs, support/export limitations, full-run user-code frames, scoped hang-window frames, requested domain findings, source areas, and recommendations.

Before composing the final user-facing report for `profile_running_app`, `track_running_app`, or `analyze_trace`, read [references/report.md](references/report.md) and follow its report contract and examples. Only skip it for setup checks, cleanup, template/device listing, trace comparison summaries, or when the user explicitly asks for a brief answer.
---
name: xctrace-profiler
description: Profile Xcode/macOS/iOS apps and Instruments traces with the xctrace-analyzer MCP server. Use for simple requests like "profile this app", "find why my app is slow", "check hangs", "find leaks", "inspect allocations", "analyze network", "profile startup", "analyze this .trace", or "compare these traces"; choose and run the right MCP execution tools without exposing MCP JSON to the user.
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

## Workflow

1. Classify the request.
   - Existing `.trace`: call `analyze_trace`.
   - Baseline/current or regression: call `compare_traces`.
   - Explicit single template such as Leaks, Allocations, Network, or Time Profiler: call `track_running_app`.
   - Broad, vague, hangs, CPU, leaks, memory, allocations, network, energy, startup, or "profile this app": call `profile_running_app`.

2. Establish the target.
   - Inspect the project for obvious Xcode targets, schemes, bundle names, app products, or trace paths before asking.
   - If shell access is available and the app may already be running, discover candidate PIDs and prefer the exact PID.
   - Use attach-by-PID for already-running apps, especially when several processes share a name.
   - Use launch mode only for explicit startup/cold-launch profiling.
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
   - Use `outputFormat: "both"` while validating or when the result needs follow-up decisions.
   - Use `durationSeconds: 60` by default; use 20-30 seconds only for explicit startup checks or longer when the repro needs it.
   - Use temp or ignored output locations such as `test-traces/`; do not commit `.trace` files.
   - Use `check_xctrace`, `list_templates`, or `list_devices` only for setup, device selection, or troubleshooting.

5. Interpret support status before conclusions.
   - `supported`: usable exported rows were parsed.
   - `partial`: usable rows were parsed, but other schemas failed, were empty, or were skipped.
   - `not_exportable`: Xcode exposed schemas but no usable rows were exported; this is unavailable data, not "no issues."
   - `unsupported`: no matching schema was present.
   - If Time Profiler failed to parse, CPU attribution is unavailable for that run; inspect Export Diagnostics.

6. Follow up when needed.
   - For hangs, choose the longest Severe Hang, otherwise the longest Hang. Rerun `analyze_trace` on the saved trace with `timeRangeMs`: `startMs = max(0, hang.startMs - 500)`, `endMs = hang.startMs + hang.durationMs + 500`.
   - Use `## Top User-Code Frames` from the scoped report to answer which app-owned code was running.
   - If Top User-Code Frames is empty but Time Profiler succeeded, rerun with better `userBinaryHints` or a dSYM.
   - If launch mode saves a trace but TOC export fails, retry by launching the app manually and attaching by exact PID.

## Final Answer Shape

Keep the final answer short and actionable:

- Trace path and recording target.
- What was supported, partial, not exportable, or unsupported.
- Key findings for the requested concern: CPU, hangs, user-code frames, leaks, allocations, network, energy, or regression.
- Concrete source areas to inspect next.
- Any Export Diagnostics caveat that changes confidence.

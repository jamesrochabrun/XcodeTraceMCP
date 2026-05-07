---
name: xctrace-hang-profiler
description: Profile Xcode/macOS/iOS apps for hangs, freezes, startup slowness, CPU bottlenecks, and app-owned slow code using the xctrace-analyzer MCP server. Use when the user says simple requests like "profile this app for hangs", "find why my app freezes", "profile startup", "what code is causing this hang", or asks to analyze an existing .trace for hangs and user-code frames.
---

# Xcode Hang Profiler

## Goal

Turn a simple user request into the full xctrace-analyzer workflow. Do not ask the user to write MCP JSON or know tool names. Hide the tool choreography and report the result in terms of hangs, support status, and app-owned code.

## Simple Prompts This Skill Supports

- "Profile this app for hangs."
- "Launch the app and find why startup hangs."
- "Find what code is causing the freeze."
- "Analyze this trace and tell me which of my code is slow."

## Workflow

1. Establish the target.
   - Inspect the current project for obvious Xcode targets, schemes, bundle names, app products, or existing `.trace` paths before asking the user.
   - If shell access is available and the app may already be running, discover candidate PIDs with process listing commands and prefer the exact PID.
   - If the app is already running, prefer attach by PID.
   - If the user explicitly asks for startup/cold launch, use launch mode.
   - If no target can be discovered from the project, running processes, or prompt, ask one concise question for the app path, scheme, bundle id, or PID.
   - Infer `userBinaryHints` from the app, scheme, executable, module, or bundle name when possible.

2. Start with `profile_advisor`.
   - Pass the user request as `request`.
   - Include known `processName`, `launchCommand`, `tracePath`, `platform`, `durationSeconds`, and `userBinaryHints`.
   - Always use `outputFormat: "both"` while validating.

3. Record or analyze.
   - For a broad or hang-focused recording, prefer `profile_running_app`.
   - Use `preset: "full"` for macOS and `preset: "full-ios"` for iOS/iPadOS when the platform is known.
   - Use `preset: "cpu"` only for narrow CPU/hang checks when memory/network/leaks are irrelevant.
   - Use `durationSeconds: 60` unless the user asks for a shorter startup-only check or the repro needs longer.
   - For an existing `.trace`, call `analyze_trace` directly with `outputFormat: "both"`.

4. Interpret the first report.
   - Read Support Matrix and Export Diagnostics before drawing conclusions.
   - Treat `partial` as usable but incomplete data.
   - Treat `not_exportable` as unavailable data, not as "no issues."
   - If Time Profiler failed to parse, say CPU attribution is unavailable for that run.
   - If `## Hangs` is absent or empty, say no exported hang events were found in the captured window; do not rule out hangs outside that window.

5. If hangs are found, run a scoped follow-up.
   - Pick the longest Severe Hang; if none, pick the longest Hang.
   - Use `timeRangeMs` around the event: `startMs = max(0, hang.startMs - 500)` and `endMs = hang.startMs + hang.durationMs + 500`.
   - Call `analyze_trace` on the saved trace with that `timeRangeMs`, `outputFormat: "both"`, and `userBinaryHints`.
   - Use `## Top User-Code Frames` from this scoped report as the answer to "which of my code was slow?"

## Final Answer Shape

Keep the final answer short and actionable:

- Trace path and whether data was `supported`, `partial`, `not_exportable`, or `unsupported`.
- Longest hang(s), with start time and duration.
- Top User-Code Frames during the hang window, with module/function names and time.
- Concrete source areas to inspect next.
- Any caveat from Export Diagnostics that changes confidence.

## Failure Recovery

- If launch mode saves a trace but TOC export fails, retry with the app already running and attach by exact PID.
- If xctrace reports an ambiguous process name, ask for or discover the PID and rerun attach by PID.
- If the issue was not reproduced during the recording window, ask the user to reproduce it during a longer recording.
- If `Top User-Code Frames` is empty but Time Profiler succeeded, retry analysis with better `userBinaryHints` such as the app executable name, main module name, or framework module names.

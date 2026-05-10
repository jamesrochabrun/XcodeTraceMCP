# Profiling Report Reference

Use this reference when composing final user-facing reports for `profile_running_app`, `track_running_app`, and `analyze_trace`.

## Report Contract

Default to a full readable diagnostic report, not a short summary. Include everything meaningful the run found:

- Every exported hang, with severity and duration.
- Important support and export limitations.
- Strongest full-run app-attributed user-code frames.
- Scoped longest-hang or severe-hang window frames when available.
- Requested domain findings for leaks, allocations, memory, network, and energy.
- Export diagnostics that affect confidence.
- Source areas or symbols to inspect.
- A direct recommendation that names the likely bottleneck area and next step.

Keep wording concise, but do not collapse important evidence into a vague summary. Omit sections only when they are genuinely irrelevant or unavailable.

## Section Order

Use this order when data is available:

1. Opening sentence: what was recorded/analyzed, target app/process, PID if known, duration, and attach/launch/manual-launch mode.
2. Trace line: saved trace path, Instruments.app open status, and retention/cleanup status.
3. `Summary`
4. `Support Matrix`
5. `Top User-Code Frames`
6. `Hangs`
7. `Scoped Longest Hang`, `Scoped Severe Hang`, or `Scoped Hang`
8. `Requested Domain Findings`
9. `Export Diagnostics`
10. `Source Areas To Inspect`
11. `Recommendation`

## Status Wording

- Render `unsupported` as `not present in trace`.
- Render GUI-only tracks as `visible in Instruments, not exportable through xcrun`.
- Do not imply `not present in trace`, `not_exportable`, empty schemas, or failed exports mean "no issue found."
- If Time Profiler failed to parse, say CPU attribution is unavailable for that run.
- If no exported hang rows exist, say that only scopes to the captured trace window.

## Template

```text
Recorded fresh {AppName} {attach/launch/manual-launch} PID {pid} for {duration}s.

Trace: {tracePath}
Instruments.app {opened it / did not open: reason}. Trace is {retained / cleaned up}.

Summary

- Overall status: {healthy / warnings found / critical issues found / export limited}
- {N} main-thread hangs total
- {N} severe hangs, {N} standard hangs, {N} microhangs
- Total stalled main-thread time: {duration}
- Longest hang: {duration}
- {CPU bottleneck statement}
- Total execution time: {duration}
- Threads used: {count}

Support Matrix

- time-profile: {supported / partial / not exportable / not present in trace}
- network: {supported / partial / not exportable / not present in trace}
- memory: {supported / partial / not exportable / not present in trace}
- energy / power: {supported / partial / not exportable / not present in trace}
- allocations: {supported / visible in Instruments, not exportable through xcrun / not present in trace}
- leaks: {supported / visible in Instruments, not exportable through xcrun / not present in trace}
- hang-risks: {supported / empty / not present in trace}

Top User-Code Frames

- {SymbolOrFrame}: {time}, {samples if available}
- {SymbolOrFrame}: {time}, {samples if available}

Hangs

- {mm:ss.mmm} - {Severe Hang / Hang / Microhang} - {duration}
- {mm:ss.mmm} - {Severe Hang / Hang / Microhang} - {duration}

Scoped Longest Hang
Scoped window: {mm:ss.mmm} to {mm:ss.mmm}.

That window contains:

- {mm:ss.mmm} - {Severe Hang / Hang / Microhang} - {duration}

Top frames in that scoped window:

- {SymbolOrFrame}: {time}
- {SymbolOrFrame}: {time}

Requested Domain Findings

- Leaks: {finding or export limitation}
- Allocations: {finding or export limitation}
- Network: {requests/failures/bytes/top hosts or export limitation}
- Memory: {finding or not present/exportable}
- Energy / Power: {finding or not present/exportable}

Export Diagnostics

- {Only include diagnostics that affect confidence or explain missing data}

Source Areas To Inspect

- {File:line or symbol/module}: {why it matters}
- {File:line or symbol/module}: {why it matters}

Recommendation
{Plain-language conclusion that names the likely bottleneck area, the evidence behind it, and the next code/Instruments step.}
```

## Fresh Launch Example

```text
Recorded fresh AgentHub launch PID 36183 for 60s.

Trace: /Users/jamesrochabrun/Library/Application Support/xctrace-analyzer/traces/36183-full-2026-05-10T19-31-00-037Z.trace
Instruments.app opened it. Trace is retained.

Summary

- Overall status: critical issues found
- 11 main-thread hangs total
- 2 severe hangs, 7 standard hangs, 2 microhangs
- Total stalled main-thread time: 16.53s
- Longest hang: 4.41s
- No Time Profiler CPU function crossed the bottleneck threshold
- Total execution time: 61.2s
- Threads used: 59

Support Matrix

- time-profile: supported
- network: supported
- memory: not present in trace
- energy / power: not present in trace
- allocations: visible in Instruments, not exportable through xcrun
- leaks: visible in Instruments, not exportable through xcrun
- hang-risks: empty

Top User-Code Frames

- MonitoringCardView.body.getter: 16ms
- GhosttyTerminalContainerView.init(controller:): 10ms
- DisplayList.ViewUpdater.updateInheritedView(container:from:parentState:): 9ms
- DisplayList.ViewUpdater.Platform.updateItemView(_:index:item:state:): 9ms
- closure #1 in NSHostingView.updateEnvironment(): 9ms
- specialized static Layout.makeLayoutView(root:inputs:body:): 8ms
- -[NSView _setSuperview:]: 8ms
- static CLISessionMonitorService.findClaudeSessionFiles(sessionIds:claudeDataPath:): 8ms
- HitTestingLeafPlatformView.responderBasedHitTest(_:radius:cacheKey:super:): 8ms

Hangs

- 00:06.146 - Severe Hang - 4.41s
- 00:47.121 - Severe Hang - 3.98s
- 00:14.105 - Hang - 1.21s
- 00:10.552 - Hang - 1.19s
- 00:11.737 - Hang - 1.19s
- 00:15.311 - Hang - 1.18s
- 00:51.105 - Hang - 1.18s
- 00:03.505 - Hang - 891ms
- 00:23.396 - Hang - 647ms
- 00:26.555 - Microhang - 361ms
- 00:24.146 - Microhang - 312ms

Scoped Longest Hang
Scoped window: 00:05.646 to 00:11.052.

That window contains:

- 00:06.146 - Severe Hang - 4.41s
- 00:10.552 - Hang - 1.19s

Top frames in that scoped window:

- -[_NSTrackingAreaAKManager _updateActiveTrackingAreasForWindowLocation:modifierFlags:]: 4ms
- HitTestingLeafPlatformView.defaultHitTest(_:radius:cacheKey:super:): 3ms
- -[NSMenuBarTrackingSession _handleMonitorEvent:]: 2ms
- closure #1 in NSHostingView.updateEnvironment(): 2ms
- NSHostingView.mouseMoved(with:): 1ms
- MultiProviderMonitoringPanelView.body.getter: 1ms
- closure #1 in CLISessionsViewModel.allSessions.getter: 1ms

Recommendation
The main issue is repeated main-thread stalls during early UI/event handling. The source areas to inspect first are MonitoringCardView, GhosttyTerminalContainerView initialization, SwiftUI view/environment updates, MultiProviderMonitoringPanelView, and session restore/discovery paths.
```
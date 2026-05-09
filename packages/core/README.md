# @xctrace-analyzer/core

> Core analysis library for Xcode Instruments performance traces

A TypeScript library for parsing and analyzing Xcode Instruments `.trace` files, identifying Time Profiler bottlenecks, main-thread hangs, app-attributed user-code frames, and additional Memory, Network, Energy, Allocations, and Leaks findings.

## Features

- 📊 Parse Time Profiler traces from xctrace XML output
- 🧭 Parse Memory, Network, Energy, Allocations, and Leaks tables when exportable
- 🔍 Identify slow functions and performance bottlenecks
- 🧊 Surface main-thread hang events without treating clean CPU thresholds as a global all-clear
- 🎯 Attribute Time Profiler samples to Top User-Code Frames
- 📈 Compare traces to detect performance regressions
- 💡 Generate actionable optimization recommendations
- 🎯 Pattern-based suggestion engine (image caching, async operations, etc.)
- 🧾 Support status and export diagnostics for honest reporting

## What The Core Package Does

The core package is the reusable analysis layer behind the MCP server. It does not speak MCP directly. It provides:

- `xctrace` process utilities for recording, exporting TOCs, exporting XPath tables, and exporting HAR data
- Capability detection and symbolication utilities for local `xctrace`
- `TraceParser` for normalizing Xcode `.trace` XML/HAR data into typed TypeScript structures
- `PerformanceAnalyzer` for Time Profiler statistics, bottlenecks, main-thread hang callouts, user-code frame attribution, and summaries
- `RecommendationEngine` for CPU, memory, network, allocation, leak, and energy recommendations
- `ComparativeAnalyzer` for Time Profiler baseline/current regression checks

## Installation

```bash
npm install @xctrace-analyzer/core
```

For source development, run `pnpm install --frozen-lockfile` and `pnpm build` from the monorepo root.

## Quick Start

```typescript
import { analyzeTraceFile, compareTraceFiles } from '@xctrace-analyzer/core';

// Analyze a single trace
const analysis = await analyzeTraceFile('/path/to/app.trace', {
  slowThreshold: 100, // ms
  topN: 10,
  timeRangeMs: { startMs: 2000, endMs: 7000 },
  userBinaryHints: ['MyApp'],
});

console.log(analysis.summary);
console.log('Bottlenecks:', analysis.bottlenecks);
console.log('User-code frames:', analysis.userFrameProfiles);
console.log('Recommendations:', analysis.recommendations);

// Compare two traces
const comparison = await compareTraceFiles(
  '/path/to/baseline.trace',
  '/path/to/current.trace',
  undefined, // analysis options
  { regressionThreshold: 10 } // comparison options
);

console.log(comparison.summary);
console.log('Regressions:', comparison.regressions);
console.log('Improvements:', comparison.improvements);
```

## API Reference

### High-Level Functions

#### `analyzeTraceFile(tracePath, options?)`

Parse and analyze a trace file in one call.

**Returns:** `Promise<Analysis>`

**Options:**
```typescript
interface AnalysisOptions {
  slowThreshold?: number;      // ms threshold for slow functions (default: 100)
  topN?: number;                // show top N functions (default: 10)
  includeRecommendations?: boolean; // generate recommendations (default: true)
  minCallCount?: number;        // minimum calls to consider (default: 1)
  timeRangeMs?: { startMs: number; endMs: number }; // trace-relative window
  userBinaryHints?: string[];    // app/module names for user-code attribution
}
```

#### `compareTraceFiles(baselinePath, currentPath, analysisOptions?, comparisonOptions?)`

Compare two trace files for regressions and improvements.

**Returns:** `Promise<Comparison>`

**Comparison Options:**
```typescript
interface ComparisonOptions {
  failOnRegression?: boolean;       // reserved for MCP/CLI automation (default: false)
  regressionThreshold?: number;     // % increase to flag (default: 10)
  minDuration?: number;             // only compare functions > N ms (default: 10)
}
```

### Core Classes

#### `TraceParser`

Parses xctrace XML output into structured data.

```typescript
import { TraceParser } from '@xctrace-analyzer/core';

const parser = new TraceParser();
const parsed = await parser.parseTrace('/path/to/app.trace');
```

#### `PerformanceAnalyzer`

Analyzes parsed traces for bottlenecks.

```typescript
import { PerformanceAnalyzer } from '@xctrace-analyzer/core';

const analyzer = new PerformanceAnalyzer();
const analysis = analyzer.analyze(parsedTrace, {
  slowThreshold: 100,
  topN: 10,
});
```

#### `ComparativeAnalyzer`

Compares two analyses to detect regressions.

```typescript
import { ComparativeAnalyzer } from '@xctrace-analyzer/core';

const comparator = new ComparativeAnalyzer();
const comparison = comparator.compare(baselineAnalysis, currentAnalysis, {
  regressionThreshold: 10,
});
```

#### `RecommendationEngine`

Generates optimization recommendations.

```typescript
import { RecommendationEngine } from '@xctrace-analyzer/core';

const engine = new RecommendationEngine();
const recommendations = engine.generateRecommendations(analysis);
```

### Utilities

#### xctrace-runner

Utility functions for calling xctrace commands.

```typescript
import {
  isXCTraceAvailable,
  getXCTraceVersion,
  exportTOC,
  exportTable,
  exportHAR,
  listTemplates,
  listDevices,
  getXCTraceCapabilities,
  recordTrace,
  symbolicateTrace,
} from '@xctrace-analyzer/core';

// Check availability
const available = await isXCTraceAvailable();

// List templates
const templates = await listTemplates();

// Export time profile data
const xml = await exportTable('/path/to/trace.trace', 'time-profile');

// Export network HAR data when available
const har = await exportHAR('/path/to/network.trace');

// Inspect local xctrace capabilities
const capabilities = await getXCTraceCapabilities();

// Record a running app with the Leaks template
await recordTrace({
  template: 'Leaks',
  processName: 'MyApp',
  duration: 60,
  outputPath: '/path/to/MyApp-leaks.trace',
});

// Symbolicate to a separate output trace before analysis
await symbolicateTrace({
  inputPath: '/path/to/app.trace',
  outputPath: '/path/to/app-symbolicated.trace',
  dsymPath: '/path/to/App.dSYM',
});

// Record one combined profiling trace
await recordTrace({
  template: 'Time Profiler',
  instruments: ['Leaks', 'Allocations', 'HTTP Traffic'],
  processName: 'MyApp',
  duration: 60,
  outputPath: '/path/to/MyApp-full.trace',
});
```

`recordTrace` intentionally uses `execFile` argument arrays rather than shell command strings. This keeps paths and process names safe even when they contain spaces.

## Data Types

### Analysis

Complete analysis result for a trace.

```typescript
interface Analysis {
  metadata: TraceMetadata;
  stats: PerformanceStats;
  bottlenecks: Bottleneck[];
  recommendations: Recommendation[];
  topFunctions: FunctionProfile[];
  userFrameProfiles?: UserFrameProfile[];
  instrumentAnalyses: InstrumentAnalysis[];
  hangs?: HangsData;
  supportStatus?: AnalysisSupportStatus[];
  exportAttempts?: ExportAttempt[];
  summary: string;
}
```

### UserFrameProfile

App-attributed Time Profiler frame. The analyzer walks each sample backtrace from leaf to root and aggregates the deepest frame whose module matches TOC-derived user process names or `userBinaryHints`.

```typescript
interface UserFrameProfile {
  name: string;
  module?: string;
  selfTime: number;
  sampleCount: number;
  percentage: number;
}
```

### InstrumentAnalysis

Normalized analysis for non-Time-Profiler instruments.

```typescript
interface InstrumentAnalysis {
  kind: 'time-profile' | 'memory' | 'network' | 'energy' | 'allocations' | 'leaks';
  title: string;
  summary: string;
  metrics: InstrumentMetric[];
  findings: InstrumentFinding[];
  sourceSchemas: string[];
}
```

### Comparison

Result of comparing two traces.

```typescript
interface Comparison {
  baseline: Analysis;
  current: Analysis;
  delta: PerformanceDelta;
  regressions: Regression[];
  improvements: Improvement[];
  hasRegression: boolean;
  hasCriticalRegression: boolean;
  summary: string;
}
```

### Bottleneck

A performance bottleneck identified in the trace.

```typescript
interface Bottleneck {
  function: string;
  module?: string;
  impact: 'critical' | 'high' | 'medium' | 'low';
  duration: number;          // milliseconds
  percentage: number;        // % of total time
  suggestion: string;
  callCount?: number;
}
```

### Recommendation

An actionable optimization recommendation.

```typescript
interface Recommendation {
  type: 'optimization' | 'architecture' | 'caching' | 'async' | 'memory' | 'algorithm';
  priority: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  affectedFunctions: string[];
  potentialImprovement: string;
  codeExample?: string;      // Swift code example
}
```

## Examples

### Basic Analysis

```typescript
import { analyzeTraceFile } from '@xctrace-analyzer/core';

async function analyzeApp() {
  const analysis = await analyzeTraceFile('./app.trace', {
    slowThreshold: 100,
    topN: 5,
  });

  console.log(`\n📊 Analysis Summary:`);
  console.log(analysis.summary);

  console.log(`\n🐌 Slow Functions:`);
  for (const bottleneck of analysis.bottlenecks.slice(0, 3)) {
    console.log(`- ${bottleneck.function}: ${bottleneck.duration.toFixed(0)}ms`);
    console.log(`  💡 ${bottleneck.suggestion}`);
  }

  console.log(`\n💡 Top Recommendations:`);
  for (const rec of analysis.recommendations.slice(0, 3)) {
    console.log(`\n${rec.title} (${rec.priority} priority)`);
    console.log(rec.description);
    console.log(`Potential improvement: ${rec.potentialImprovement}`);
  }
}

analyzeApp().catch(console.error);
```

### Regression Detection

```typescript
import { compareTraceFiles } from '@xctrace-analyzer/core';

async function checkRegression() {
  try {
    const comparison = await compareTraceFiles(
      './baseline.trace',
      './current.trace',
      undefined,
      {
        regressionThreshold: 15, // fail if >15% slower
      }
    );

    console.log(comparison.summary);

    if (comparison.regressions.length > 0) {
      console.log('\n⚠️ Regressions found:');
      for (const reg of comparison.regressions) {
        console.log(
          `- ${reg.function}: ` +
          `${reg.baselineTime.toFixed(0)}ms → ${reg.currentTime.toFixed(0)}ms ` +
          `(+${reg.percentageIncrease.toFixed(0)}%)`
        );
      }
      process.exit(1); // Fail CI
    }

    console.log('\n✅ No significant regressions');
  } catch (error) {
    console.error('Regression detected!', error);
    process.exit(1);
  }
}

checkRegression();
```

### Custom Analysis Pipeline

```typescript
import {
  TraceParser,
  PerformanceAnalyzer,
  RecommendationEngine,
} from '@xctrace-analyzer/core';

async function customAnalysis() {
  // Step 1: Parse
  const parser = new TraceParser();
  const trace = await parser.parseTrace('./app.trace');

  console.log(`Parsed ${trace.metadata.fileName}`);
  console.log(`Duration: ${trace.metadata.duration}ms`);

  // Step 2: Analyze
  const analyzer = new PerformanceAnalyzer();
  const analysis = analyzer.analyze(trace, {
    slowThreshold: 50, // Lower threshold
    topN: 20,          // More functions
  });

  // Step 3: Generate recommendations
  const engine = new RecommendationEngine();
  analysis.recommendations = engine.generateRecommendations(analysis);

  // Step 4: Custom reporting
  const criticalBottlenecks = analysis.bottlenecks.filter(
    b => b.impact === 'critical'
  );

  if (criticalBottlenecks.length > 0) {
    console.error('🔴 Critical performance issues found!');
    for (const b of criticalBottlenecks) {
      console.error(`- ${b.function}: ${b.duration}ms`);
    }
  }

  return analysis;
}

customAnalysis();
```

## Requirements

- **macOS** with Xcode Command Line Tools installed
- **Node.js** 18+
- **xctrace** command-line tool (included with Xcode)
- Time Profiler, Memory, Network, Energy, Allocations, or Leaks `.trace` files. Availability depends on which tables `xcrun xctrace export --toc` exposes for the trace.

## Error Handling

The library provides specific error types:

```typescript
import {
  TraceParserError,
  XCTraceError,
  AnalysisError,
} from '@xctrace-analyzer/core';

try {
  const analysis = await analyzeTraceFile('./nonexistent.trace');
} catch (error) {
  if (error instanceof TraceParserError) {
    console.error('Failed to parse trace:', error.message);
  } else if (error instanceof XCTraceError) {
    console.error('xctrace command failed:', error.message);
    console.error('Exit code:', error.exitCode);
  } else if (error instanceof AnalysisError) {
    console.error('Analysis failed:', error.message);
  }
}
```

## Production Notes

- This package analyzes data that `xcrun xctrace export` exposes through TOC, XPath, and HAR exports.
- It reports data that is not present in the trace or not exportable explicitly instead of assuming Instruments.app GUI parity.
- Large-trace streaming and broader template coverage are tracked as production hardening work, not current guarantees.

## License

MIT

## Contributing

See the main repository README for contribution guidelines.

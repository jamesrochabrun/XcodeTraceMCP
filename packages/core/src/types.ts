/**
 * Core type definitions for Xcode Instruments trace analysis
 */

/**
 * Metadata about a trace file
 */
export interface TraceMetadata {
  fileName: string;
  filePath: string;
  device?: string;
  processName?: string;
  pid?: number;
  duration: number; // in milliseconds
  template: string;
  recordedAt?: Date;
  xcodeVersion?: string;
}

/**
 * A single function call profile from Time Profiler
 */
export interface FunctionProfile {
  name: string;
  module?: string;
  totalTime: number; // milliseconds
  selfTime: number; // milliseconds
  callCount: number;
  percentage: number; // percentage of total time
  backtrace?: string[];
  lineNumber?: number;
  address?: string;
}

/**
 * Time profiler data from a trace
 */
export interface TimeProfileData {
  totalDuration: number; // milliseconds
  samples: Sample[];
  functionProfiles: FunctionProfile[];
  threadInfo?: ThreadInfo[];
}

/**
 * A single sample from the Time Profiler
 */
export interface Sample {
  timestamp: number;
  threadId: number;
  backtrace: string[];
  weight: number;
}

/**
 * Thread information
 */
export interface ThreadInfo {
  threadId: number;
  threadName?: string;
  samples: number;
}

/**
 * Memory/Allocations data
 */
export interface MemoryProfile {
  peakMemory: number; // bytes
  totalAllocations: number;
  leaksDetected: number;
  allocations?: Allocation[];
}

/**
 * A single memory allocation
 */
export interface Allocation {
  size: number;
  count: number;
  type: string;
  backtrace?: string[];
}

/**
 * Supported xctrace instrument families.
 */
export type TraceKind =
  | 'time-profile'
  | 'memory'
  | 'network'
  | 'energy'
  | 'allocations'
  | 'leaks';

/**
 * Honest support status for data exposed by xctrace.
 */
export type SupportStatus = 'supported' | 'partial' | 'not_exportable' | 'unsupported';

/**
 * A table discovered in xctrace's table of contents.
 */
export interface TraceTableDescriptor {
  runNumber: number;
  schema: string;
  xpath: string;
  trackName?: string;
  detailName?: string;
}

/**
 * One export operation attempted while parsing a trace.
 */
export interface ExportAttempt {
  kind: TraceKind | 'toc' | 'har' | 'symbolication';
  status: 'success' | 'empty' | 'failed' | 'skipped';
  schema?: string;
  xpath?: string;
  message?: string;
}

/**
 * Support status for one analysis family in a parsed trace.
 */
export interface AnalysisSupportStatus {
  kind: TraceKind;
  status: SupportStatus;
  reason: string;
  sourceSchemas: string[];
}

/**
 * A normalized metric from a non-Time-Profiler instrument.
 */
export interface InstrumentMetric {
  name: string;
  value: string | number;
  unit?: string;
  numericValue?: number;
}

/**
 * A finding from a non-Time-Profiler instrument analysis.
 */
export interface InstrumentFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
}

/**
 * Normalized analysis for Memory, Network, Energy, Allocations, and Leaks traces.
 */
export interface InstrumentAnalysis {
  kind: TraceKind;
  title: string;
  summary: string;
  metrics: InstrumentMetric[];
  findings: InstrumentFinding[];
  sourceSchemas: string[];
  supportStatus?: SupportStatus;
}

/**
 * Complete parsed trace data
 */
export interface ParsedTrace {
  metadata: TraceMetadata;
  timeProfile?: TimeProfileData;
  memoryProfile?: MemoryProfile;
  instrumentAnalyses?: InstrumentAnalysis[];
  tableDescriptors?: TraceTableDescriptor[];
  exportAttempts?: ExportAttempt[];
  supportStatus?: AnalysisSupportStatus[];
  rawData?: any; // For future extensions
}

/**
 * Performance bottleneck identified by analysis
 */
export interface Bottleneck {
  function: string;
  module?: string;
  impact: 'critical' | 'high' | 'medium' | 'low';
  duration: number;
  percentage: number;
  suggestion: string;
  callCount?: number;
}

/**
 * Recommendation for optimization
 */
export interface Recommendation {
  type: 'optimization' | 'architecture' | 'caching' | 'async' | 'memory' | 'algorithm';
  priority: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  affectedFunctions: string[];
  potentialImprovement: string; // e.g., "~400ms" or "30%"
  codeExample?: string;
}

/**
 * Performance statistics
 */
export interface PerformanceStats {
  totalTime: number;
  slowFunctions: number;
  avgFunctionTime: number;
  maxFunctionTime: number;
  threadCount: number;
  hotPath?: string[]; // Most expensive call path
}

/**
 * Complete analysis result
 */
export interface Analysis {
  metadata: TraceMetadata;
  stats: PerformanceStats;
  bottlenecks: Bottleneck[];
  recommendations: Recommendation[];
  topFunctions: FunctionProfile[];
  instrumentAnalyses: InstrumentAnalysis[];
  summary: string;
  supportStatus?: AnalysisSupportStatus[];
  exportAttempts?: ExportAttempt[];
}

/**
 * Machine-readable report shape for MCP/CI callers.
 */
export interface StructuredAnalysisReport {
  analysis: Analysis;
  supportStatus: AnalysisSupportStatus[];
  exportAttempts: ExportAttempt[];
}

/**
 * Current local xctrace command capabilities.
 */
export interface XCTraceCapabilities {
  available: boolean;
  version?: string;
  templates: string[];
  devices: string[];
  instruments: string[];
  exportModes: Array<'toc' | 'xpath' | 'har'>;
  recordModes: Array<'attach' | 'launch' | 'all-processes'>;
  supportsSymbolication: boolean;
  warnings: string[];
}

/**
 * Performance regression between two traces
 */
export interface Regression {
  function: string;
  module?: string;
  baselineTime: number;
  currentTime: number;
  percentageIncrease: number;
  absoluteIncrease: number;
  severity: 'critical' | 'major' | 'minor';
}

/**
 * Performance improvement between two traces
 */
export interface Improvement {
  function: string;
  module?: string;
  baselineTime: number;
  currentTime: number;
  percentageDecrease: number;
  absoluteDecrease: number;
}

/**
 * Performance delta statistics
 */
export interface PerformanceDelta {
  totalTimeChange: number; // absolute ms
  totalTimeChangePercent: number;
  functionChanges: {
    regressions: number;
    improvements: number;
    unchanged: number;
  };
}

/**
 * Comparison result between two traces
 */
export interface Comparison {
  baseline: Analysis;
  current: Analysis;
  delta: PerformanceDelta;
  regressions: Regression[];
  improvements: Improvement[];
  hasRegression: boolean;
  hasCriticalRegression: boolean;
  summary: string;
}

/**
 * Options for trace analysis
 */
export interface AnalysisOptions {
  slowThreshold?: number; // milliseconds, default 100
  topN?: number; // show top N functions, default 10
  includeRecommendations?: boolean; // default true
  minCallCount?: number; // minimum calls to consider, default 1
}

/**
 * Options for trace comparison
 */
export interface ComparisonOptions {
  failOnRegression?: boolean; // default false
  regressionThreshold?: number; // percentage increase to flag, default 10
  minDuration?: number; // only compare functions taking > N ms, default 10
}

/**
 * Error types for better error handling
 */
export class TraceParserError extends Error {
  constructor(message: string, public cause?: Error) {
    super(message);
    this.name = 'TraceParserError';
  }
}

export class XCTraceError extends Error {
  constructor(message: string, public exitCode?: number, public stderr?: string) {
    super(message);
    this.name = 'XCTraceError';
  }
}

export class AnalysisError extends Error {
  constructor(message: string, public cause?: Error) {
    super(message);
    this.name = 'AnalysisError';
  }
}

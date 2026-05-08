/**
 * @xctrace-analyzer/core
 *
 * Core analysis library for Xcode Instruments traces
 */

// Export types
export * from './types.js';

// Export parser
export { TraceParser, parseTrace, type TraceExporter, type TraceParserOptions } from './parser/trace-parser.js';

// Export analyzers
export { PerformanceAnalyzer, analyzeTrace } from './analyzer/performance-analyzer.js';
export { ComparativeAnalyzer, compareTraces } from './analyzer/comparative-analyzer.js';
export { RecommendationEngine, generateRecommendations } from './analyzer/recommendation-engine.js';

// Export utilities
export * from './utils/xctrace-runner.js';

/**
 * High-level convenience function: parse and analyze a trace in one call
 */
import { parseTrace } from './parser/trace-parser.js';
import { analyzeTrace } from './analyzer/performance-analyzer.js';
import { generateRecommendations } from './analyzer/recommendation-engine.js';
import { Analysis, AnalysisOptions } from './types.js';

export async function analyzeTraceFile(
  tracePath: string,
  options?: AnalysisOptions
): Promise<Analysis> {
  // Parse the trace
  const parsed = await parseTrace(
    tracePath,
    options?.timeRangeMs ? { timeRangeMs: options.timeRangeMs } : undefined
  );

  // Analyze it
  const analysis = analyzeTrace(parsed, options);

  // Add recommendations
  if (options?.includeRecommendations !== false) {
    analysis.recommendations = generateRecommendations(analysis);
  }

  return analysis;
}

/**
 * High-level convenience function: compare two traces
 */
import { compareTraces } from './analyzer/comparative-analyzer.js';
import { Comparison, ComparisonOptions } from './types.js';

export async function compareTraceFiles(
  baselinePath: string,
  currentPath: string,
  analysisOptions?: AnalysisOptions,
  comparisonOptions?: ComparisonOptions
): Promise<Comparison> {
  // Parse and analyze both traces
  const [baselineAnalysis, currentAnalysis] = await Promise.all([
    analyzeTraceFile(baselinePath, analysisOptions),
    analyzeTraceFile(currentPath, analysisOptions),
  ]);

  // Compare them
  return compareTraces(baselineAnalysis, currentAnalysis, comparisonOptions);
}

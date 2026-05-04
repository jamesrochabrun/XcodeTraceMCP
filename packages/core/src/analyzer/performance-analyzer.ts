/**
 * PerformanceAnalyzer - Analyzes performance data from traces
 */

import {
  ParsedTrace,
  Analysis,
  AnalysisOptions,
  Bottleneck,
  PerformanceStats,
  FunctionProfile,
  AnalysisError,
} from '../types.js';

/**
 * Default analysis options
 */
const DEFAULT_OPTIONS: Required<AnalysisOptions> = {
  slowThreshold: 100, // 100ms
  topN: 10,
  includeRecommendations: true,
  minCallCount: 1,
};

/**
 * Analyzes performance data from parsed traces
 */
export class PerformanceAnalyzer {
  /**
   * Analyze a parsed trace
   */
  analyze(trace: ParsedTrace, options: AnalysisOptions = {}): Analysis {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    try {
      // Calculate performance statistics
      const stats = this.calculateStats(trace, opts);

      // Identify bottlenecks
      const bottlenecks = this.identifyBottlenecks(trace, opts);

      // Get top functions by time
      const topFunctions = this.getTopFunctions(trace, opts.topN);

      // Generate summary
      const summary = this.generateSummary(trace, stats, bottlenecks);

      return {
        metadata: trace.metadata,
        stats,
        bottlenecks,
        recommendations: [], // Will be filled by RecommendationEngine
        topFunctions,
        instrumentAnalyses: trace.instrumentAnalyses ?? [],
        hangs: trace.hangs,
        supportStatus: trace.supportStatus,
        exportAttempts: trace.exportAttempts,
        summary,
      };
    } catch (error) {
      throw new AnalysisError('Failed to analyze trace', error as Error);
    }
  }

  /**
   * Calculate performance statistics
   */
  private calculateStats(trace: ParsedTrace, options: Required<AnalysisOptions>): PerformanceStats {
    const timeProfile = trace.timeProfile;

    if (!timeProfile || !timeProfile.functionProfiles.length) {
      return {
        totalTime: trace.metadata.duration,
        slowFunctions: 0,
        avgFunctionTime: 0,
        maxFunctionTime: 0,
        threadCount: 0,
      };
    }

    const functionTimes = timeProfile.functionProfiles
      .filter(f => f.callCount >= options.minCallCount)
      .map(f => f.selfTime);

    const slowFunctions = functionTimes.filter(t => t > options.slowThreshold).length;

    // Get unique thread count
    const threads = new Set(timeProfile.samples.map(s => s.threadId));

    // Find hot path (most expensive call path)
    const hotPath = this.findHotPath(timeProfile);

    return {
      totalTime: timeProfile.totalDuration,
      slowFunctions,
      avgFunctionTime: functionTimes.length > 0
        ? functionTimes.reduce((a, b) => a + b, 0) / functionTimes.length
        : 0,
      maxFunctionTime: functionTimes.length > 0
        ? Math.max(...functionTimes)
        : 0,
      threadCount: threads.size,
      hotPath,
    };
  }

  /**
   * Identify performance bottlenecks
   */
  private identifyBottlenecks(trace: ParsedTrace, options: Required<AnalysisOptions>): Bottleneck[] {
    const timeProfile = trace.timeProfile;

    if (!timeProfile || !timeProfile.functionProfiles.length) {
      return [];
    }

    const totalTime = timeProfile.totalDuration || 1;
    const bottlenecks: Bottleneck[] = [];

    // Filter and analyze functions
    const significantFunctions = timeProfile.functionProfiles
      .filter(f => f.selfTime > options.slowThreshold && f.callCount >= options.minCallCount)
      .slice(0, 20); // Top 20 candidates

    for (const func of significantFunctions) {
      const percentage = (func.selfTime / totalTime) * 100;

      // Determine impact level
      let impact: Bottleneck['impact'];
      if (percentage > 30 || func.selfTime > 1000) {
        impact = 'critical';
      } else if (percentage > 15 || func.selfTime > 500) {
        impact = 'high';
      } else if (percentage > 5 || func.selfTime > 200) {
        impact = 'medium';
      } else {
        impact = 'low';
      }

      // Generate suggestion based on function name patterns
      const suggestion = this.generateQuickSuggestion(func);

      bottlenecks.push({
        function: func.name,
        module: func.module,
        impact,
        duration: func.selfTime,
        percentage,
        suggestion,
        callCount: func.callCount,
      });
    }

    // Sort by severity and duration
    return bottlenecks.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      if (severityOrder[a.impact] !== severityOrder[b.impact]) {
        return severityOrder[a.impact] - severityOrder[b.impact];
      }
      return b.duration - a.duration;
    });
  }

  /**
   * Get top N functions by time
   */
  private getTopFunctions(trace: ParsedTrace, n: number): FunctionProfile[] {
    const timeProfile = trace.timeProfile;

    if (!timeProfile || !timeProfile.functionProfiles.length) {
      return [];
    }

    const totalTime = timeProfile.totalDuration || 1;

    // Calculate percentages and return top N
    return timeProfile.functionProfiles
      .slice(0, n)
      .map(f => ({
        ...f,
        percentage: (f.totalTime / totalTime) * 100,
      }));
  }

  /**
   * Find the hottest execution path (most expensive)
   */
  private findHotPath(timeProfile: any): string[] {
    // Find the sample with the highest weight
    const hottestSample = timeProfile.samples.reduce(
      (max: any, sample: any) => (sample.weight > (max?.weight || 0) ? sample : max),
      null
    );

    return hottestSample?.backtrace || [];
  }

  /**
   * Generate quick suggestion based on function name
   */
  private generateQuickSuggestion(func: FunctionProfile): string {
    const name = func.name.toLowerCase();

    // Pattern-based suggestions
    if (name.includes('image') || name.includes('bitmap') || name.includes('render')) {
      return 'Consider caching rendered images or using lower resolution';
    }

    if (name.includes('json') || name.includes('parse') || name.includes('decode')) {
      return 'Consider streaming parsing or lazy decoding';
    }

    if (name.includes('database') || name.includes('sql') || name.includes('query')) {
      return 'Consider adding database indexes or query optimization';
    }

    if (name.includes('network') || name.includes('http') || name.includes('request')) {
      return 'Consider request batching or caching responses';
    }

    if (name.includes('sort') || name.includes('filter') || name.includes('search')) {
      return 'Consider using more efficient algorithms or pre-computed indexes';
    }

    if (name.includes('crypto') || name.includes('hash') || name.includes('encrypt')) {
      return 'Consider moving cryptographic operations to background thread';
    }

    if (name.includes('layout') || name.includes('constraint')) {
      return 'Consider simplifying view hierarchy or using manual layout';
    }

    if (func.callCount > 1000) {
      return `Function called ${func.callCount} times - consider reducing call frequency`;
    }

    return 'Consider optimizing this function or moving to background thread';
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(trace: ParsedTrace, stats: PerformanceStats, bottlenecks: Bottleneck[]): string {
    const parts: string[] = [];
    const instrumentCount = trace.instrumentAnalyses?.length ?? 0;

    // Hangs callout — most important user-visible signal, surface it first.
    const hangs = trace.hangs;
    if (hangs && hangs.events.length > 0) {
      const severe = hangs.severeCount;
      const longestS = (hangs.longestMs / 1000).toFixed(2);
      if (severe > 0) {
        parts.push(
          `⚠️ ${severe} severe hang${severe > 1 ? 's' : ''} on the main thread (longest ${longestS}s).`
        );
      } else {
        parts.push(
          `⚠️ ${hangs.events.length} hang${hangs.events.length > 1 ? 's' : ''} on the main thread (longest ${longestS}s).`
        );
      }
    }

    // Overall assessment
    if (bottlenecks.length === 0) {
      parts.push('✅ No significant performance bottlenecks detected.');
    } else {
      const critical = bottlenecks.filter(b => b.impact === 'critical').length;
      const high = bottlenecks.filter(b => b.impact === 'high').length;

      if (critical > 0) {
        parts.push(`⚠️ Found ${critical} critical performance issue${critical > 1 ? 's' : ''}.`);
      }
      if (high > 0) {
        parts.push(`Found ${high} high-impact issue${high > 1 ? 's' : ''}.`);
      }
    }

    // Time summary
    const totalSeconds = (stats.totalTime / 1000).toFixed(1);
    parts.push(`Total execution time: ${totalSeconds}s across ${stats.threadCount} thread${stats.threadCount > 1 ? 's' : ''}.`);

    // Top bottleneck
    if (bottlenecks.length > 0) {
      const top = bottlenecks[0];
      parts.push(`Primary bottleneck: ${top.function} (${top.duration.toFixed(0)}ms, ${top.percentage.toFixed(1)}% of time).`);
    }

    if (instrumentCount > 0) {
      parts.push(`Found ${instrumentCount} additional instrument analyses.`);
    }

    return parts.join(' ');
  }
}

/**
 * Convenience function to analyze a trace
 */
export function analyzeTrace(trace: ParsedTrace, options?: AnalysisOptions): Analysis {
  const analyzer = new PerformanceAnalyzer();
  return analyzer.analyze(trace, options);
}

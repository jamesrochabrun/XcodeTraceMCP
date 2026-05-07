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
  UserFrameProfile,
  AnalysisError,
} from '../types.js';

type ResolvedAnalysisOptions = Required<Omit<AnalysisOptions, 'timeRangeMs' | 'userBinaryHints'>> &
  Pick<AnalysisOptions, 'timeRangeMs' | 'userBinaryHints'>;

/**
 * Default analysis options
 */
const DEFAULT_OPTIONS: ResolvedAnalysisOptions = {
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
      const userFrameProfiles = this.computeUserFrameProfiles(trace, opts);

      // Generate summary
      const summary = this.generateSummary(trace, stats, bottlenecks);

      return {
        metadata: trace.metadata,
        stats,
        bottlenecks,
        recommendations: [], // Will be filled by RecommendationEngine
        topFunctions,
        userFrameProfiles,
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
  private calculateStats(trace: ParsedTrace, options: ResolvedAnalysisOptions): PerformanceStats {
    const timeProfile = trace.timeProfile;

    if (!timeProfile || !timeProfile.functionProfiles.length) {
      const timeProfileFailure = trace.exportAttempts?.find((attempt) =>
        attempt.kind === 'time-profile' && attempt.status === 'failed'
      );
      const stats: PerformanceStats = {
        totalTime: timeProfile?.totalDuration ?? this.analysisWindowDuration(options) ?? trace.metadata.duration,
        slowFunctions: 0,
        avgFunctionTime: 0,
        maxFunctionTime: 0,
        threadCount: 0,
      };
      if (timeProfileFailure) {
        stats.timeProfileError = timeProfileFailure.message ?? 'Time Profiler export or parsing failed.';
      }
      if (options.timeRangeMs) {
        stats.timeRangeMs = options.timeRangeMs;
      }
      return stats;
    }

    const functionTimes = timeProfile.functionProfiles
      .filter(f => f.callCount >= options.minCallCount)
      .map(f => f.selfTime);

    const slowFunctions = functionTimes.filter(t => t > options.slowThreshold).length;

    // Get unique thread count
    const threads = new Set(timeProfile.samples.map(s => s.threadId));

    // Find hot path (most expensive call path)
    const hotPath = this.findHotPath(timeProfile);

    const stats: PerformanceStats = {
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
    if (options.timeRangeMs) {
      stats.timeRangeMs = options.timeRangeMs;
    }
    return stats;
  }

  private analysisWindowDuration(options: ResolvedAnalysisOptions): number | undefined {
    const range = options.timeRangeMs;
    if (!range) {
      return undefined;
    }
    return Math.max(0, range.endMs - range.startMs);
  }

  /**
   * Identify performance bottlenecks
   */
  private identifyBottlenecks(trace: ParsedTrace, options: ResolvedAnalysisOptions): Bottleneck[] {
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

  private computeUserFrameProfiles(
    trace: ParsedTrace,
    options: ResolvedAnalysisOptions
  ): UserFrameProfile[] {
    const timeProfile = trace.timeProfile;
    if (!timeProfile || !timeProfile.samples.length) {
      return [];
    }

    const userBinaryNames = this.userBinaryNames(trace, options);
    if (userBinaryNames.length === 0) {
      return [];
    }

    const totalTime = timeProfile.totalDuration || 1;
    const profiles = new Map<string, UserFrameProfile>();

    for (const sample of timeProfile.samples) {
      const frame = this.deepestUserFrame(sample.backtrace, userBinaryNames);
      if (!frame) {
        continue;
      }
      const key = `${frame.module ?? 'unknown'}::${frame.name}`;
      let profile = profiles.get(key);
      if (!profile) {
        profile = {
          name: frame.name,
          module: frame.module,
          selfTime: 0,
          sampleCount: 0,
          percentage: 0,
        };
        profiles.set(key, profile);
      }
      profile.selfTime += sample.weight;
      profile.sampleCount += 1;
    }

    return Array.from(profiles.values())
      .map((profile) => ({
        ...profile,
        percentage: (profile.selfTime / totalTime) * 100,
      }))
      .sort((a, b) => b.selfTime - a.selfTime)
      .slice(0, options.topN);
  }

  private userBinaryNames(trace: ParsedTrace, options: ResolvedAnalysisOptions): string[] {
    const names = [
      trace.metadata.processName ?? '',
      ...(trace.metadata.userProcessNames ?? []),
      ...(options.userBinaryHints ?? []),
    ];
    const variants = names.flatMap((name) => this.userBinaryNameVariants(name));
    return Array.from(new Set(variants));
  }

  private userBinaryNameVariants(name: string): string[] {
    const trimmed = name.trim();
    if (!trimmed) {
      return [];
    }
    const withoutParenthetical = trimmed.replace(/\s*\([^)]*\)\s*$/g, '').trim();
    const withoutExtension = withoutParenthetical.replace(/\.(app|xpc|appex|framework)$/i, '');
    return [trimmed, withoutParenthetical, withoutExtension]
      .map((variant) => variant.trim().toLowerCase())
      .filter((variant) => variant.length > 0);
  }

  private deepestUserFrame(
    backtrace: string[],
    userBinaryNames: string[]
  ): { name: string; module?: string } | undefined {
    for (let i = backtrace.length - 1; i >= 0; i--) {
      const frame = this.parseFrameName(backtrace[i]);
      if (frame.module) {
        const module = frame.module.toLowerCase();
        if (userBinaryNames.some((name) => module.includes(name))) {
          return frame;
        }
        continue;
      }
      if (this.isLikelyUserSwiftFrame(frame.name)) {
        return frame;
      }
    }
    return undefined;
  }

  private parseFrameName(fullName: string): { name: string; module?: string } {
    const backtickIndex = fullName.indexOf('`');
    if (backtickIndex > 0) {
      return {
        module: fullName.substring(0, backtickIndex),
        name: fullName.substring(backtickIndex + 1),
      };
    }
    return { name: fullName };
  }

  private isLikelyUserSwiftFrame(name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed) {
      return false;
    }

    const lower = trimmed.toLowerCase();
    const systemPatterns = [
      /^_/,
      /^cf_/,
      /^objc_/,
      /^swift::/,
      /^swift_/,
      /^newjson/,
      /^partial apply/,
      /^thunk for/,
      /^completeTaskWithClosure/i,
      /^protocol witness/,
      /^merged/,
      /dispatch/,
      /foundation/,
      /swiftui/,
      /appkit/,
      /uikit/,
      /corefoundation/,
      /nsjson/,
      /jsonvalue/,
      /jsonobject/,
      /jsonstring/,
      /stringguts/,
      /substring\._/,
    ];
    if (systemPatterns.some((pattern) => pattern.test(lower))) {
      return false;
    }

    // xctrace sometimes exports Swift application frames without a binary
    // prefix, for example "closure #1 in MyService.load()". Keep these
    // visible so hang-window attribution does not disappear behind system
    // JSON/CF/Swift runtime frames.
    return /[A-Z][A-Za-z0-9_]*(Service|ViewModel|View|Controller|Manager|Store|Provider|Client|Repository|Coordinator|Monitor|Session|Model)\b/.test(trimmed);
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
    const tocFailure = trace.exportAttempts?.find((attempt) =>
      attempt.kind === 'toc' && attempt.status === 'failed'
    );

    if (tocFailure) {
      parts.push(
        tocFailure.message
          ? `Trace analysis is incomplete because xctrace could not export the trace TOC: ${tocFailure.message}`
          : 'Trace analysis is incomplete because xctrace could not export the trace TOC.'
      );
      parts.push('The trace may be malformed or partial; see Export Diagnostics for details.');
      return parts.join(' ');
    }

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

    if (stats.timeProfileError) {
      parts.push(
        `Time Profiler analysis failed: ${stats.timeProfileError}. The trace itself was recorded; see Export Diagnostics for details.`
      );
    }

    // Overall assessment
    if (bottlenecks.length === 0 && !stats.timeProfileError) {
      if (hangs && hangs.events.length > 0) {
        parts.push('No Time Profiler CPU functions crossed the bottleneck threshold.');
      } else {
        parts.push('✅ No Time Profiler CPU bottlenecks detected.');
      }
    } else {
      const critical = bottlenecks.filter(b => b.impact === 'critical').length;
      const high = bottlenecks.filter(b => b.impact === 'high').length;

      if (critical > 0) {
        parts.push(`⚠️ Found ${critical} critical CPU bottleneck${critical > 1 ? 's' : ''}.`);
      }
      if (high > 0) {
        parts.push(`Found ${high} high-impact CPU bottleneck${high > 1 ? 's' : ''}.`);
      }
    }

    // Time summary
    if (!stats.timeProfileError) {
      const totalSeconds = (stats.totalTime / 1000).toFixed(1);
      parts.push(`Total execution time: ${totalSeconds}s across ${stats.threadCount} thread${stats.threadCount > 1 ? 's' : ''}.`);
    } else {
      parts.push('Time Profiler totals are unavailable because parsing failed.');
    }

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

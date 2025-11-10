/**
 * ComparativeAnalyzer - Compares two traces and detects regressions
 */

import {
  Analysis,
  Comparison,
  ComparisonOptions,
  Regression,
  Improvement,
  PerformanceDelta,
  FunctionProfile,
  AnalysisError,
} from '../types.js';

/**
 * Default comparison options
 */
const DEFAULT_OPTIONS: Required<ComparisonOptions> = {
  failOnRegression: false,
  regressionThreshold: 10, // 10% increase
  minDuration: 10, // 10ms minimum
};

/**
 * Compares two trace analyses
 */
export class ComparativeAnalyzer {
  /**
   * Compare two analyses (baseline vs current)
   */
  compare(baseline: Analysis, current: Analysis, options: ComparisonOptions = {}): Comparison {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    try {
      // Calculate performance delta
      const delta = this.calculateDelta(baseline, current);

      // Detect regressions
      const regressions = this.detectRegressions(baseline, current, opts);

      // Detect improvements
      const improvements = this.detectImprovements(baseline, current, opts);

      // Check if there's any critical regression
      const hasCriticalRegression = regressions.some(r => r.severity === 'critical');
      const hasRegression = regressions.length > 0;

      // Generate summary
      const summary = this.generateComparisonSummary(baseline, current, delta, regressions, improvements);

      return {
        baseline,
        current,
        delta,
        regressions,
        improvements,
        hasRegression,
        hasCriticalRegression,
        summary,
      };
    } catch (error) {
      throw new AnalysisError('Failed to compare traces', error as Error);
    }
  }

  /**
   * Calculate performance delta between two analyses
   */
  private calculateDelta(baseline: Analysis, current: Analysis): PerformanceDelta {
    const baselineTime = baseline.stats.totalTime;
    const currentTime = current.stats.totalTime;

    const totalTimeChange = currentTime - baselineTime;
    const totalTimeChangePercent = baselineTime > 0
      ? (totalTimeChange / baselineTime) * 100
      : 0;

    // Compare function-by-function
    const baselineFunctions = new Map(
      baseline.topFunctions.map(f => [`${f.module}::${f.name}`, f])
    );
    const currentFunctions = new Map(
      current.topFunctions.map(f => [`${f.module}::${f.name}`, f])
    );

    let regressions = 0;
    let improvements = 0;
    let unchanged = 0;

    for (const [key, baselineFunc] of baselineFunctions) {
      const currentFunc = currentFunctions.get(key);
      if (currentFunc) {
        const change = currentFunc.selfTime - baselineFunc.selfTime;
        if (Math.abs(change) < 1) {
          unchanged++;
        } else if (change > 0) {
          regressions++;
        } else {
          improvements++;
        }
      }
    }

    return {
      totalTimeChange,
      totalTimeChangePercent,
      functionChanges: {
        regressions,
        improvements,
        unchanged,
      },
    };
  }

  /**
   * Detect performance regressions
   */
  private detectRegressions(
    baseline: Analysis,
    current: Analysis,
    options: Required<ComparisonOptions>
  ): Regression[] {
    const regressions: Regression[] = [];

    // Create maps for quick lookup
    const baselineFunctions = new Map(
      baseline.topFunctions.map(f => [`${f.module}::${f.name}`, f])
    );

    // Check each function in current trace
    for (const currentFunc of current.topFunctions) {
      const key = `${currentFunc.module}::${currentFunc.name}`;
      const baselineFunc = baselineFunctions.get(key);

      if (!baselineFunc) {
        // New function appeared - might be a concern if it's slow
        if (currentFunc.selfTime > options.minDuration * 10) {
          regressions.push({
            function: currentFunc.name,
            module: currentFunc.module,
            baselineTime: 0,
            currentTime: currentFunc.selfTime,
            percentageIncrease: 100,
            absoluteIncrease: currentFunc.selfTime,
            severity: this.determineRegressionSeverity(
              0,
              currentFunc.selfTime,
              current.stats.totalTime
            ),
          });
        }
        continue;
      }

      // Skip if function was already fast
      if (baselineFunc.selfTime < options.minDuration) {
        continue;
      }

      const absoluteIncrease = currentFunc.selfTime - baselineFunc.selfTime;
      const percentageIncrease = (absoluteIncrease / baselineFunc.selfTime) * 100;

      // Check if it exceeds regression threshold
      if (percentageIncrease > options.regressionThreshold) {
        regressions.push({
          function: currentFunc.name,
          module: currentFunc.module,
          baselineTime: baselineFunc.selfTime,
          currentTime: currentFunc.selfTime,
          percentageIncrease,
          absoluteIncrease,
          severity: this.determineRegressionSeverity(
            percentageIncrease,
            absoluteIncrease,
            current.stats.totalTime
          ),
        });
      }
    }

    // Sort by severity and absolute impact
    return regressions.sort((a, b) => {
      const severityOrder = { critical: 0, major: 1, minor: 2 };
      if (severityOrder[a.severity] !== severityOrder[b.severity]) {
        return severityOrder[a.severity] - severityOrder[b.severity];
      }
      return b.absoluteIncrease - a.absoluteIncrease;
    });
  }

  /**
   * Detect performance improvements
   */
  private detectImprovements(
    baseline: Analysis,
    current: Analysis,
    options: Required<ComparisonOptions>
  ): Improvement[] {
    const improvements: Improvement[] = [];

    // Create maps for quick lookup
    const currentFunctions = new Map(
      current.topFunctions.map(f => [`${f.module}::${f.name}`, f])
    );

    // Check each function in baseline trace
    for (const baselineFunc of baseline.topFunctions) {
      if (baselineFunc.selfTime < options.minDuration) {
        continue;
      }

      const key = `${baselineFunc.module}::${baselineFunc.name}`;
      const currentFunc = currentFunctions.get(key);

      if (!currentFunc) {
        // Function disappeared (maybe optimized away completely)
        improvements.push({
          function: baselineFunc.name,
          module: baselineFunc.module,
          baselineTime: baselineFunc.selfTime,
          currentTime: 0,
          percentageDecrease: 100,
          absoluteDecrease: baselineFunc.selfTime,
        });
        continue;
      }

      const absoluteDecrease = baselineFunc.selfTime - currentFunc.selfTime;
      const percentageDecrease = (absoluteDecrease / baselineFunc.selfTime) * 100;

      // Check if it's a meaningful improvement (> 5%)
      if (percentageDecrease > 5 && absoluteDecrease > options.minDuration) {
        improvements.push({
          function: currentFunc.name,
          module: currentFunc.module,
          baselineTime: baselineFunc.selfTime,
          currentTime: currentFunc.selfTime,
          percentageDecrease,
          absoluteDecrease,
        });
      }
    }

    // Sort by absolute improvement
    return improvements.sort((a, b) => b.absoluteDecrease - a.absoluteDecrease);
  }

  /**
   * Determine regression severity
   */
  private determineRegressionSeverity(
    percentageIncrease: number,
    absoluteIncrease: number,
    totalTime: number
  ): Regression['severity'] {
    // Critical if:
    // - More than 50% increase AND absolute increase > 200ms
    // - Absolute increase is more than 20% of total time
    if (
      (percentageIncrease > 50 && absoluteIncrease > 200) ||
      (absoluteIncrease / totalTime) > 0.2
    ) {
      return 'critical';
    }

    // Major if:
    // - More than 30% increase AND absolute increase > 100ms
    // - Absolute increase is more than 10% of total time
    if (
      (percentageIncrease > 30 && absoluteIncrease > 100) ||
      (absoluteIncrease / totalTime) > 0.1
    ) {
      return 'major';
    }

    return 'minor';
  }

  /**
   * Generate comparison summary
   */
  private generateComparisonSummary(
    baseline: Analysis,
    current: Analysis,
    delta: PerformanceDelta,
    regressions: Regression[],
    improvements: Improvement[]
  ): string {
    const parts: string[] = [];

    // Overall change
    const changePercent = Math.abs(delta.totalTimeChangePercent).toFixed(1);
    if (delta.totalTimeChangePercent > 5) {
      parts.push(`⚠️ Performance regressed by ${changePercent}% (${(delta.totalTimeChange / 1000).toFixed(2)}s slower).`);
    } else if (delta.totalTimeChangePercent < -5) {
      parts.push(`✅ Performance improved by ${changePercent}% (${Math.abs(delta.totalTimeChange / 1000).toFixed(2)}s faster).`);
    } else {
      parts.push(`✓ Performance is similar to baseline (${changePercent}% change).`);
    }

    // Regressions
    if (regressions.length > 0) {
      const critical = regressions.filter(r => r.severity === 'critical').length;
      const major = regressions.filter(r => r.severity === 'major').length;

      if (critical > 0) {
        parts.push(`🔴 Found ${critical} critical regression${critical > 1 ? 's' : ''}.`);
      }
      if (major > 0) {
        parts.push(`Found ${major} major regression${major > 1 ? 's' : ''}.`);
      }

      const topRegression = regressions[0];
      parts.push(
        `Biggest regression: ${topRegression.function} ` +
        `(+${topRegression.percentageIncrease.toFixed(0)}%, ` +
        `${topRegression.baselineTime.toFixed(0)}ms → ${topRegression.currentTime.toFixed(0)}ms).`
      );
    }

    // Improvements
    if (improvements.length > 0) {
      const topImprovement = improvements[0];
      parts.push(
        `🟢 Best improvement: ${topImprovement.function} ` +
        `(-${topImprovement.percentageDecrease.toFixed(0)}%, ` +
        `${topImprovement.baselineTime.toFixed(0)}ms → ${topImprovement.currentTime.toFixed(0)}ms).`
      );
    }

    return parts.join(' ');
  }
}

/**
 * Convenience function to compare traces
 */
export function compareTraces(
  baseline: Analysis,
  current: Analysis,
  options?: ComparisonOptions
): Comparison {
  const analyzer = new ComparativeAnalyzer();
  return analyzer.compare(baseline, current, options);
}

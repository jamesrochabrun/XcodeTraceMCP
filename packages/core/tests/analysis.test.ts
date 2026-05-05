import { describe, expect, it, vi } from 'vitest';
import { PerformanceAnalyzer } from '../src/analyzer/performance-analyzer.js';
import { ComparativeAnalyzer } from '../src/analyzer/comparative-analyzer.js';
import { Analysis, ParsedTrace } from '../src/types.js';

function parsedTrace(functions: Array<{ name: string; selfTime: number; totalTime?: number; callCount?: number }>): ParsedTrace {
  return {
    metadata: {
      fileName: 'sample.trace',
      filePath: '/tmp/sample.trace',
      duration: 1200,
      template: 'Time Profiler',
    },
    timeProfile: {
      totalDuration: 1200,
      samples: [
        {
          timestamp: 1200,
          threadId: 1,
          weight: 1,
          backtrace: functions.map((func) => `App\`${func.name}`),
        },
      ],
      functionProfiles: functions.map((func) => ({
        name: func.name,
        module: 'App',
        totalTime: func.totalTime ?? func.selfTime,
        selfTime: func.selfTime,
        callCount: func.callCount ?? 1,
        percentage: 0,
      })),
    },
  };
}

function analysisWithTopFunctions(functions: Array<{ name: string; selfTime: number }>): Analysis {
  return new PerformanceAnalyzer().analyze(parsedTrace(functions), {
    slowThreshold: 10,
    topN: 10,
  });
}

describe('PerformanceAnalyzer', () => {
  it('identifies bottlenecks by self time and labels impact from duration and percentage', () => {
    const analysis = new PerformanceAnalyzer().analyze(
      parsedTrace([
        { name: 'ImageProcessor.resize', selfTime: 450 },
        { name: 'TinyFunction', selfTime: 5 },
      ]),
      { slowThreshold: 100, topN: 5 }
    );

    expect(analysis.stats.slowFunctions).toBe(1);
    expect(analysis.bottlenecks).toEqual([
      expect.objectContaining({
        function: 'ImageProcessor.resize',
        impact: 'critical',
        duration: 450,
        suggestion: 'Consider caching rendered images or using lower resolution',
      }),
    ]);
    expect(analysis.topFunctions[0]).toEqual(
      expect.objectContaining({
        name: 'ImageProcessor.resize',
        percentage: 37.5,
      })
    );
  });

  it('reports incomplete analysis when the trace TOC export failed', () => {
    const analysis = new PerformanceAnalyzer().analyze({
      metadata: {
        fileName: 'broken.trace',
        filePath: '/tmp/broken.trace',
        duration: 0,
        template: 'Unknown',
      },
      exportAttempts: [
        {
          kind: 'toc',
          status: 'failed',
          message: 'Document Missing Template Error',
        },
      ],
    });

    expect(analysis.summary).toContain('Trace analysis is incomplete');
    expect(analysis.summary).toContain('Document Missing Template Error');
    expect(analysis.summary).not.toContain('No significant performance bottlenecks detected');
  });
});

describe('ComparativeAnalyzer', () => {
  it('reports regressions and improvements between matching functions', () => {
    const baseline = analysisWithTopFunctions([
      { name: 'NetworkClient.parseJSON', selfTime: 100 },
      { name: 'Database.fetch', selfTime: 200 },
    ]);
    const current = analysisWithTopFunctions([
      { name: 'NetworkClient.parseJSON', selfTime: 180 },
      { name: 'Database.fetch', selfTime: 120 },
    ]);

    const comparison = new ComparativeAnalyzer().compare(baseline, current, {
      regressionThreshold: 10,
      minDuration: 10,
    });

    expect(comparison.hasRegression).toBe(true);
    expect(comparison.regressions).toEqual([
      expect.objectContaining({
        function: 'NetworkClient.parseJSON',
        baselineTime: 100,
        currentTime: 180,
        percentageIncrease: 80,
      }),
    ]);
    expect(comparison.improvements).toEqual([
      expect.objectContaining({
        function: 'Database.fetch',
        baselineTime: 200,
        currentTime: 120,
        percentageDecrease: 40,
      }),
    ]);
  });
});

describe('analyzeTraceFile', () => {
  it('omits recommendations when includeRecommendations is false', async () => {
    vi.resetModules();
    vi.doMock('../src/parser/trace-parser.js', () => ({
      TraceParser: class {},
      parseTrace: async () =>
        parsedTrace([{ name: 'ImageProcessor.resize', selfTime: 450 }]),
    }));

    const { analyzeTraceFile } = await import('../src/index.js');

    const analysis = await analyzeTraceFile('/tmp/app.trace', {
      slowThreshold: 100,
      includeRecommendations: false,
    });

    expect(analysis.bottlenecks).toHaveLength(1);
    expect(analysis.recommendations).toEqual([]);

    vi.doUnmock('../src/parser/trace-parser.js');
  });
});

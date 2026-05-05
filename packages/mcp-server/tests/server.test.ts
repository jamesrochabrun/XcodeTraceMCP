import { describe, expect, it } from 'vitest';
import { XCTraceAnalyzerServer } from '../src/index.js';
import { Analysis, Comparison, RecordOptions } from '@xctrace-analyzer/core';

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    metadata: {
      fileName: 'app.trace',
      filePath: '/tmp/app.trace',
      duration: 1000,
      template: 'Time Profiler',
    },
    stats: {
      totalTime: 1000,
      slowFunctions: 2,
      avgFunctionTime: 75,
      maxFunctionTime: 250,
      threadCount: 1,
    },
    bottlenecks: [
      {
        function: 'ImageProcessor.resize',
        module: 'App',
        impact: 'medium',
        duration: 250,
        percentage: 25,
        suggestion: 'Cache images',
        callCount: 2,
      },
    ],
    recommendations: [],
    topFunctions: [],
    instrumentAnalyses: [],
    summary: 'Found useful data.',
    ...overrides,
  };
}

function comparison(overrides: Partial<Comparison> = {}): Comparison {
  const base = analysis({ metadata: { ...analysis().metadata, fileName: 'base.trace' } });
  const current = analysis({ metadata: { ...analysis().metadata, fileName: 'current.trace' } });

  return {
    baseline: base,
    current,
    delta: {
      totalTimeChange: 250,
      totalTimeChangePercent: 25,
      functionChanges: {
        regressions: 1,
        improvements: 0,
        unchanged: 0,
      },
    },
    regressions: [
      {
        function: 'ImageProcessor.resize',
        module: 'App',
        baselineTime: 100,
        currentTime: 250,
        percentageIncrease: 150,
        absoluteIncrease: 150,
        severity: 'major',
      },
    ],
    improvements: [],
    hasRegression: true,
    hasCriticalRegression: false,
    summary: 'Performance regressed.',
    ...overrides,
  };
}

describe('XCTraceAnalyzerServer', () => {
  it('suggests a concrete profiling workflow for vague profile requests', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => ['Time Profiler', 'Allocations', 'Leaks'],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
      getXCTraceCapabilities: async () => ({
        available: true,
        version: 'xctrace version 16.0 (17E192)',
        templates: ['Time Profiler', 'Allocations', 'Leaks'],
        devices: ['MacBook Pro'],
        instruments: [],
        exportModes: ['toc', 'xpath', 'har'],
        recordModes: ['attach', 'launch', 'all-processes'],
        supportsSymbolication: true,
        warnings: [],
      }),
    });

    const result = await server.callTool('profile_advisor', {
      request: 'lets profile my app',
      processName: 'MyApp',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('# Profiling Advisor');
    expect(result.content[0].text).toContain('Use `profile_running_app`: Full performance report.');
    expect(result.content[0].text).toContain('"processName": "MyApp"');
    expect(result.content[0].text).toContain('"preset": "full"');
    expect(result.content[0].text).toContain('## Workflow Notes');
    expect(result.content[0].text).toContain('rerun with the exact PID as processName');
  });

  it('warns launch profiling users about saved but non-exportable traces', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => ['Time Profiler'],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
      getXCTraceCapabilities: async () => ({
        available: true,
        version: 'xctrace version 16.0 (17E192)',
        templates: ['Time Profiler'],
        devices: ['MacBook Pro'],
        instruments: [],
        exportModes: ['toc', 'xpath', 'har'],
        recordModes: ['attach', 'launch', 'all-processes'],
        supportsSymbolication: true,
        warnings: [],
      }),
    });

    const result = await server.callTool('profile_advisor', {
      request: 'profile launch performance',
      launchCommand: '/tmp/MyApp.app',
      outputFormat: 'json',
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.target.mode).toBe('launch');
    expect(payload.workflowNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Document Missing Template Error'),
      ])
    );
  });

  it('suggests analyze_trace when an existing trace path is provided', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    });

    const result = await server.callTool('profile_advisor', {
      request: 'analyze this trace',
      tracePath: '/tmp/app.trace',
      outputFormat: 'json',
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.recommended.tool).toBe('analyze_trace');
    expect(payload.recommended.arguments.tracePath).toBe('/tmp/app.trace');
  });

  it('formats analysis output with clear slow function statistics', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    });

    const result = await server.callTool('analyze_trace', {
      tracePath: '/tmp/app.trace',
      slowThreshold: 100,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('- Slow functions: 2');
    expect(result.content[0].text).not.toContain('Slow functions (>2): 2');
  });

  it('renders a Hangs section when the analysis includes hang events', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () =>
        analysis({
          hangs: {
            events: [
              {
                startMs: 2143.625,
                durationMs: 11371.5,
                hangType: 'Severe Hang',
                threadName: 'Main Thread (AgentHub)',
                processName: 'AgentHub (36405)',
                schemaSource: 'potential-hangs',
              },
              {
                startMs: 587.84,
                durationMs: 562.5,
                hangType: 'Hang',
                threadName: 'Main Thread (AgentHub)',
                processName: 'AgentHub (36405)',
                schemaSource: 'potential-hangs',
              },
            ],
            totalHangMs: 11934.0,
            severeCount: 1,
            hangCount: 1,
            microhangCount: 0,
            longestMs: 11371.5,
            sourceSchemas: ['potential-hangs'],
          },
        }),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    });

    const result = await server.callTool('analyze_trace', {
      tracePath: '/tmp/app.trace',
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('## Hangs');
    expect(text).toContain('Severe Hang');
    expect(text).toContain('11.37 s');
    expect(text).toContain('Main Thread (AgentHub)');
    // Sorted by duration descending — severe hang appears before standard hang.
    const severeIdx = text.indexOf('Severe Hang');
    const standardIdx = text.indexOf('— Hang —');
    expect(severeIdx).toBeGreaterThan(-1);
    expect(standardIdx).toBeGreaterThan(severeIdx);
  });

  it('omits the Hangs section when the analysis has no hang events', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    });

    const result = await server.callTool('analyze_trace', { tracePath: '/tmp/app.trace' });
    expect(result.content[0].text).not.toContain('## Hangs');
  });

  it('marks compare_traces as an MCP error when failOnRegression is true and regressions exist', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    });

    const result = await server.callTool('compare_traces', {
      baselinePath: '/tmp/base.trace',
      currentPath: '/tmp/current.trace',
      failOnRegression: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('# Trace Comparison Report');
    expect(result.content[0].text).toContain('ImageProcessor.resize');
  });

  it('includes xctrace version in the availability check', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    });

    const result = await server.callTool('check_xctrace', {});

    expect(result.content[0].text).toContain('xctrace is available');
    expect(result.content[0].text).toContain('xctrace version 16.0 (17E192)');
    expect(result.content[0].text).toContain('Capabilities:');
  });

  it('returns concise tool errors without stack traces', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => {
        throw new Error('Trace file not found');
      },
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    });

    const result = await server.callTool('analyze_trace', {
      tracePath: '/tmp/missing.trace',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error: Trace file not found');
    expect(result.content[0].text).not.toContain('\n    at ');
  });

  it('renders additional instrument analysis sections in analyze_trace output', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () =>
        analysis({
          instrumentAnalyses: [
            {
              kind: 'memory',
              title: 'Memory Analysis',
              summary: 'Peak memory was 700.0 MB.',
              sourceSchemas: ['memory-statistics'],
              metrics: [
                {
                  name: 'Peak Memory',
                  value: '700.0 MB',
                  numericValue: 734003200,
                  unit: 'bytes',
                },
              ],
              findings: [
                {
                  severity: 'high',
                  title: 'High peak memory usage',
                  description: 'Peak memory exceeded 512 MB.',
                },
              ],
            },
            {
              kind: 'network',
              title: 'Network Analysis',
              summary: '2 requests, 1 failed.',
              sourceSchemas: ['har'],
              metrics: [
                {
                  name: 'Failed Requests',
                  value: 1,
                  numericValue: 1,
                },
              ],
              findings: [],
            },
          ],
        }),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    });

    const result = await server.callTool('analyze_trace', {
      tracePath: '/tmp/app.trace',
    });

    expect(result.content[0].text).toContain('## Additional Instrument Analysis');
    expect(result.content[0].text).toContain('### Memory Analysis');
    expect(result.content[0].text).toContain('- Peak Memory: 700.0 MB');
    expect(result.content[0].text).toContain('High peak memory usage');
    expect(result.content[0].text).toContain('### Network Analysis');
  });

  it('returns structured JSON when requested', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () =>
        analysis({
          supportStatus: [
            {
              kind: 'network',
              status: 'partial',
              reason: 'HAR was exported, but raw CFNetwork tables were skipped.',
              sourceSchemas: ['har', 'com-apple-cfnetwork-task-drawables'],
            },
          ],
          exportAttempts: [
            {
              kind: 'har',
              status: 'success',
            },
          ],
        }),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    });

    const result = await server.callTool('analyze_trace', {
      tracePath: '/tmp/app.trace',
      outputFormat: 'json',
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.analysis.summary).toBe('Found useful data.');
    expect(payload.supportStatus).toEqual([
      expect.objectContaining({ kind: 'network', status: 'partial' }),
    ]);
    expect(payload.exportAttempts).toEqual([
      expect.objectContaining({ kind: 'har', status: 'success' }),
    ]);
  });

  it('symbolicates to a temporary trace before analysis when a dSYM path is provided', async () => {
    let analyzedPath: string | undefined;
    let symbolicatedInput: string | undefined;
    let symbolicatedOutput: string | undefined;

    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async (tracePath) => {
        analyzedPath = tracePath;
        return analysis();
      },
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
      symbolicateTrace: async (options) => {
        symbolicatedInput = options.inputPath;
        symbolicatedOutput = options.outputPath;
      },
    });

    const result = await server.callTool('analyze_trace', {
      tracePath: '/tmp/app.trace',
      dsymPath: '/tmp/App.dSYM',
      outputFormat: 'json',
    });
    const payload = JSON.parse(result.content[0].text);

    expect(symbolicatedInput).toBe('/tmp/app.trace');
    expect(symbolicatedOutput).toContain('app-symbolicated.trace');
    expect(analyzedPath).toBe(symbolicatedOutput);
    expect(payload.exportAttempts[0]).toEqual(
      expect.objectContaining({ kind: 'symbolication', status: 'success' })
    );
  });

  it('records a running app and analyzes the captured trace', async () => {
    let recordOptions: RecordOptions | undefined;

    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async (tracePath) =>
        analysis({
          metadata: {
            ...analysis().metadata,
            fileName: 'MyApp-leaks.trace',
            filePath: tracePath,
            template: 'Leaks',
          },
          instrumentAnalyses: [
            {
              kind: 'leaks',
              title: 'Leaks Analysis',
              summary: '3 leaks were detected.',
              sourceSchemas: ['leaks-summary'],
              metrics: [{ name: 'Leaks', value: 3, numericValue: 3 }],
              findings: [
                {
                  severity: 'critical',
                  title: 'Leaks detected',
                  description: 'The trace contains leaked memory.',
                },
              ],
            },
          ],
        }),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async (options) => {
        recordOptions = options;
      },
    });

    const result = await server.callTool('track_running_app', {
      processName: 'MyApp',
      template: 'Leaks',
      durationSeconds: 60,
      device: 'iPhone 16 Pro Simulator',
      outputPath: '/tmp/MyApp-leaks.trace',
    });

    expect(recordOptions).toEqual({
      template: 'Leaks',
      processName: 'MyApp',
      duration: 60,
      device: 'iPhone 16 Pro Simulator',
      outputPath: '/tmp/MyApp-leaks.trace',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('# Running App Trace Report');
    expect(result.content[0].text).toContain('- Target: attach: MyApp');
    expect(result.content[0].text).toContain('- Template: Leaks');
    expect(result.content[0].text).toContain('- Trace: /tmp/MyApp-leaks.trace');
    expect(result.content[0].text).toContain('### Leaks Analysis');
    expect(result.content[0].text).toContain('Leaks detected');
  });

  it('records a launched target with arguments and environment', async () => {
    let recordOptions: RecordOptions | undefined;

    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async (options) => {
        recordOptions = options;
      },
    });

    const result = await server.callTool('track_running_app', {
      target: 'launch',
      launchCommand: '/tmp/MyTool',
      launchArguments: ['--mode', 'profile'],
      environment: { PERF_TEST: '1' },
      template: 'Allocations',
      durationSeconds: 5,
      outputPath: '/tmp/MyTool.trace',
      analyze: false,
    });

    expect(recordOptions).toEqual({
      template: 'Allocations',
      launchCommand: '/tmp/MyTool',
      launchArguments: ['--mode', 'profile'],
      environment: { PERF_TEST: '1' },
      targetStdin: undefined,
      targetStdout: undefined,
      duration: 5,
      outputPath: '/tmp/MyTool.trace',
    });
    expect(result.content[0].text).toContain('- Target: launch: /tmp/MyTool');
    expect(result.content[0].text).toContain('Analysis skipped.');
  });

  it('profiles a running app with the full preset and returns one combined report', async () => {
    const recordOptions: RecordOptions[] = [];

    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async (tracePath) =>
        analysis({
          metadata: {
            ...analysis().metadata,
            fileName: 'MyApp-full.trace',
            filePath: tracePath,
            template: 'Time Profiler',
          },
          instrumentAnalyses: [
            {
              kind: 'leaks',
              title: 'Leaks Analysis',
              summary: '3 leaks were detected.',
              sourceSchemas: ['leaks-summary'],
              metrics: [{ name: 'Leaks', value: 3, numericValue: 3 }],
              findings: [
                {
                  severity: 'critical',
                  title: 'Leaks detected',
                  description: 'The trace contains leaked memory.',
                },
              ],
            },
            {
              kind: 'network',
              title: 'Network Analysis',
              summary: '2 requests, 1 failed.',
              sourceSchemas: ['har'],
              metrics: [{ name: 'Failed Requests', value: 1, numericValue: 1 }],
              findings: [
                {
                  severity: 'medium',
                  title: 'Network failures detected',
                  description: '1 request returned an error status.',
                },
              ],
            },
          ],
        }),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async (options) => {
        recordOptions.push(options);
      },
    });

    const result = await server.callTool('profile_running_app', {
      processName: 'MyApp',
      preset: 'full',
      durationSeconds: 10,
      outputDirectory: '/tmp/profiles',
    });

    expect(recordOptions).toEqual([
      expect.objectContaining({
        template: 'Time Profiler',
        instruments: ['Leaks', 'Allocations', 'HTTP Traffic'],
        processName: 'MyApp',
        duration: 10,
        outputPath: expect.stringContaining('/tmp/profiles/MyApp-full-'),
      }),
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('# Profiling Report');
    expect(result.content[0].text).toContain('- Target: attach: MyApp');
    expect(result.content[0].text).toContain('- Preset: full');
    expect(result.content[0].text).toContain('- Duration: 10s');
    expect(result.content[0].text).toContain('- Recording strategy: combined');
    expect(result.content[0].text).toContain('- Base template: Time Profiler');
    expect(result.content[0].text).toContain('- Instruments: Leaks, Allocations, HTTP Traffic');
    expect(result.content[0].text).toContain('## CPU / Time Profiler');
    expect(result.content[0].text).toContain('ImageProcessor.resize');
    expect(result.content[0].text).toContain('## Leaks');
    expect(result.content[0].text).toContain('Leaks detected');
    expect(result.content[0].text).toContain('## Network');
    expect(result.content[0].text).toContain('Network failures detected');
    expect(result.content[0].text).toContain('## Prioritized Recommendations');
  });

  it('keeps Power Profiler in the iOS combined preset and reports unsupported-instrument errors', async () => {
    let recordOptions: RecordOptions | undefined;
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async (tracePath) =>
        analysis({
          metadata: {
            ...analysis().metadata,
            filePath: tracePath,
          },
        }),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async (options) => {
        recordOptions = options;
        if (options.instruments?.includes('Power Profiler')) {
          throw new Error('The Power Profiler instrument is not supported on macOS.');
        }
      },
    });

    const result = await server.callTool('profile_running_app', {
      processName: 'MyApp',
      preset: 'full-ios',
      durationSeconds: 1,
      outputDirectory: '/tmp/profiles',
    });

    expect(recordOptions).toEqual(
      expect.objectContaining({
        template: 'Time Profiler',
        instruments: ['Leaks', 'Allocations', 'HTTP Traffic', 'Power Profiler'],
        duration: 1,
      })
    );
    expect(result.content[0].text).toContain('- Instruments: Leaks, Allocations, HTTP Traffic, Power Profiler');
    expect(result.content[0].text).toContain('The Power Profiler instrument is not supported on macOS.');
  });
});

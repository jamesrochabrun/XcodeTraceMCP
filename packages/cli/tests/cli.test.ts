import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Analysis, Comparison, RecordOptions } from '@xctrace-analyzer/core';
import { runCli, XCTraceAnalyzerCliDependencies } from '../src/index.js';

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
      slowFunctions: 1,
      avgFunctionTime: 120,
      maxFunctionTime: 250,
      threadCount: 1,
    },
    bottlenecks: [
      {
        function: 'App.render',
        module: 'App',
        impact: 'medium',
        duration: 250,
        percentage: 25,
        suggestion: 'Reduce work',
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
  const baseline = analysis();
  const current = analysis();
  return {
    baseline,
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
        function: 'App.render',
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

function cliIo() {
  let stdout = '';
  let stderr = '';

  return {
    io: {
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      stderr: { write: (chunk: string) => { stderr += chunk; } },
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

function deps(overrides: Partial<XCTraceAnalyzerCliDependencies> = {}): XCTraceAnalyzerCliDependencies {
  return {
    analyzeTraceFile: async () => analysis(),
    compareTraceFiles: async () => comparison(),
    listTemplates: async () => ['Time Profiler'],
    listDevices: async () => ['Mac'],
    getXCTraceCapabilities: async () => ({
      available: true,
      version: 'xctrace version 16.0',
      templates: ['Time Profiler'],
      devices: ['Mac'],
      instruments: ['Allocations'],
      exportModes: ['toc', 'xpath'],
      recordModes: ['attach'],
      supportsSymbolication: true,
      warnings: ['token=abc123'],
    }),
    recordTrace: async () => {},
    ...overrides,
  };
}

describe('xctrace-analyzer CLI', () => {
  it('prints version information', async () => {
    const output = cliIo();

    const exitCode = await runCli(['--version'], output.io, deps());

    expect(exitCode).toBe(0);
    expect(output.stdout).toBe('xctrace-analyzer 0.1.7\n');
    expect(output.stderr).toBe('');
  });

  it('prints a doctor report with redacted diagnostics', async () => {
    const output = cliIo();

    const exitCode = await runCli(['doctor'], output.io, deps());

    expect(exitCode).toBe(0);
    expect(output.stdout).toContain('xcrun xctrace: available');
    expect(output.stdout).toContain('templates: 1');
    expect(output.stdout).toContain('/Users/<redacted>/Library/Application Support/xctrace-analyzer/traces');
    expect(output.stdout).toContain('token=<redacted>');
    expect(output.stderr).toBe('');
  });

  it('analyzes an existing trace and passes scoped options', async () => {
    const output = cliIo();
    let receivedPath = '';
    let receivedOptions: unknown;

    const exitCode = await runCli(
      [
        'analyze',
        '/tmp/app.trace',
        '--time-range',
        '100:900',
        '--user-binary-hint',
        'App',
        '--top',
        '5',
        '--format',
        'json',
      ],
      output.io,
      deps({
        analyzeTraceFile: async (tracePath, options) => {
          receivedPath = tracePath;
          receivedOptions = options;
          return analysis();
        },
      })
    );

    expect(exitCode).toBe(0);
    expect(receivedPath).toBe('/tmp/app.trace');
    expect(receivedOptions).toMatchObject({
      topN: 5,
      timeRangeMs: { startMs: 100, endMs: 900 },
      userBinaryHints: ['App'],
    });
    expect(JSON.parse(output.stdout).analysis.summary).toBe('Found useful data.');
  });

  it('records with the full preset through core without starting MCP', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'xctrace-cli-test-'));
    const previousTraceRoot = process.env.XCTRACE_ANALYZER_TRACE_ROOT;
    process.env.XCTRACE_ANALYZER_TRACE_ROOT = tempDir;
    const output = cliIo();
    let receivedOptions: RecordOptions | undefined;

    try {
      const exitCode = await runCli(
        [
          'record',
          '--process',
          '123',
          '--duration',
          '1',
          '--preset',
          'full',
          '--no-open',
          '--no-analyze',
          '--format',
          'json',
        ],
        output.io,
        deps({
          recordTrace: async (options) => {
            receivedOptions = options;
          },
        })
      );

      expect(exitCode).toBe(0);
      expect(receivedOptions).toMatchObject({
        template: 'Time Profiler',
        instruments: ['Leaks', 'Allocations', 'HTTP Traffic'],
        processName: '123',
        duration: 1,
      });
      expect(receivedOptions?.outputPath.startsWith(tempDir)).toBe(true);
      expect(JSON.parse(output.stdout).recording.outputPath).toContain('.trace');
    } finally {
      if (previousTraceRoot === undefined) {
        delete process.env.XCTRACE_ANALYZER_TRACE_ROOT;
      } else {
        process.env.XCTRACE_ANALYZER_TRACE_ROOT = previousTraceRoot;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

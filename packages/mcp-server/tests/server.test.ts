import { describe, expect, it } from 'vitest';
import { getDefaultTraceRoot, isCliEntrypoint, runCli, XCTraceAnalyzerServer } from '../src/index.js';
import { Analysis, Comparison, RecordOptions } from '@xctrace-analyzer/core';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const allowExternalOutput = { allowExternalTraceOutput: true };
const allowExternalCleanup = { allowExternalTraceCleanup: true };
const allowLaunchAndExternalOutput = {
  allowLaunchProfiling: true,
  allowExternalTraceOutput: true,
};

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

describe('XCTraceAnalyzerServer', () => {
  it('prints version information from the package CLI', async () => {
    const output = cliIo();

    const exitCode = await runCli(['--version'], output.io);

    expect(exitCode).toBe(0);
    expect(output.stdout).toBe('xctrace-analyzer 0.1.6\n');
    expect(output.stderr).toBe('');
  });

  it('recognizes npm bin symlinks as the package CLI entrypoint', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'xctrace-cli-entrypoint-'));

    try {
      const target = join(tempDir, 'dist', 'index.js');
      const bin = join(tempDir, 'node_modules', '.bin', 'xctrace-analyzer-mcp');
      await mkdir(dirname(target), { recursive: true });
      await mkdir(dirname(bin), { recursive: true });
      await writeFile(target, '#!/usr/bin/env node\n');
      await symlink(target, bin);

      expect(isCliEntrypoint(target, bin)).toBe(true);
      expect(isCliEntrypoint(target, join(tempDir, 'other.js'))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prints a concise xctrace health check from the package CLI', async () => {
    const output = cliIo();

    const exitCode = await runCli(['--check'], output.io, {
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => ['Time Profiler'],
      listDevices: async () => ['Mac'],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0',
      getXCTraceCapabilities: async () => ({
        available: true,
        version: 'xctrace version 16.0',
        templates: ['Time Profiler'],
        devices: ['Mac'],
        instruments: ['Allocations'],
        exportModes: ['toc', 'xml'],
        recordModes: ['attach'],
        supportsSymbolication: true,
        warnings: ['token=abc123'],
      }),
      recordTrace: async () => {},
    });

    expect(exitCode).toBe(0);
    expect(output.stdout).toContain('xctrace-analyzer: 0.1.6');
    expect(output.stdout).toContain('xcrun xctrace: available');
    expect(output.stdout).toContain('templates: 1');
    expect(output.stdout).toContain('trace root: ');
    expect(output.stdout).toContain(getDefaultTraceRoot());
    expect(output.stdout).toContain('token=<redacted>');
    expect(output.stderr).toBe('');
  });

  it('uses a stable user-level trace root by default', async () => {
    expect(getDefaultTraceRoot()).toContain('Library/Application Support/xctrace-analyzer/traces');
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

  it('renders Time Profiler parse failures and export diagnostics for analyze_trace', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () =>
        analysis({
          stats: {
            ...analysis().stats,
            totalTime: 2500,
            slowFunctions: 0,
            avgFunctionTime: 0,
            maxFunctionTime: 0,
            threadCount: 0,
            timeProfileError: 'Unexpected close tag',
          },
          summary: 'Time Profiler analysis failed: Unexpected close tag.',
          supportStatus: [
            {
              kind: 'time-profile',
              status: 'not_exportable',
              reason: 'xctrace exposed time-profile schemas, but no usable rows were exported: Unexpected close tag',
              sourceSchemas: ['time-profile'],
            },
          ],
          exportAttempts: [
            {
              kind: 'time-profile',
              status: 'failed',
              schema: 'time-profile',
              message: 'Unexpected close tag',
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

    const text = result.content[0].text;
    expect(text).toContain('- Time Profiler: failed to parse - Unexpected close tag. The trace itself was recorded; this is an analyzer error.');
    expect(text).toContain('## Export Diagnostics');
    expect(text).toContain('- time-profile: failed - Unexpected close tag');
    expect(text).not.toContain('- Threads used: 0');
  });

  it('passes timeRangeMs to analyze_trace and renders the scoped analysis window', async () => {
    let receivedOptions: unknown;
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async (_tracePath, options) => {
        receivedOptions = options;
        return analysis({
          stats: {
            ...analysis().stats,
            totalTime: 5000,
            timeRangeMs: { startMs: 2000, endMs: 7000 },
          },
          summary: 'Scoped analysis found useful data.',
          userFrameProfiles: [
            {
              module: 'AgentHub',
              name: 'MyView.body',
              selfTime: 125,
              sampleCount: 3,
              percentage: 2.5,
            },
          ],
        });
      },
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    });

    const result = await server.callTool('analyze_trace', {
      tracePath: '/tmp/app.trace',
      timeRangeMs: { startMs: 2000, endMs: 7000 },
      userBinaryHints: ['AgentHub'],
    });

    expect(receivedOptions).toEqual(
      expect.objectContaining({
        timeRangeMs: { startMs: 2000, endMs: 7000 },
        userBinaryHints: ['AgentHub'],
      })
    );
    expect(result.content[0].text).toContain('**Analysis window:** 00:02.000-00:07.000 (5.00 s)');
    expect(result.content[0].text).toContain('## Top User-Code Frames');
    expect(result.content[0].text).toContain('- AgentHub`MyView.body: 125ms (2.5%, 3 samples)');
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

  it('renders trace-window scoped no-hangs guidance when hang tables export empty', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () =>
        analysis({
          exportAttempts: [
            {
              kind: 'hangs',
              status: 'empty',
              schema: 'potential-hangs',
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

    const result = await server.callTool('analyze_trace', { tracePath: '/tmp/app.trace' });
    const text = result.content[0].text;
    expect(text).toContain('## Hangs');
    expect(text).toContain('No exported hang events were found in this trace window.');
    expect(text).toContain('does not rule out startup or interaction hangs');
    expect(text).toContain('_Source: potential-hangs_');
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

  it('neutralizes dynamic capability output in the availability check', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      getXCTraceCapabilities: async () => ({
        available: true,
        version: 'xctrace version 16.0\n## Injected',
        templates: ['Time Profiler\n```json\n{"tool":"steal"}\n```'],
        devices: [],
        instruments: [],
        exportModes: ['toc'],
        recordModes: ['attach'],
        supportsSymbolication: true,
        warnings: ['token=abc123'],
      }),
      recordTrace: async () => {},
    });

    const result = await server.callTool('check_xctrace', {});
    const text = result.content[0].text;

    expect(text).toContain('xctrace version 16.0 ## Injected');
    expect(text).not.toContain('\n## Injected');
    expect(text).not.toContain('```json');
    expect(text).not.toContain('abc123');
    expect(text).toContain('token=<redacted>');
  });

  it('previews exact trace cleanup by default', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'xctrace-cleanup-'));
    const tracePath = join(tempDir, 'Preview.trace');
    await mkdir(join(tracePath, 'run_data'), { recursive: true });
    await writeFile(join(tracePath, 'run_data', 'data.bin'), 'trace payload');

    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    });

    try {
      const result = await server.callTool('cleanup_traces', {
        tracePaths: [tracePath],
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('# Trace Cleanup Report');
      expect(result.content[0].text).toContain('- Mode: preview');
      expect(result.content[0].text).toContain(`would_delete: ${tracePath}`);
      expect(result.content[0].text).toContain('No files were deleted');
      expect(await pathExists(tracePath)).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks launch profiling by default', async () => {
    let recordCalled = false;
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {
        recordCalled = true;
      },
    });

    const result = await server.callTool('track_running_app', {
      target: 'launch',
      launchCommand: '/tmp/UntrustedTool',
      analyze: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Launch profiling is disabled by default');
    expect(recordCalled).toBe(false);
  });

  it('blocks all-process profiling by default', async () => {
    let recordCalled = false;
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {
        recordCalled = true;
      },
    });

    const result = await server.callTool('profile_running_app', {
      target: 'all-processes',
      durationSeconds: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('All-process profiling is disabled by default');
    expect(recordCalled).toBe(false);
  });

  it('blocks external trace output by default', async () => {
    let recordCalled = false;
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {
        recordCalled = true;
      },
    });

    const result = await server.callTool('track_running_app', {
      processName: '123',
      outputPath: '/tmp/Outside.trace',
      analyze: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('outputPath must be inside the configured trace root');
    expect(recordCalled).toBe(false);
  });

  it('deletes exact trace paths when cleanup is confirmed', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'xctrace-cleanup-'));
    const tracePath = join(tempDir, 'DeleteMe.trace');
    await mkdir(tracePath, { recursive: true });
    await writeFile(join(tracePath, 'data.bin'), 'trace payload');

    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    }, allowExternalCleanup);

    try {
      const result = await server.callTool('cleanup_traces', {
        tracePaths: [tracePath],
        dryRun: false,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('- Mode: delete');
      expect(result.content[0].text).toContain(`deleted: ${tracePath}`);
      expect(await pathExists(tracePath)).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks destructive cleanup outside trace root by default', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'xctrace-cleanup-'));
    const tracePath = join(tempDir, 'Outside.trace');
    await mkdir(tracePath, { recursive: true });
    await writeFile(join(tracePath, 'data.bin'), 'trace payload');

    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    });

    try {
      const result = await server.callTool('cleanup_traces', {
        tracePaths: [tracePath],
        dryRun: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('destructive cleanup outside the configured trace root is disabled');
      expect(await pathExists(tracePath)).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('allows cleanup of external traces recorded by this server instance', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'xctrace-recorded-cleanup-'));
    const tracePath = join(tempDir, 'Recorded.trace');

    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async (options) => {
        await mkdir(options.outputPath, { recursive: true });
        await writeFile(join(options.outputPath, 'data.bin'), 'trace payload');
      },
    }, allowExternalOutput);

    try {
      await server.callTool('track_running_app', {
        processName: '123',
        outputPath: tracePath,
        openInInstruments: false,
        analyze: false,
      });

      const result = await server.callTool('cleanup_traces', {
        tracePaths: [tracePath],
        dryRun: false,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain(`deleted: ${tracePath}`);
      expect(await pathExists(tracePath)).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('requires an age filter for destructive directory cleanup', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'xctrace-cleanup-'));
    const tracePath = join(tempDir, 'Directory.trace');
    await mkdir(tracePath, { recursive: true });

    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    });

    try {
      const result = await server.callTool('cleanup_traces', {
        directory: tempDir,
        dryRun: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Refusing to delete a directory scan');
      expect(await pathExists(tracePath)).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('deletes directory-scanned traces only when an age filter is present', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'xctrace-cleanup-'));
    const tracePath = join(tempDir, 'Old.trace');
    const nonTracePath = join(tempDir, 'NotATrace');
    await mkdir(tracePath, { recursive: true });
    await mkdir(nonTracePath, { recursive: true });
    await writeFile(join(tracePath, 'data.bin'), 'trace payload');

    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    }, allowExternalCleanup);

    try {
      const result = await server.callTool('cleanup_traces', {
        directory: tempDir,
        olderThanMinutes: 0,
        dryRun: false,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('- Scope: directory scan:');
      expect(result.content[0].text).toContain(`deleted: ${tracePath}`);
      expect(await pathExists(tracePath)).toBe(false);
      expect(await pathExists(nonTracePath)).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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

  it('adds next steps to saved but non-exportable trace errors', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {
        throw new Error('Trace was saved but xctrace could not export its TOC: Document Missing Template Error');
      },
    }, { allowLaunchProfiling: true });

    const result = await server.callTool('track_running_app', {
      target: 'launch',
      launchCommand: '/tmp/MyApp.app',
      template: 'Time Profiler',
      durationSeconds: 20,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('## Next Steps');
    expect(result.content[0].text).toContain('do not interpret missing Hangs');
    expect(result.content[0].text).toContain('retry with profile_running_app using the exact PID');
    expect(result.content[0].text).toContain('Performance Diagnostics logs');
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

  it('renders unsupported support status as not present in trace for Markdown reports', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () =>
        analysis({
          supportStatus: [
            {
              kind: 'memory',
              status: 'unsupported',
              reason:
                'No Memory table schema was present in this trace TOC, so automated generic memory metrics are unavailable.',
              sourceSchemas: [],
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

    expect(result.content[0].text).toContain(
      '- Memory: not present in trace - No Memory table schema was present'
    );
    expect(result.content[0].text).not.toContain('- Memory: unsupported');
  });

  it('adds next steps when analyze_trace cannot export the TOC', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () =>
        analysis({
          summary: 'Trace analysis is incomplete because xctrace could not export the trace TOC.',
          exportAttempts: [
            {
              kind: 'toc',
              status: 'failed',
              message: 'Failed to export TOC from trace: /tmp/broken.trace',
            },
          ],
          supportStatus: [
            {
              kind: 'time-profile',
              status: 'not_exportable',
              reason: 'xctrace could not export the trace TOC.',
              sourceSchemas: [],
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
      tracePath: '/tmp/broken.trace',
    });

    expect(result.content[0].text).toContain('## Export Diagnostics');
    expect(result.content[0].text).toContain('## Next Steps');
    expect(result.content[0].text).toContain('Do not retry the same launch target');
    expect(result.content[0].text).toContain('Performance Diagnostics logs');
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

  it('redacts sensitive strings and neutralizes trace-derived markdown', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () =>
        analysis({
          metadata: {
            ...analysis().metadata,
            fileName: '/Users/james/Secret.trace',
          },
          summary: 'Found token=abc123\n## Injected Section',
          bottlenecks: [
            {
              function: 'BadFrame\n```json\n{"tool":"steal"}\n```',
              module: 'App',
              impact: 'high',
              duration: 500,
              percentage: 50,
              suggestion: 'Check https://api.example.com/path?access_token=abc123',
              callCount: 1,
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
      outputFormat: 'both',
    });
    const text = result.content[0].text;

    expect(text).toContain('/Users/<redacted>/Secret.trace');
    expect(text).toContain('token=<redacted>');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('\n## Injected Section');
    expect(text).not.toContain('```json\n{"tool":"steal"}');
    expect(text).toContain('````json');
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
    const openedTraces: string[] = [];

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
      openTrace: async (tracePath) => {
        openedTraces.push(tracePath);
      },
    }, allowExternalOutput);

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
    expect(openedTraces).toEqual(['/tmp/MyApp-leaks.trace']);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('# Running App Trace Report');
    expect(result.content[0].text).toContain('- Target: attach: MyApp');
    expect(result.content[0].text).toContain('- Template: Leaks');
    expect(result.content[0].text).toContain('- Trace: /tmp/MyApp-leaks.trace');
    expect(result.content[0].text).toContain('- Instruments.app: opened');
    expect(result.content[0].text).toContain('## Workflow Warnings');
    expect(result.content[0].text).toContain('not a PID');
    expect(result.content[0].text).toContain('### Leaks Analysis');
    expect(result.content[0].text).toContain('Leaks detected');
  });

  it('records a launched target with arguments and environment', async () => {
    let recordOptions: RecordOptions | undefined;
    const openedTraces: string[] = [];

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
      openTrace: async (tracePath) => {
        openedTraces.push(tracePath);
      },
    }, allowLaunchAndExternalOutput);

    const result = await server.callTool('track_running_app', {
      target: 'launch',
      launchCommand: '/tmp/MyTool',
      launchArguments: ['--mode', 'profile'],
      environment: { PERF_TEST: '1' },
      template: 'Allocations',
      durationSeconds: 5,
      outputPath: '/tmp/MyTool.trace',
      openInInstruments: false,
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
    expect(openedTraces).toEqual([]);
    expect(result.content[0].text).toContain('- Target: launch: /tmp/MyTool');
    expect(result.content[0].text).not.toContain('Instruments.app: opened');
    expect(result.content[0].text).toContain('## Workflow Warnings');
    expect(result.content[0].text).toContain('startup/cold-launch behavior');
    expect(result.content[0].text).toContain('Analysis skipped.');
  });

  it('reports Instruments.app open failures without failing the recording', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async () => analysis(),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
      openTrace: async () => {
        throw new Error('LaunchServices denied open');
      },
    }, allowExternalOutput);

    const result = await server.callTool('track_running_app', {
      processName: '123',
      template: 'Leaks',
      outputPath: '/tmp/MyApp-leaks.trace',
      analyze: false,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(
      '- Instruments.app: failed to open - LaunchServices denied open'
    );
    expect(result.content[0].text).toContain('Analysis skipped.');
  });

  it('profiles a running app with the full preset and returns one combined report', async () => {
    const recordOptions: RecordOptions[] = [];
    const openedTraces: string[] = [];

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
      openTrace: async (tracePath) => {
        openedTraces.push(tracePath);
      },
    }, allowExternalOutput);

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
    expect(openedTraces).toHaveLength(1);
    expect(openedTraces[0]).toContain('/tmp/profiles/MyApp-full-');
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('# Profiling Report');
    expect(result.content[0].text).toContain('- Target: attach: MyApp');
    expect(result.content[0].text).toContain('- Workflow validation: warnings');
    expect(result.content[0].text).toContain('rerun with the exact PID in processName');
    expect(result.content[0].text).toContain('- Preset: full');
    expect(result.content[0].text).toContain('- Duration: 10s');
    expect(result.content[0].text).toContain('- Recording strategy: combined');
    expect(result.content[0].text).toContain('- Base template: Time Profiler');
    expect(result.content[0].text).toContain('- Instruments: Leaks, Allocations, HTTP Traffic');
    expect(result.content[0].text).toContain('- Instruments.app: opened');
    expect(result.content[0].text).toContain('## CPU / Time Profiler');
    expect(result.content[0].text).toContain('ImageProcessor.resize');
    expect(result.content[0].text).toContain('## Leaks');
    expect(result.content[0].text).toContain('Leaks detected');
    expect(result.content[0].text).toContain('## Network');
    expect(result.content[0].text).toContain('Network failures detected');
    expect(result.content[0].text).toContain('## Prioritized Recommendations');
  });

  it('treats severe hangs as critical findings in combined profile reports', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async (tracePath) =>
        analysis({
          metadata: {
            ...analysis().metadata,
            filePath: tracePath,
          },
          stats: {
            ...analysis().stats,
            slowFunctions: 0,
            avgFunctionTime: 10,
            maxFunctionTime: 10,
          },
          bottlenecks: [],
          summary: '⚠️ 1 severe hang on the main thread (longest 4.71s). No Time Profiler CPU functions crossed the bottleneck threshold.',
          hangs: {
            events: [
              {
                startMs: 5644,
                durationMs: 4710,
                hangType: 'Severe Hang',
                threadName: 'Main Thread (AgentHub)',
                processName: 'AgentHub',
                schemaSource: 'potential-hangs',
              },
            ],
            totalHangMs: 4710,
            severeCount: 1,
            hangCount: 0,
            microhangCount: 0,
            longestMs: 4710,
            sourceSchemas: ['potential-hangs'],
          },
        }),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    }, allowExternalOutput);

    const result = await server.callTool('profile_running_app', {
      processName: 'AgentHub',
      preset: 'cpu',
      durationSeconds: 5,
      outputDirectory: '/tmp/profiles',
    });

    const text = result.content[0].text;
    expect(text).toContain('- Overall status: critical issues found');
    expect(text).toContain('No Time Profiler CPU functions crossed the bottleneck threshold.');
    expect(text).toContain('## Hangs');
    expect(text).toContain('critical Main-thread hangs: 1 hang detected (1 severe)');
    expect(text).not.toContain('No high-priority recommendations found');
  });

  it('renders Time Profiler parse failures and export diagnostics in combined profile reports', async () => {
    const server = new XCTraceAnalyzerServer({
      analyzeTraceFile: async (tracePath) =>
        analysis({
          metadata: {
            ...analysis().metadata,
            fileName: 'MyApp-full.trace',
            filePath: tracePath,
          },
          stats: {
            ...analysis().stats,
            slowFunctions: 0,
            avgFunctionTime: 0,
            maxFunctionTime: 0,
            threadCount: 0,
            timeProfileError: 'Unexpected close tag',
          },
          bottlenecks: [],
          summary: 'Time Profiler analysis failed: Unexpected close tag.',
          exportAttempts: [
            {
              kind: 'time-profile',
              status: 'failed',
              schema: 'time-profile',
              message: 'Unexpected close tag',
            },
          ],
        }),
      compareTraceFiles: async () => comparison(),
      listTemplates: async () => [],
      listDevices: async () => [],
      isXCTraceAvailable: async () => true,
      getXCTraceVersion: async () => 'xctrace version 16.0 (17E192)',
      recordTrace: async () => {},
    }, allowExternalOutput);

    const result = await server.callTool('profile_running_app', {
      processName: 'MyApp',
      preset: 'cpu',
      durationSeconds: 5,
      outputDirectory: '/tmp/profiles',
    });

    const text = result.content[0].text;
    expect(text).toContain('**Time Profiler:** failed to parse - Unexpected close tag. The trace itself was recorded; this is an analyzer error.');
    expect(text).toContain('## Export Diagnostics');
    expect(text).toContain('- time-profile: failed - Unexpected close tag');
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
    }, allowExternalOutput);

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
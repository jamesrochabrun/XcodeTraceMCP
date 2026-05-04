import { describe, expect, it } from 'vitest';
import {
  buildRecordTraceArgs,
  buildSymbolicateTraceArgs,
} from '../src/utils/xctrace-runner.js';

describe('xctrace runner', () => {
  it('builds an attach recording command for a running app', () => {
    expect(
      buildRecordTraceArgs({
        template: 'Leaks',
        processName: 'MyApp',
        duration: 60,
        outputPath: '/tmp/MyApp.trace',
        device: 'iPhone 16 Pro Simulator',
      })
    ).toEqual([
      'xctrace',
      'record',
      '--template',
      'Leaks',
      '--attach',
      'MyApp',
      '--device',
      'iPhone 16 Pro Simulator',
      '--time-limit',
      '60s',
      '--output',
      '/tmp/MyApp.trace',
      '--no-prompt',
    ]);
  });

  it('builds a combined recording command with additional instruments', () => {
    expect(
      buildRecordTraceArgs({
        template: 'Time Profiler',
        instruments: ['Allocations', 'HTTP Traffic'],
        processName: 'MyApp',
        duration: 60,
        outputPath: '/tmp/MyApp-full.trace',
      })
    ).toEqual([
      'xctrace',
      'record',
      '--template',
      'Time Profiler',
      '--instrument',
      'Allocations',
      '--instrument',
      'HTTP Traffic',
      '--attach',
      'MyApp',
      '--time-limit',
      '60s',
      '--output',
      '/tmp/MyApp-full.trace',
      '--no-prompt',
    ]);
  });

  it('places launch target after all xctrace options', () => {
    expect(
      buildRecordTraceArgs({
        template: 'Time Profiler',
        instruments: ['Allocations'],
        appIdentifier: 'com.example.MyApp',
        duration: 30,
        outputPath: '/tmp/MyApp-launch.trace',
        device: 'iPhone 16 Pro Simulator',
      })
    ).toEqual([
      'xctrace',
      'record',
      '--template',
      'Time Profiler',
      '--instrument',
      'Allocations',
      '--device',
      'iPhone 16 Pro Simulator',
      '--time-limit',
      '30s',
      '--output',
      '/tmp/MyApp-launch.trace',
      '--no-prompt',
      '--launch',
      '--',
      'com.example.MyApp',
    ]);
  });

  it('builds launch recording commands with arguments, env, and stream redirection', () => {
    expect(
      buildRecordTraceArgs({
        template: 'Allocations',
        launchCommand: '/tmp/My Tool.app',
        launchArguments: ['--scenario', 'cold-start'],
        environment: { PERF_MODE: '1' },
        targetStdout: '-',
        duration: 5,
        outputPath: '/tmp/launch.trace',
      })
    ).toEqual([
      'xctrace',
      'record',
      '--template',
      'Allocations',
      '--time-limit',
      '5s',
      '--output',
      '/tmp/launch.trace',
      '--no-prompt',
      '--target-stdout',
      '-',
      '--env',
      'PERF_MODE=1',
      '--launch',
      '--',
      '/tmp/My Tool.app',
      '--scenario',
      'cold-start',
    ]);
  });

  it('rejects ambiguous recording targets', () => {
    expect(() =>
      buildRecordTraceArgs({
        template: 'Time Profiler',
        processName: 'MyApp',
        allProcesses: true,
        outputPath: '/tmp/ambiguous.trace',
      })
    ).toThrow('Recording target is ambiguous');
  });

  it('builds symbolication commands without mutating the input by default when output is provided', () => {
    expect(
      buildSymbolicateTraceArgs({
        inputPath: '/tmp/app.trace',
        outputPath: '/tmp/app-symbolicated.trace',
        dsymPath: '/tmp/App.dSYM',
      })
    ).toEqual([
      'xctrace',
      'symbolicate',
      '--input',
      '/tmp/app.trace',
      '--output',
      '/tmp/app-symbolicated.trace',
      '--dsym',
      '/tmp/App.dSYM',
    ]);
  });
});

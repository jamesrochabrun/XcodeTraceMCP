import { describe, expect, it } from 'vitest';
import { buildRecordTraceArgs } from '../src/utils/xctrace-runner.js';

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
});

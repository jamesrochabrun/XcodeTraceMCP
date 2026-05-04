import { describe, expect, it } from 'vitest';
import { TraceParser } from '../src/parser/trace-parser.js';

describe('TraceParser', () => {
  it('parses time profiler XML using injected xctrace exporters', async () => {
    const parser = new TraceParser({
      exportTOC: async () => `
        <trace-toc>
          <run number="1">
            <duration>1.5s</duration>
          </run>
        </trace-toc>
      `,
      exportTable: async (_tracePath, schema) => {
        expect(schema).toBe('time-profile');
        return `
          <table>
            <row time="100" thread="7" weight="40">
              <backtrace>
                <frame name="App\`RootView.body"/>
                <frame name="App\`ImageProcessor.resize"/>
              </backtrace>
            </row>
            <row time="150" thread="7" weight="15">
              <backtrace>
                <frame name="App\`RootView.body"/>
                <frame name="App\`JSONDecoder.decode"/>
              </backtrace>
            </row>
          </table>
        `;
      },
    });

    const trace = await parser.parseTrace('packages/core/package.json');

    expect(trace.metadata.fileName).toBe('package.json');
    expect(trace.metadata.duration).toBe(1500);
    expect(trace.timeProfile?.totalDuration).toBe(150);
    expect(trace.timeProfile?.samples).toHaveLength(2);
    expect(trace.timeProfile?.functionProfiles).toEqual([
      expect.objectContaining({
        name: 'RootView.body',
        module: 'App',
        totalTime: 55,
        selfTime: 0,
        callCount: 2,
      }),
      expect.objectContaining({
        name: 'ImageProcessor.resize',
        module: 'App',
        totalTime: 40,
        selfTime: 40,
        callCount: 1,
      }),
      expect.objectContaining({
        name: 'JSONDecoder.decode',
        module: 'App',
        totalTime: 15,
        selfTime: 15,
        callCount: 1,
      }),
    ]);
  });

  it('parses xctrace trace-query-result Time Profiler rows', async () => {
    const parser = new TraceParser({
      exportTOC: async () => `
        <trace-toc>
          <run number="1">
            <duration>2s</duration>
            <data>
              <table schema="time-profile"/>
            </data>
          </run>
        </trace-toc>
      `,
      exportTable: async (_tracePath, schema) => {
        expect(schema).toBe('time-profile');
        return `
          <trace-query-result>
            <node xpath="//trace-toc[1]/run[1]/data[1]/table[1]">
              <row>
                <sample-time fmt="00:00.624.305">624305083</sample-time>
                <thread fmt="AgentHub (0x1345614) (AgentHub, pid: 39144)">
                  <tid fmt="0x1345614">20207124</tid>
                </thread>
                <weight fmt="2.00 ms">2000000</weight>
                <tagged-backtrace fmt="App.main ← (1 other frames)">
                  <backtrace>
                    <frame name="App.main"/>
                    <frame ref="42"/>
                    <frame name="HotRenderer.draw"/>
                  </backtrace>
                </tagged-backtrace>
              </row>
            </node>
          </trace-query-result>
        `;
      },
    });

    const trace = await parser.parseTrace('packages/core/package.json');

    expect(trace.timeProfile?.samples).toHaveLength(1);
    expect(trace.timeProfile?.totalDuration).toBeCloseTo(624.305, 3);
    expect(trace.timeProfile?.functionProfiles).toEqual([
      expect.objectContaining({
        name: 'App.main',
        totalTime: 2,
        selfTime: 0,
      }),
      expect.objectContaining({
        name: 'HotRenderer.draw',
        totalTime: 2,
        selfTime: 2,
      }),
    ]);
  });
});

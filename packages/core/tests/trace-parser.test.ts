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

  it('marks analysis families not_exportable when the trace TOC cannot be exported', async () => {
    const parser = new TraceParser({
      exportTOC: async () => {
        throw new Error('Document Missing Template Error');
      },
      exportTable: async () => {
        throw new Error('Document Missing Template Error');
      },
    });

    const trace = await parser.parseTrace('packages/core/package.json');

    expect(trace.exportAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'toc',
          status: 'failed',
          message: 'Document Missing Template Error',
        }),
      ])
    );
    expect(trace.supportStatus?.map((status) => status.status)).toEqual([
      'not_exportable',
      'not_exportable',
      'not_exportable',
      'not_exportable',
      'not_exportable',
      'not_exportable',
    ]);
    expect(trace.supportStatus?.[0]).toEqual(
      expect.objectContaining({
        kind: 'time-profile',
        reason: expect.stringContaining('could not export the trace TOC'),
      })
    );
  });

  it('marks an instrument family partial when some matching schemas export and others fail', async () => {
    const parser = new TraceParser({
      exportTOC: async () => `
        <trace-toc>
          <run number="1">
            <duration>2s</duration>
            <data>
              <table schema="memory-statistics"/>
              <table schema="memory-vm-regions"/>
            </data>
          </run>
        </trace-toc>
      `,
      exportTable: async (_tracePath, schema) => {
        if (schema === 'memory-statistics') {
          return `
            <table>
              <row>
                <column name="Peak Memory" value="734003200"/>
              </row>
            </table>
          `;
        }
        throw new Error('memory-vm-regions export failed');
      },
    });

    const trace = await parser.parseTrace('packages/core/package.json');
    const memoryStatus = trace.supportStatus?.find((status) => status.kind === 'memory');
    const memoryAnalysis = trace.instrumentAnalyses?.find((analysis) => analysis.kind === 'memory');

    expect(memoryStatus).toEqual(
      expect.objectContaining({
        status: 'partial',
        reason: expect.stringContaining('some schemas failed'),
      })
    );
    expect(memoryAnalysis?.supportStatus).toBe('partial');
    expect(memoryAnalysis?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Peak Memory', numericValue: 734003200 }),
      ])
    );
    expect(memoryAnalysis?.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'No exportable Memory rows' }),
      ])
    );
    expect(trace.exportAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'memory', status: 'success', schema: 'memory-statistics' }),
        expect.objectContaining({ kind: 'memory', status: 'failed', schema: 'memory-vm-regions' }),
      ])
    );
  });

  it('marks exposed schemas not_exportable when no matching exports succeed', async () => {
    const parser = new TraceParser({
      exportTOC: async () => `
        <trace-toc>
          <run number="1">
            <duration>2s</duration>
            <data>
              <table schema="leaks-summary"/>
            </data>
          </run>
        </trace-toc>
      `,
      exportTable: async (_tracePath, schema) => {
        if (schema === 'leaks-summary') {
          throw new Error('leaks export failed');
        }
        return '';
      },
    });

    const trace = await parser.parseTrace('packages/core/package.json');
    const leaksStatus = trace.supportStatus?.find((status) => status.kind === 'leaks');
    const networkStatus = trace.supportStatus?.find((status) => status.kind === 'network');

    expect(leaksStatus).toEqual(
      expect.objectContaining({
        status: 'not_exportable',
        reason: expect.stringContaining('leaks export failed'),
      })
    );
    expect(networkStatus).toEqual(
      expect.objectContaining({
        status: 'unsupported',
        reason: expect.stringContaining('No Network table schema was present in this trace TOC'),
      })
    );
  });

  it('marks GUI-only instrument tracks not_exportable when xctrace exposes no table schema', async () => {
    const parser = new TraceParser({
      exportTOC: async () => `
        <trace-toc>
          <run number="1">
            <duration>2s</duration>
            <data>
              <table schema="time-profile"/>
            </data>
            <instruments>
              <instrument name="Leaks"/>
              <instrument name="Allocations"/>
            </instruments>
            <tracks>
              <track name="Leaks">
                <detail kind="table" name="Leaks"/>
              </track>
              <track name="Allocations">
                <detail kind="table" name="Allocations List"/>
              </track>
            </tracks>
          </run>
        </trace-toc>
      `,
      exportTable: async () => '',
    });

    const trace = await parser.parseTrace('packages/core/package.json');
    const leaksStatus = trace.supportStatus?.find((status) => status.kind === 'leaks');
    const allocationsStatus = trace.supportStatus?.find((status) => status.kind === 'allocations');

    expect(leaksStatus).toEqual(
      expect.objectContaining({
        status: 'not_exportable',
        reason: expect.stringContaining('visible in Instruments.app'),
        sourceSchemas: [],
        sourceTracks: ['Leaks'],
      })
    );
    expect(allocationsStatus).toEqual(
      expect.objectContaining({
        status: 'not_exportable',
        reason: expect.stringContaining('xcrun did not expose an exportable allocations table schema'),
        sourceSchemas: [],
        sourceTracks: ['Allocations', 'Allocations List'],
      })
    );
  });

  it('marks Time Profiler not_exportable when parsing fails', async () => {
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
      exportTable: async () => {
        throw new Error('invalid time-profile XML');
      },
    });

    const trace = await parser.parseTrace('packages/core/package.json');

    expect(trace.timeProfile).toBeUndefined();
    expect(trace.supportStatus?.find((status) => status.kind === 'time-profile')).toEqual(
      expect.objectContaining({
        status: 'not_exportable',
        reason: expect.stringContaining('invalid time-profile XML'),
      })
    );
  });

  it('extracts user process names from attached and non-system TOC processes', async () => {
    const parser = new TraceParser({
      exportTOC: async () => `
        <trace-toc>
          <run number="1">
            <target type="attached">
              <process name="AgentHub" path="/Applications/AgentHub.app/Contents/MacOS/AgentHub"/>
            </target>
            <target type="launched">
              <process name="HelperTool" path="/Users/me/Build/HelperTool"/>
              <process name="libsystem_kernel.dylib" path="/usr/lib/system/libsystem_kernel.dylib"/>
            </target>
            <data>
              <table schema="time-profile"/>
            </data>
          </run>
        </trace-toc>
      `,
      exportTable: async () => '',
    });

    const trace = await parser.parseTrace('packages/core/package.json');

    expect(trace.metadata.userProcessNames).toEqual(['AgentHub', 'HelperTool']);
  });

  it('scopes Time Profiler samples and hang events to a requested time range', async () => {
    const parser = new TraceParser({
      exportTOC: async () => `
        <trace-toc>
          <run number="1">
            <duration>2s</duration>
            <data>
              <table schema="time-profile"/>
              <table schema="potential-hangs"/>
            </data>
          </run>
        </trace-toc>
      `,
      exportTable: async (_tracePath, schema) => {
        if (schema === 'time-profile') {
          return `
            <table>
              <row time="100" thread="7" weight="10">
                <backtrace><frame name="App\`BeforeWindow"/></backtrace>
              </row>
              <row time="300" thread="7" weight="40">
                <backtrace><frame name="App\`ScopedWork"/></backtrace>
              </row>
              <row time="900" thread="7" weight="20">
                <backtrace><frame name="App\`AfterWindow"/></backtrace>
              </row>
            </table>
          `;
        }
        if (schema === 'potential-hangs') {
          return `
            <table>
              <row>
                <start-time fmt="00:00.150">150000000</start-time>
                <duration fmt="200 ms">200000000</duration>
                <hang-type>Hang</hang-type>
                <thread fmt="Main Thread (App)">
                  <tid>7</tid>
                  <process fmt="App (123)"><pid>123</pid></process>
                </thread>
                <process fmt="App (123)"><pid>123</pid></process>
              </row>
              <row>
                <start-time fmt="00:00.900">900000000</start-time>
                <duration fmt="100 ms">100000000</duration>
                <hang-type>Microhang</hang-type>
                <thread fmt="Main Thread (App)">
                  <tid>7</tid>
                  <process fmt="App (123)"><pid>123</pid></process>
                </thread>
                <process fmt="App (123)"><pid>123</pid></process>
              </row>
            </table>
          `;
        }
        return '';
      },
    });

    const trace = await parser.parseTrace('packages/core/package.json', {
      timeRangeMs: { startMs: 200, endMs: 700 },
    });

    expect(trace.timeProfile?.samples.map((sample) => sample.timestamp)).toEqual([300]);
    expect(trace.timeProfile?.totalDuration).toBe(500);
    expect(trace.timeProfile?.functionProfiles).toEqual([
      expect.objectContaining({
        name: 'ScopedWork',
        module: 'App',
        totalTime: 40,
        selfTime: 40,
      }),
    ]);
    expect(trace.hangs?.events).toHaveLength(1);
    expect(trace.hangs?.events[0]).toEqual(
      expect.objectContaining({
        startMs: 150,
        durationMs: 200,
        hangType: 'Hang',
      })
    );
  });

  it('escapes TOC-derived XPath literals before exporting tables', async () => {
    let capturedXPath: string | undefined;
    const parser = new TraceParser({
      exportTOC: async () => `
        <trace-toc>
          <run number="1">
            <duration>1s</duration>
            <data>
              <table schema='memory-"odd-schema'/>
            </data>
          </run>
        </trace-toc>
      `,
      exportTable: async () => '',
      exportXPath: async (_tracePath, xpath) => {
        capturedXPath = xpath;
        return `
          <table>
            <row>
              <column name="Peak Memory" value="1024"/>
            </row>
          </table>
        `;
      },
    });

    const trace = await parser.parseTrace('packages/core/package.json');

    expect(capturedXPath).toContain('table[@schema=\'memory-"odd-schema\']');
    expect(trace.instrumentAnalyses?.find((analysis) => analysis.kind === 'memory')?.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Peak Memory', numericValue: 1024 })])
    );
  });

  it('does not expand DOCTYPE entities from exported XML', async () => {
    const parser = new TraceParser({
      exportTOC: async () => `
        <trace-toc>
          <run number="1">
            <duration>1s</duration>
            <data>
              <table schema="time-profile"/>
            </data>
          </run>
        </trace-toc>
      `,
      exportTable: async () => `
        <!DOCTYPE table [<!ENTITY boom "ExpandedSecret">]>
        <table>
          <row time="100" thread="7" weight="1">
            <backtrace>
              <frame name="App\`&boom;"/>
            </backtrace>
          </row>
        </table>
      `,
    });

    const trace = await parser.parseTrace('packages/core/package.json');

    expect(trace.timeProfile?.functionProfiles.map((profile) => profile.name)).not.toContain('ExpandedSecret');
  });

  it('fails safely when XML id/ref relationships are cyclic', async () => {
    const parser = new TraceParser({
      exportTOC: async () => `
        <trace-toc>
          <run number="1">
            <duration>1s</duration>
            <data>
              <table schema="potential-hangs"/>
            </data>
          </run>
        </trace-toc>
      `,
      exportTable: async () => `
        <table>
          <row>
            <start-time>100000000</start-time>
            <duration>100000000</duration>
            <hang-type>Hang</hang-type>
            <thread id="1" fmt="Main Thread"><process ref="1"/></thread>
          </row>
        </table>
      `,
    });

    const trace = await parser.parseTrace('packages/core/package.json');

    expect(trace.hangs).toBeUndefined();
    expect(trace.exportAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'hangs',
          status: 'failed',
          message: expect.stringContaining('Cyclic XML id/ref'),
        }),
      ])
    );
  });
});

import { describe, expect, it } from 'vitest';
import { analyzeTrace } from '../src/analyzer/performance-analyzer.js';
import { generateRecommendations } from '../src/analyzer/recommendation-engine.js';
import { TraceParser } from '../src/parser/trace-parser.js';

const tocXML = `
  <trace-toc>
    <run number="1">
      <duration>2s</duration>
      <data>
        <table schema="memory-statistics"/>
        <table schema="allocations-summary"/>
        <table schema="leaks-summary"/>
        <table schema="network-connections"/>
        <table schema="energy-log"/>
      </data>
    </run>
  </trace-toc>
`;

const tables: Record<string, string> = {
  'memory-statistics': `
    <table schema="memory-statistics">
      <row>
        <column name="Peak Memory" value="734003200"/>
        <column name="Resident Memory" value="650117120"/>
        <column name="Dirty Memory" value="209715200"/>
      </row>
    </table>
  `,
  'allocations-summary': `
    <table schema="allocations-summary">
      <row>
        <column name="Total Allocations" value="4200"/>
        <column name="Total Bytes" value="125829120"/>
        <column name="Type" value="UIImage2x"/>
      </row>
      <row>
        <column name="Type" value="UIImage"/>
        <column name="Bytes" value="94371840"/>
        <column name="Count" value="120"/>
      </row>
    </table>
  `,
  'leaks-summary': `
    <table schema="leaks-summary">
      <row>
        <column name="Leaked Bytes" value="1048576"/>
        <column name="Leaks" value="3"/>
        <column name="Call Site" value="ImageCache2.retainCycle"/>
      </row>
    </table>
  `,
  'network-connections': `
    <table schema="network-connections">
      <row>
        <column name="URL" value="https://api.example.com/v1/feed"/>
        <column name="Status" value="200"/>
        <column name="Bytes In" value="2048"/>
        <column name="Bytes Out" value="512"/>
      </row>
      <row>
        <column name="URL" value="https://api.example.com/v1/sync"/>
        <column name="Status" value="500"/>
        <column name="Bytes In" value="1024"/>
        <column name="Bytes Out" value="512"/>
      </row>
    </table>
  `,
  'energy-log': `
    <table schema="energy-log">
      <row>
        <column name="Energy Impact" value="82"/>
        <column name="Wakeups" value="170"/>
        <column name="CPU Time" value="55"/>
      </row>
    </table>
  `,
};

const wrapXPathResult = (tableXML: string) => {
  const rows = tableXML
    .trim()
    .replace(/^<table\b[^>]*>/, '')
    .replace(/<\/table>$/, '');

  return `
    <trace-query-result>
      <node xpath="//trace-toc[1]/run[1]/data[1]/table[1]">
        ${rows}
      </node>
    </trace-query-result>
  `;
};

describe('TraceParser multi-instrument support', () => {
  it('discovers and parses Memory, Allocations, Leaks, Network, and Energy tables', async () => {
    const parser = new TraceParser({
      exportTOC: async () => tocXML,
      exportTable: async (_tracePath, schema) => {
        if (schema === 'time-profile') {
          return '';
        }
        return tables[schema] ?? '';
      },
    });

    const trace = await parser.parseTrace('packages/core/package.json');

    expect(trace.instrumentAnalyses?.map((analysis) => analysis.kind)).toEqual([
      'memory',
      'network',
      'energy',
      'allocations',
      'leaks',
    ]);
    expect(trace.supportStatus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'memory', status: 'supported' }),
        expect.objectContaining({ kind: 'network', status: 'supported' }),
      ])
    );
    expect(trace.exportAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'toc', status: 'success' }),
        expect.objectContaining({ kind: 'memory', status: 'success', schema: 'memory-statistics' }),
      ])
    );

    expect(trace.instrumentAnalyses).toContainEqual(
      expect.objectContaining({
        kind: 'memory',
        title: 'Memory Analysis',
        metrics: expect.arrayContaining([
          expect.objectContaining({ name: 'Peak Memory', numericValue: 734003200 }),
        ]),
        findings: expect.arrayContaining([
          expect.objectContaining({ title: 'High peak memory usage' }),
        ]),
      })
    );

    expect(trace.instrumentAnalyses).toContainEqual(
      expect.objectContaining({
        kind: 'network',
        metrics: expect.arrayContaining([
          expect.objectContaining({ name: 'Requests', numericValue: 2 }),
          expect.objectContaining({ name: 'Failed Requests', numericValue: 1 }),
          expect.objectContaining({ name: 'Top Host', value: 'api.example.com (2 requests)' }),
        ]),
      })
    );

    expect(trace.instrumentAnalyses).toContainEqual(
      expect.objectContaining({
        kind: 'allocations',
        metrics: expect.arrayContaining([
          expect.objectContaining({
            name: 'Top Allocation Site',
            value: 'UIImage2x (120.0 MB)',
          }),
        ]),
      })
    );

    expect(trace.instrumentAnalyses).toContainEqual(
      expect.objectContaining({
        kind: 'leaks',
        metrics: expect.arrayContaining([
          expect.objectContaining({
            name: 'Top Leak Site',
            value: 'ImageCache2.retainCycle (1.0 MB)',
          }),
        ]),
        findings: expect.arrayContaining([
          expect.objectContaining({ title: 'Leaks detected' }),
        ]),
      })
    );
  });

  it('parses wrapped XPath exports for instrument tables', async () => {
    const parser = new TraceParser({
      exportTOC: async () => tocXML,
      exportTable: async (_tracePath, schema) => {
        if (schema === 'time-profile') {
          return '';
        }
        return tables[schema] ? wrapXPathResult(tables[schema]) : '';
      },
    });

    const trace = await parser.parseTrace('packages/core/package.json');

    expect(trace.instrumentAnalyses?.map((analysis) => analysis.kind)).toEqual([
      'memory',
      'network',
      'energy',
      'allocations',
      'leaks',
    ]);
    expect(trace.instrumentAnalyses).toContainEqual(
      expect.objectContaining({
        kind: 'memory',
        metrics: expect.arrayContaining([
          expect.objectContaining({ name: 'Peak Memory', numericValue: 734003200 }),
        ]),
      })
    );
    expect(trace.instrumentAnalyses).toContainEqual(
      expect.objectContaining({
        kind: 'network',
        metrics: expect.arrayContaining([
          expect.objectContaining({ name: 'Top Host', value: 'api.example.com (2 requests)' }),
        ]),
      })
    );
    expect(trace.instrumentAnalyses).toContainEqual(
      expect.objectContaining({
        kind: 'allocations',
        metrics: expect.arrayContaining([
          expect.objectContaining({
            name: 'Top Allocation Site',
            value: 'UIImage2x (120.0 MB)',
          }),
        ]),
      })
    );
    expect(trace.instrumentAnalyses).toContainEqual(
      expect.objectContaining({
        kind: 'leaks',
        metrics: expect.arrayContaining([
          expect.objectContaining({
            name: 'Top Leak Site',
            value: 'ImageCache2.retainCycle (1.0 MB)',
          }),
        ]),
      })
    );
    expect(trace.instrumentAnalyses).toContainEqual(
      expect.objectContaining({
        kind: 'energy',
        metrics: expect.arrayContaining([
          expect.objectContaining({ name: 'Energy Impact', numericValue: 82 }),
        ]),
      })
    );
  });

  it('prefers HAR data for Network analysis when xctrace can export it', async () => {
    const parser = new TraceParser({
      exportTOC: async () => tocXML,
      exportTable: async (_tracePath, schema) => {
        if (schema === 'time-profile') {
          return '';
        }
        return tables[schema] ?? '';
      },
      exportHAR: async () =>
        JSON.stringify({
          log: {
            entries: [
              {
                request: { url: 'https://har.example.com/users', bodySize: 100 },
                response: { status: 200, bodySize: 900 },
              },
              {
                request: { url: 'https://har.example.com/fail', bodySize: 50 },
                response: { status: 503, bodySize: 150 },
              },
            ],
          },
        }),
    });

    const trace = await parser.parseTrace('packages/core/package.json');
    const network = trace.instrumentAnalyses?.find((analysis) => analysis.kind === 'network');

    expect(network?.sourceSchemas).toContain('har');
    expect(network?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Requests', numericValue: 2 }),
        expect.objectContaining({ name: 'Transferred Bytes', numericValue: 1200 }),
      ])
    );
    expect(network?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Network failures detected' }),
      ])
    );
  });

  it('does not raw-export CFNetwork internal schemas when HAR is unavailable', async () => {
    const exportedSchemas: string[] = [];
    const parser = new TraceParser({
      exportTOC: async () => `
        <trace-toc>
          <run number="1">
            <duration>2s</duration>
            <data>
              <table schema="time-profile"/>
              <table schema="com-apple-cfnetwork-task-drawables"/>
              <table schema="com-apple-cfnetwork-transaction-intervals-full-info"/>
              <table schema="com-apple-cfnetwork-aggregation-drawables"/>
            </data>
          </run>
        </trace-toc>
      `,
      exportTable: async (_tracePath, schema) => {
        exportedSchemas.push(schema);
        return '';
      },
      exportHAR: async () => {
        throw new Error('HAR unavailable');
      },
    });

    const trace = await parser.parseTrace('packages/core/package.json');
    const network = trace.instrumentAnalyses?.find((analysis) => analysis.kind === 'network');

    expect(exportedSchemas).toEqual(['time-profile']);
    expect(network?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'No exportable Network rows' }),
      ])
    );
    expect(network?.sourceSchemas).toEqual([
      'com-apple-cfnetwork-task-drawables',
      'com-apple-cfnetwork-transaction-intervals-full-info',
      'com-apple-cfnetwork-aggregation-drawables',
    ]);
  });
});

describe('multi-instrument analysis', () => {
  it('carries instrument analyses and recommendations through the high-level analysis model', async () => {
    const parser = new TraceParser({
      exportTOC: async () => tocXML,
      exportTable: async (_tracePath, schema) => {
        if (schema === 'time-profile') {
          return '';
        }
        return tables[schema] ?? '';
      },
    });

    const trace = await parser.parseTrace('packages/core/package.json');
    const analysis = analyzeTrace(trace);
    analysis.recommendations = generateRecommendations(analysis);

    expect(analysis.instrumentAnalyses.map((section) => section.kind)).toContain('energy');
    expect(analysis.summary).toContain('5 additional instrument analyses');
    expect(analysis.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Investigate Memory Usage' }),
        expect.objectContaining({ title: 'Investigate Memory Leaks' }),
        expect.objectContaining({ title: 'Reduce Energy Impact' }),
      ])
    );
  });
});

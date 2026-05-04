import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TraceParser } from '../src/parser/trace-parser.js';
import { traceArtifactExists } from '../src/utils/xctrace-runner.js';

// Realistic xctrace output shape for a `potential-hangs` xpath export.
// id/ref interning is exercised: row 2's `<thread>` and `<process>` are refs
// to row 1's nodes, plus row 3 introduces a new thread.
const POTENTIAL_HANGS_XML = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[14]'>
    <schema name="potential-hangs">
      <col><mnemonic>start</mnemonic><name>Start</name></col>
      <col><mnemonic>duration</mnemonic><name>Duration</name></col>
      <col><mnemonic>hang-type</mnemonic><name>Hang Type</name></col>
      <col><mnemonic>thread</mnemonic><name>Thread</name></col>
      <col><mnemonic>process</mnemonic><name>Process</name></col>
    </schema>
    <row>
      <start-time id="1" fmt="00:01.326.520">1326520666</start-time>
      <duration id="2" fmt="817.10 ms">817103292</duration>
      <hang-type id="3" fmt="Hang">Hang</hang-type>
      <thread id="4" fmt="Main Thread (0x15d497e) (AgentHub, pid: 36405)">
        <tid id="5" fmt="0x15d497e">22890878</tid>
        <process id="6" fmt="AgentHub (36405)">
          <pid id="7" fmt="36405">36405</pid>
        </process>
      </thread>
      <process ref="6"/>
    </row>
    <row>
      <start-time id="9" fmt="00:02.143.625">2143625500</start-time>
      <duration id="10" fmt="11.37 s">11371562708</duration>
      <hang-type id="11" fmt="Severe Hang">Severe Hang</hang-type>
      <thread ref="4"/>
      <process ref="6"/>
    </row>
    <row>
      <start-time id="12" fmt="00:19.016.374">19016374041</start-time>
      <duration id="13" fmt="429.17 ms">429173625</duration>
      <hang-type id="18" fmt="Microhang">Microhang</hang-type>
      <thread ref="4"/>
      <process ref="6"/>
    </row>
    <row>
      <start-time id="22" fmt="00:23.057.991">23057991458</start-time>
      <duration id="23" fmt="3.31 s">3314916542</duration>
      <hang-type ref="11"/>
      <thread ref="4"/>
      <process ref="6"/>
    </row>
  </node>
</trace-query-result>`;

const TOC_WITH_HANGS = `<?xml version="1.0"?>
<trace-toc>
  <run number="1">
    <duration>30s</duration>
    <data>
      <table schema="time-profile" xpath='/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]'/>
      <table schema="potential-hangs" xpath='/trace-toc/run[@number="1"]/data/table[@schema="potential-hangs"]'/>
    </data>
  </run>
</trace-toc>`;

describe('TraceParser hangs', () => {
  let tempTracePath: string;

  beforeEach(async () => {
    // parseTrace validates the trace path exists. Create a real (empty)
    // directory so the validator passes; no real xctrace data is needed
    // because we inject a stub exporter.
    tempTracePath = await mkdtemp(join(tmpdir(), 'hangs-trace-test-'));
  });

  afterEach(async () => {
    await rm(tempTracePath, { recursive: true, force: true });
  });

  it('parses potential-hangs rows including ref-resolved thread/process', async () => {
    const parser = new TraceParser({
      exportTOC: async () => TOC_WITH_HANGS,
      exportTable: async () => '',
      exportXPath: async (_path, xpath) => {
        if (xpath.includes('potential-hangs')) return POTENTIAL_HANGS_XML;
        return '';
      },
    });

    const trace = await parser.parseTrace(tempTracePath);

    expect(trace.hangs).toBeDefined();
    const hangs = trace.hangs!;
    expect(hangs.events).toHaveLength(4);
    expect(hangs.severeCount).toBe(2);
    expect(hangs.hangCount).toBe(1);
    expect(hangs.microhangCount).toBe(1);
    expect(hangs.sourceSchemas).toContain('potential-hangs');

    // Events sorted by start time.
    expect(hangs.events[0].startMs).toBeCloseTo(1326.5, 1);
    expect(hangs.events[1].startMs).toBeCloseTo(2143.6, 1);
    expect(hangs.events[1].durationMs).toBeCloseTo(11371.6, 1);
    expect(hangs.events[1].hangType).toBe('Severe Hang');

    // Ref'd thread/process resolved on subsequent rows.
    for (const event of hangs.events) {
      expect(event.threadName).toBe('Main Thread (0x15d497e) (AgentHub, pid: 36405)');
      expect(event.threadId).toBe(22890878);
      expect(event.processName).toBe('AgentHub (36405)');
      expect(event.pid).toBe(36405);
    }

    // longestMs matches the severe 11.37s hang.
    expect(hangs.longestMs).toBeCloseTo(11371.6, 1);
    // totalHangMs = sum of all four.
    expect(hangs.totalHangMs).toBeCloseTo(817.1 + 11371.6 + 429.2 + 3314.9, 0);
  });

  it('returns undefined when no hang schemas are present in the TOC', async () => {
    const tocWithoutHangs = `<?xml version="1.0"?>
      <trace-toc><run number="1"><data>
        <table schema="time-profile"/>
      </data></run></trace-toc>`;
    const parser = new TraceParser({
      exportTOC: async () => tocWithoutHangs,
      exportTable: async () => '',
      exportXPath: async () => '',
    });

    const trace = await parser.parseTrace(tempTracePath);
    expect(trace.hangs).toBeUndefined();
  });

  it('still surfaces events from one schema when a sibling fails', async () => {
    const tocWithBoth = `<?xml version="1.0"?>
      <trace-toc><run number="1"><data>
        <table schema="potential-hangs" xpath='/trace-toc/run[@number="1"]/data/table[@schema="potential-hangs"]'/>
        <table schema="hang-risks" xpath='/trace-toc/run[@number="1"]/data/table[@schema="hang-risks"]'/>
      </data></run></trace-toc>`;
    const parser = new TraceParser({
      exportTOC: async () => tocWithBoth,
      exportTable: async () => '',
      exportXPath: async (_path, xpath) => {
        if (xpath.includes('hang-risks')) {
          throw new Error('xctrace export failed for hang-risks');
        }
        if (xpath.includes('potential-hangs')) return POTENTIAL_HANGS_XML;
        return '';
      },
    });

    const trace = await parser.parseTrace(tempTracePath);
    expect(trace.hangs?.events.length).toBe(4);
    expect(trace.hangs?.sourceSchemas).toEqual(['potential-hangs']);
    // Failed sibling is recorded as an export attempt.
    expect(trace.exportAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'hangs', schema: 'hang-risks', status: 'failed' }),
      ])
    );
  });
});

describe('traceArtifactExists', () => {
  let tempBase: string;

  beforeEach(async () => {
    tempBase = await mkdtemp(join(tmpdir(), 'artifact-test-'));
  });

  afterEach(async () => {
    await rm(tempBase, { recursive: true, force: true });
  });

  it('returns true for a non-empty .trace directory', async () => {
    const tracePath = join(tempBase, 'sample.trace');
    await mkdir(tracePath);
    await writeFile(join(tracePath, 'Trace1.run'), 'binary-data');
    expect(await traceArtifactExists(tracePath)).toBe(true);
  });

  it('returns false for an empty .trace directory', async () => {
    const tracePath = join(tempBase, 'empty.trace');
    await mkdir(tracePath);
    expect(await traceArtifactExists(tracePath)).toBe(false);
  });

  it('returns false when the path does not exist', async () => {
    expect(await traceArtifactExists(join(tempBase, 'missing.trace'))).toBe(false);
  });

  it('returns false when the path is a regular file, not a directory', async () => {
    const filePath = join(tempBase, 'fake.trace');
    await writeFile(filePath, 'data');
    expect(await traceArtifactExists(filePath)).toBe(false);
  });
});

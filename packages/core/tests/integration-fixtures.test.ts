import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { TraceParser } from '../src/parser/trace-parser.js';
import { analyzeTrace } from '../src/analyzer/performance-analyzer.js';
import type { Analysis, ParsedTrace } from '../src/types.js';

/**
 * Integration tests that run the parser against real `.trace` fixtures
 * committed under `test-traces/`. Skipped automatically when `xctrace` is not
 * available (e.g. CI without Xcode).
 *
 * These exercise the full pipeline (TOC → schemas → exportXPath → parse) on
 * artifacts produced by Instruments, not synthetic XML. We share a single
 * parsed trace across assertions via `beforeAll` so we only pay the xctrace
 * export cost once per file (the time-profile export can be slow on real
 * traces and may hit `EXPORT_TABLE_TIMEOUT_MS` if invoked repeatedly).
 */

function xctraceAvailable(): boolean {
  try {
    execFileSync('xcrun', ['xctrace', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const TRACES_DIR = resolve(__dirname, '../../../test-traces');
const FIXTURE_WITH_HANGS = resolve(
  TRACES_DIR,
  'AgentHub-full-2026-05-03T08-08-01-842Z.trace'
);

const skipUnlessAvailable =
  xctraceAvailable() && existsSync(FIXTURE_WITH_HANGS) ? describe : describe.skip;

skipUnlessAvailable('integration: real .trace fixtures', () => {
  let parsed: ParsedTrace;
  let analysis: Analysis;

  beforeAll(async () => {
    const parser = new TraceParser();
    parsed = await parser.parseTrace(FIXTURE_WITH_HANGS);
    analysis = analyzeTrace(parsed);
  }, 120_000);

  it('extracts the expected hang counts from a real AgentHub trace', () => {
    expect(parsed.hangs).toBeDefined();
    const hangs = parsed.hangs!;
    // Real trace contains 12 Hang + 3 Microhang + 3 Severe Hang = 18 events.
    expect(hangs.events.length).toBe(18);
    expect(hangs.severeCount).toBe(3);
    expect(hangs.hangCount).toBe(12);
    expect(hangs.microhangCount).toBe(3);
    expect(hangs.longestMs).toBeGreaterThan(1000);
    expect(hangs.sourceSchemas).toContain('potential-hangs');
  });

  it('resolves thread/process metadata via id/ref interning', () => {
    const hangs = parsed.hangs!;
    for (const event of hangs.events) {
      expect(event.threadName).toBeDefined();
      expect(event.processName).toBeDefined();
    }
  });

  it('surfaces hangs in the analyzer summary when severe', () => {
    expect(analysis.hangs?.events.length).toBe(parsed.hangs?.events.length);
    expect(analysis.summary.toLowerCase()).toContain('hang');
  });
});

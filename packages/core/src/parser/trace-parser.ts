/**
 * TraceParser - Parses Xcode Instruments trace files
 */

import { XMLParser } from 'fast-xml-parser';
import { stat } from 'fs/promises';
import { basename } from 'path';
import {
  ParsedTrace,
  TraceMetadata,
  TimeProfileData,
  FunctionProfile,
  Sample,
  TraceParserError,
  InstrumentAnalysis,
  InstrumentFinding,
  InstrumentMetric,
  TraceKind,
  ExportAttempt,
  AnalysisSupportStatus,
  TraceTableDescriptor,
  SupportStatus,
  HangsData,
  HangEvent,
  HangType,
  TimeRangeMs,
} from '../types.js';
import { exportHAR, exportTable, exportTOC, exportXPath } from '../utils/xctrace-runner.js';

export interface TraceExporter {
  exportTOC(tracePath: string): Promise<string>;
  exportTable(tracePath: string, schema: string, runNumber?: number): Promise<string>;
  exportXPath?(tracePath: string, xpath: string): Promise<string>;
  exportHAR?(tracePath: string): Promise<string>;
}

export interface TraceParserOptions {
  timeRangeMs?: TimeRangeMs;
}

const defaultExporter: TraceExporter = {
  exportTOC,
  exportTable,
  exportXPath,
  exportHAR,
};

type TableRow = Record<string, string | number | boolean>;

// Hangs and time-profile are parsed via dedicated code paths and therefore
// excluded from the instrument-pattern routing below.
type InstrumentKind = Exclude<TraceKind, 'time-profile' | 'hangs'>;

const INSTRUMENT_ORDER: InstrumentKind[] = [
  'memory',
  'network',
  'energy',
  'allocations',
  'leaks',
];

const SCHEMA_PATTERNS: Record<InstrumentKind, RegExp[]> = {
  memory: [/memory/i, /resident/i, /dirty/i, /vm/i],
  network: [/network/i, /connection/i, /http/i, /url/i],
  energy: [/energy/i, /power/i, /wakeups?/i, /battery/i],
  allocations: [/alloc/i, /malloc/i],
  leaks: [/leaks?/i],
};

/** Schemas xctrace uses to expose main-thread stalls. */
const HANG_SCHEMAS = ['potential-hangs', 'hang-risks'] as const;
type HangSchema = (typeof HANG_SCHEMAS)[number];

/**
 * Parse xctrace timestamp/duration fmt strings to milliseconds.
 *
 * Supported shapes (all real outputs from xctrace 16):
 * - `"817.10 ms"` / `"11.37 s"` / `"4.76 s"` (duration with unit)
 * - `"00:01.326.520"` (mm:ss.ms.us — used for absolute timestamps)
 * - `"272.78 ms"` (microhang durations)
 *
 * Returns `undefined` when the string can't be interpreted; callers should
 * fall back to other fields.
 */
function parseTimestampFmtToMs(fmt: string): number | undefined {
  const trimmed = fmt.trim();
  if (!trimmed) return undefined;

  // mm:ss.ms.us — convert each segment.
  const colonMatch = trimmed.match(/^(\d+):(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (colonMatch) {
    const minutes = Number(colonMatch[1]);
    const seconds = Number(colonMatch[2]);
    const ms = Number(colonMatch[3]);
    const us = colonMatch[4] !== undefined ? Number(colonMatch[4]) : 0;
    return minutes * 60_000 + seconds * 1000 + ms + us / 1000;
  }

  // value + unit
  const unitMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s|m|h)$/i);
  if (unitMatch) {
    const value = Number(unitMatch[1]);
    const unit = unitMatch[2].toLowerCase();
    switch (unit) {
      case 'ns':
        return value / 1e6;
      case 'us':
      case 'µs':
        return value / 1000;
      case 'ms':
        return value;
      case 's':
        return value * 1000;
      case 'm':
        return value * 60_000;
      case 'h':
        return value * 3_600_000;
    }
  }

  return undefined;
}

const NETWORK_RAW_EXPORT_DENY_PATTERNS = [
  /cfnetwork/i,
  /drawables?/i,
  /intervals?/i,
  /aggregation/i,
  /harlogging/i,
];

const BYTE_UNIT_MULTIPLIERS: Record<string, number> = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 * 1024,
  mib: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  gib: 1024 * 1024 * 1024,
};

const NUMERIC_UNITS = new Set([
  '%',
  'percent',
  'ms',
  's',
  'sec',
  'secs',
  'second',
  'seconds',
  'm',
  'min',
  'mins',
  'minute',
  'minutes',
  'h',
  'hr',
  'hrs',
  'hour',
  'hours',
  'count',
  'counts',
  'sample',
  'samples',
  'request',
  'requests',
  'wakeups',
]);

/**
 * Main parser class for Xcode Instruments traces
 */
export class TraceParser {
  private xmlParser: XMLParser;
  private exporter: TraceExporter;
  private exportAttempts: ExportAttempt[] = [];

  constructor(exporter: TraceExporter = defaultExporter) {
    this.exporter = exporter;
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      parseAttributeValue: true,
      trimValues: true,
    });
  }

  /**
   * Parse a complete trace file
   */
  async parseTrace(tracePath: string, options: TraceParserOptions = {}): Promise<ParsedTrace> {
    try {
      this.exportAttempts = [];

      // Validate trace file exists
      await this.validateTraceFile(tracePath);

      // Get metadata and table schemas
      const { metadata, schemas, tableDescriptors } =
        await this.extractMetadataAndSchemas(tracePath);

      // Parse time profile data
      const timeProfile = await this.parseTimeProfile(tracePath, schemas, tableDescriptors, options);
      const hangs = await this.parseHangs(tracePath, schemas, tableDescriptors, options);
      const instrumentAnalyses = await this.parseInstrumentAnalyses(
        tracePath,
        schemas,
        tableDescriptors
      );
      const supportStatus = this.buildSupportStatus(schemas, timeProfile, instrumentAnalyses);

      return {
        metadata,
        timeProfile,
        hangs,
        instrumentAnalyses,
        tableDescriptors,
        exportAttempts: [...this.exportAttempts],
        supportStatus,
      };
    } catch (error) {
      if (error instanceof TraceParserError) {
        throw error;
      }
      throw new TraceParserError(
        `Failed to parse trace: ${tracePath}`,
        error as Error
      );
    }
  }

  /**
   * Validate that the trace file exists and is readable
   */
  private async validateTraceFile(tracePath: string): Promise<void> {
    try {
      const stats = await stat(tracePath);
      if (!stats.isFile() && !stats.isDirectory()) {
        throw new TraceParserError(`Path is not a valid trace file: ${tracePath}`);
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new TraceParserError(`Trace file not found: ${tracePath}`);
      }
      throw new TraceParserError(`Cannot access trace file: ${tracePath}`, error);
    }
  }

  /**
   * Extract metadata from trace file
   */
  private async extractMetadataAndSchemas(
    tracePath: string
  ): Promise<{
    metadata: TraceMetadata;
    schemas: string[];
    tableDescriptors: TraceTableDescriptor[];
  }> {
    try {
      const tocXML = await this.exporter.exportTOC(tracePath);
      const tocData = this.xmlParser.parse(tocXML);
      const schemas = this.extractSchemas(tocData);
      const tableDescriptors = this.extractTableDescriptors(tocData);
      const userProcessNames = this.extractUserProcessNames(tocData);
      this.exportAttempts.push({
        kind: 'toc',
        status: schemas.length > 0 ? 'success' : 'empty',
      });

      // Extract metadata from TOC
      const run = tocData['trace-toc']?.run;
      if (!run) {
        throw new TraceParserError('Invalid trace TOC structure');
      }

      const metadata: TraceMetadata = {
        fileName: basename(tracePath),
        filePath: tracePath,
        duration: 0,
        template: 'Unknown',
      };
      if (userProcessNames.length > 0) {
        metadata.userProcessNames = userProcessNames;
      }

      // Try to extract various metadata fields
      if (run['@_number']) {
        // Run exists, try to get more info
      }

      // Get file stats for timestamp
      const stats = await stat(tracePath);
      metadata.recordedAt = stats.mtime;

      // Parse duration if available
      if (run.duration) {
        metadata.duration = this.parseDuration(run.duration);
      }

      return { metadata, schemas, tableDescriptors };
    } catch (error) {
      this.exportAttempts.push({
        kind: 'toc',
        status: 'failed',
        message: (error as Error).message,
      });
      // Return minimal metadata if we can't parse TOC
      return {
        metadata: {
          fileName: basename(tracePath),
          filePath: tracePath,
          duration: 0,
          template: 'Unknown',
        },
        schemas: [],
        tableDescriptors: [],
      };
    }
  }

  /**
   * Parse Time Profiler data from trace
   */
  private async parseTimeProfile(
    tracePath: string,
    schemas: string[],
    tableDescriptors: TraceTableDescriptor[],
    options: TraceParserOptions
  ): Promise<TimeProfileData | undefined> {
    if (schemas.length > 0 && !schemas.includes('time-profile')) {
      this.exportAttempts.push({
        kind: 'time-profile',
        status: 'skipped',
        schema: 'time-profile',
        message: 'The trace TOC does not expose a Time Profiler table.',
      });
      return undefined;
    }

    try {
      const descriptor = tableDescriptors.find((table) => table.schema === 'time-profile');
      const xmlData = descriptor?.xpath && this.exporter.exportXPath
        ? await this.exporter.exportXPath(tracePath, descriptor.xpath)
        : await this.exporter.exportTable(tracePath, 'time-profile', descriptor?.runNumber);

      if (!xmlData || xmlData.trim() === '') {
        // No time profile data available
        this.exportAttempts.push({
          kind: 'time-profile',
          status: 'empty',
          schema: 'time-profile',
          xpath: descriptor?.xpath,
        });
        return undefined;
      }

      const parsed = this.xmlParser.parse(xmlData);

      // Extract table data. Recent xctrace versions wrap XPath exports in
      // trace-query-result/node instead of returning a bare table element.
      const table = parsed.table ?? parsed['trace-query-result']?.node;
      if (!table) {
        this.exportAttempts.push({
          kind: 'time-profile',
          status: 'empty',
          schema: 'time-profile',
          xpath: descriptor?.xpath,
          message: 'No table rows were exported for Time Profiler.',
        });
        return undefined;
      }

      // Parse rows into samples before applying any analysis window.
      const rawSamples: Sample[] = [];

      // Parse table rows
      const rows = this.rowsFromTableNode(table);

      for (const row of rows) {
        if (!row) continue;

        // Extract sample data
        const sample = this.parseSampleRow(row);
        if (sample) {
          rawSamples.push(sample);
        }
      }

      const samples = this.filterSamplesByTimeRange(rawSamples, options.timeRangeMs);
      const functionMap = new Map<string, FunctionProfile>();
      for (const sample of samples) {
        this.aggregateFunctionProfiles(sample, functionMap);
      }

      this.exportAttempts.push({
        kind: 'time-profile',
        status: rawSamples.length > 0 ? 'success' : 'empty',
        schema: 'time-profile',
        xpath: descriptor?.xpath,
      });

      // Convert function map to sorted array
      const functionProfiles = Array.from(functionMap.values())
        .sort((a, b) => b.totalTime - a.totalTime);

      // Calculate total duration from samples
      const totalDuration = this.timeProfileTotalDuration(samples, options.timeRangeMs);

      return {
        totalDuration,
        samples,
        functionProfiles,
      };
    } catch (error) {
      this.exportAttempts.push({
        kind: 'time-profile',
        status: 'failed',
        schema: 'time-profile',
        message: (error as Error).message,
      });
      return undefined;
    }
  }

  /**
   * Parse supported non-Time-Profiler instrument data.
   */
  private async parseInstrumentAnalyses(
    tracePath: string,
    schemas: string[],
    tableDescriptors: TraceTableDescriptor[]
  ): Promise<InstrumentAnalysis[]> {
    const analyses: InstrumentAnalysis[] = [];

    for (const kind of INSTRUMENT_ORDER) {
      const matchingSchemas = this.matchSchemasForKind(schemas, kind);
      if (kind === 'network') {
        const network = await this.parseNetworkAnalysis(tracePath, matchingSchemas, tableDescriptors);
        if (network) {
          analyses.push(network);
        }
        continue;
      }

      if (matchingSchemas.length === 0) {
        continue;
      }

      const rows = await this.exportRowsForSchemas(tracePath, matchingSchemas, tableDescriptors, kind);
      const analysis = this.analyzeRowsForKind(kind, rows, matchingSchemas);
      if (analysis) {
        analyses.push(analysis);
      }
    }

    return analyses;
  }

  /**
   * Parse main-thread hang events from `potential-hangs` and `hang-risks`.
   *
   * xctrace exposes these schemas in every macOS/iOS trace; each row carries a
   * `start-time`, `duration`, and `hang-type` (`Hang` / `Severe Hang` /
   * `Microhang`), plus thread/process metadata. Returns `undefined` when no
   * hang schemas are present (most empty traces).
   */
  private async parseHangs(
    tracePath: string,
    schemas: string[],
    tableDescriptors: TraceTableDescriptor[],
    options: TraceParserOptions
  ): Promise<HangsData | undefined> {
    const presentSchemas = HANG_SCHEMAS.filter((schema) => schemas.includes(schema));
    if (presentSchemas.length === 0) {
      return undefined;
    }

    const events: HangEvent[] = [];
    const sourceSchemas: string[] = [];

    for (const schema of presentSchemas) {
      const descriptor = tableDescriptors.find((table) => table.schema === schema);
      try {
        const xmlData = descriptor?.xpath && this.exporter.exportXPath
          ? await this.exporter.exportXPath(tracePath, descriptor.xpath)
          : await this.exporter.exportTable(tracePath, schema, descriptor?.runNumber);

        if (!xmlData || xmlData.trim() === '') {
          this.exportAttempts.push({
            kind: 'hangs',
            status: 'empty',
            schema,
            xpath: descriptor?.xpath,
          });
          continue;
        }

        const parsed = this.xmlParser.parse(xmlData);
        const table = parsed.table ?? parsed['trace-query-result']?.node;
        if (!table) {
          this.exportAttempts.push({
            kind: 'hangs',
            status: 'empty',
            schema,
            xpath: descriptor?.xpath,
            message: `No table rows were exported for ${schema}.`,
          });
          continue;
        }

        const rawRows = this.rowsFromTableNode(table);
        const resolved = this.resolveIdRefs(rawRows);
        const schemaEvents = resolved
          .map((row) => this.parseHangRow(row, schema))
          .filter((event): event is HangEvent => event !== undefined);

        const scopedEvents = this.filterHangEventsByTimeRange(schemaEvents, options.timeRangeMs);
        if (scopedEvents.length > 0) {
          events.push(...scopedEvents);
          sourceSchemas.push(schema);
        }
        this.exportAttempts.push({
          kind: 'hangs',
          status: schemaEvents.length > 0 ? 'success' : 'empty',
          schema,
          xpath: descriptor?.xpath,
        });
      } catch (error) {
        this.exportAttempts.push({
          kind: 'hangs',
          status: 'failed',
          schema,
          xpath: descriptor?.xpath,
          message: (error as Error).message,
        });
        // Don't AND-gate across descriptors — keep going so events from a
        // sibling schema (e.g. `potential-hangs`) still surface even if
        // `hang-risks` failed.
      }
    }

    if (events.length === 0) {
      return undefined;
    }

    events.sort((a, b) => a.startMs - b.startMs);
    return this.summarizeHangs(events, sourceSchemas);
  }

  private parseHangRow(row: any, schema: HangSchema): HangEvent | undefined {
    const startMs = this.readDurationFieldMs(row['start-time']);
    const durationMs = this.readDurationFieldMs(row.duration);
    const hangType = this.readTextField(row['hang-type']) as HangType | undefined;
    if (startMs === undefined || durationMs === undefined || !hangType) {
      return undefined;
    }

    const thread = row.thread;
    const threadName = this.readFmtField(thread);
    const tidValue = this.readNumericField(thread?.tid);

    const processNode = row.process ?? thread?.process;
    const processName = this.readFmtField(processNode);
    const pidValue = this.readNumericField(processNode?.pid);

    const event: HangEvent = {
      startMs,
      durationMs,
      hangType,
      schemaSource: schema,
    };
    if (threadName !== undefined) event.threadName = threadName;
    if (tidValue !== undefined) event.threadId = tidValue;
    if (processName !== undefined) event.processName = processName;
    if (pidValue !== undefined) event.pid = pidValue;
    return event;
  }

  private summarizeHangs(events: HangEvent[], sourceSchemas: string[]): HangsData {
    let totalHangMs = 0;
    let severeCount = 0;
    let hangCount = 0;
    let microhangCount = 0;
    let longestMs = 0;
    for (const event of events) {
      totalHangMs += event.durationMs;
      if (event.durationMs > longestMs) longestMs = event.durationMs;
      switch (event.hangType) {
        case 'Severe Hang':
          severeCount += 1;
          break;
        case 'Microhang':
          microhangCount += 1;
          break;
        case 'Hang':
          hangCount += 1;
          break;
        default:
          // Forward-compat: unknown classifications fall through silently.
          break;
      }
    }
    return {
      events,
      totalHangMs,
      severeCount,
      hangCount,
      microhangCount,
      longestMs,
      sourceSchemas,
    };
  }

  private filterSamplesByTimeRange(samples: Sample[], timeRangeMs?: TimeRangeMs): Sample[] {
    if (!timeRangeMs) {
      return samples;
    }
    return samples.filter((sample) =>
      sample.timestamp >= timeRangeMs.startMs && sample.timestamp <= timeRangeMs.endMs
    );
  }

  private filterHangEventsByTimeRange(events: HangEvent[], timeRangeMs?: TimeRangeMs): HangEvent[] {
    if (!timeRangeMs) {
      return events;
    }
    return events.filter((event) => {
      const eventEndMs = event.startMs + event.durationMs;
      return event.startMs <= timeRangeMs.endMs && eventEndMs >= timeRangeMs.startMs;
    });
  }

  private timeProfileTotalDuration(samples: Sample[], timeRangeMs?: TimeRangeMs): number {
    if (timeRangeMs) {
      return Math.max(0, timeRangeMs.endMs - timeRangeMs.startMs);
    }
    return samples.length > 0
      ? Math.max(...samples.map(s => s.timestamp))
      : 0;
  }

  /**
   * xctrace XML interns repeated values: the first occurrence has `id="N"`
   * with full data, every subsequent occurrence is `<element ref="N"/>`.
   * Without resolution every row after the first loses its thread/process
   * info. Walk the rows once collecting `id -> node`, then deep-clone each
   * row substituting any `ref` for its captured node.
   */
  private resolveIdRefs(rows: any[]): any[] {
    const idMap = new Map<string, any>();

    const collect = (value: any): void => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) collect(item);
        return;
      }
      const id = value['@_id'];
      if (id !== undefined && id !== null) {
        idMap.set(String(id), value);
      }
      for (const [key, child] of Object.entries(value)) {
        if (key.startsWith('@_')) continue;
        collect(child);
      }
    };
    for (const row of rows) collect(row);

    const resolve = (value: any): any => {
      if (value === null || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(resolve);
      const refId = value['@_ref'];
      if (refId !== undefined && refId !== null) {
        const captured = idMap.get(String(refId));
        if (captured !== undefined) {
          // Resolve the captured node recursively in case it itself contains refs.
          return resolve(captured);
        }
      }
      const out: any = {};
      for (const [key, child] of Object.entries(value)) {
        if (key.startsWith('@_')) {
          out[key] = child;
        } else {
          out[key] = resolve(child);
        }
      }
      return out;
    };

    return rows.map(resolve);
  }

  /**
   * Read the duration of a `<start-time>` / `<duration>` element, in
   * milliseconds. xctrace emits the raw nanosecond count as the element's
   * text content and a pretty form (e.g. `"817.10 ms"` or `"00:01.326.520"`)
   * as `@_fmt`. Prefer the text (always ns); fall back to fmt parsing.
   */
  private readDurationFieldMs(field: any): number | undefined {
    if (field === undefined || field === null) return undefined;
    if (typeof field === 'number') return field / 1e6;
    if (typeof field === 'string') {
      const ns = Number(field);
      if (Number.isFinite(ns)) return ns / 1e6;
      return parseTimestampFmtToMs(field);
    }
    if (typeof field === 'object') {
      const text = field['#text'];
      if (typeof text === 'number') return text / 1e6;
      if (typeof text === 'string') {
        const ns = Number(text);
        if (Number.isFinite(ns)) return ns / 1e6;
      }
      const fmt = field['@_fmt'];
      if (typeof fmt === 'string') return parseTimestampFmtToMs(fmt);
    }
    return undefined;
  }

  private readTextField(field: any): string | undefined {
    if (field === undefined || field === null) return undefined;
    if (typeof field === 'string') return field;
    if (typeof field === 'number') return String(field);
    if (typeof field === 'object') {
      const text = field['#text'];
      if (typeof text === 'string') return text;
      if (typeof text === 'number') return String(text);
      const fmt = field['@_fmt'];
      if (typeof fmt === 'string') return fmt;
    }
    return undefined;
  }

  private readFmtField(field: any): string | undefined {
    if (field === undefined || field === null) return undefined;
    if (typeof field === 'object') {
      const fmt = field['@_fmt'];
      if (typeof fmt === 'string' && fmt.length > 0) return fmt;
    }
    return undefined;
  }

  private readNumericField(field: any): number | undefined {
    if (field === undefined || field === null) return undefined;
    if (typeof field === 'number') return field;
    if (typeof field === 'string') {
      const n = Number(field);
      return Number.isFinite(n) ? n : undefined;
    }
    if (typeof field === 'object') {
      const text = field['#text'];
      if (typeof text === 'number') return text;
      if (typeof text === 'string') {
        const n = Number(text);
        if (Number.isFinite(n)) return n;
      }
    }
    return undefined;
  }

  private async parseNetworkAnalysis(
    tracePath: string,
    matchingSchemas: string[],
    tableDescriptors: TraceTableDescriptor[]
  ): Promise<InstrumentAnalysis | undefined> {
    const har = await this.tryExportHAR(tracePath);
    if (har) {
      return this.analyzeNetworkHAR(har, ['har', ...matchingSchemas]);
    }

    if (matchingSchemas.length === 0) {
      return undefined;
    }

    const exportableSchemas = this.networkSchemasSafeForRawExport(matchingSchemas);
    if (exportableSchemas.length === 0) {
      return this.analyzeRowsForKind(
        'network',
        this.unexportedRowsForSchemas(matchingSchemas),
        matchingSchemas
      );
    }

    const rows = await this.exportRowsForSchemas(
      tracePath,
      exportableSchemas,
      tableDescriptors,
      'network'
    );
    const skippedSchemas = matchingSchemas.filter((schema) => !exportableSchemas.includes(schema));
    for (const schema of skippedSchemas) {
      this.exportAttempts.push({
        kind: 'network',
        status: 'skipped',
        schema,
        message: 'Schema is known to be unsafe or not useful for raw XML export; HAR is preferred.',
      });
    }
    rows.push(...this.unexportedRowsForSchemas(skippedSchemas));
    return this.analyzeRowsForKind('network', rows, matchingSchemas);
  }

  private async tryExportHAR(tracePath: string): Promise<any | undefined> {
    if (!this.exporter.exportHAR) {
      return undefined;
    }

    try {
      const har = await this.exporter.exportHAR(tracePath);
      if (!har || !har.trim()) {
        this.exportAttempts.push({ kind: 'har', status: 'empty' });
        return undefined;
      }
      this.exportAttempts.push({ kind: 'har', status: 'success' });
      return JSON.parse(har);
    } catch {
      this.exportAttempts.push({ kind: 'har', status: 'failed' });
      return undefined;
    }
  }

  private analyzeRowsForKind(
    kind: Exclude<TraceKind, 'time-profile'>,
    rows: TableRow[],
    sourceSchemas: string[]
  ): InstrumentAnalysis | undefined {
    switch (kind) {
      case 'memory':
        return this.analyzeMemoryRows(rows, sourceSchemas);
      case 'network':
        return this.analyzeNetworkRows(rows, sourceSchemas);
      case 'energy':
        return this.analyzeEnergyRows(rows, sourceSchemas);
      case 'allocations':
        return this.analyzeAllocationRows(rows, sourceSchemas);
      case 'leaks':
        return this.analyzeLeakRows(rows, sourceSchemas);
    }
  }

  private buildSupportStatus(
    schemas: string[],
    timeProfile: TimeProfileData | undefined,
    instrumentAnalyses: InstrumentAnalysis[]
  ): AnalysisSupportStatus[] {
    const tocFailure = this.exportAttempts.find((attempt) =>
      attempt.kind === 'toc' && attempt.status === 'failed'
    );
    if (tocFailure) {
      const reason = tocFailure.message
        ? `xctrace could not export the trace TOC: ${tocFailure.message}`
        : 'xctrace could not export the trace TOC; analysis data is unavailable.';
      return (['time-profile', ...INSTRUMENT_ORDER] as TraceKind[]).map((kind) => ({
        kind,
        status: 'not_exportable',
        reason,
        sourceSchemas: [],
      }));
    }

    const statuses: AnalysisSupportStatus[] = [];
    const analyses = new Map(instrumentAnalyses.map((analysis) => [analysis.kind, analysis]));
    const hasTimeProfileSchema = schemas.includes('time-profile');
    const timeProfileAttempts = this.exportAttemptsForSupportKind('time-profile');
    const timeProfileStatus = this.statusFromExportAttempts(
      timeProfileAttempts,
      hasTimeProfileSchema || !!timeProfile
    );

    statuses.push({
      kind: 'time-profile',
      status: timeProfileStatus,
      reason: this.supportReason('time-profile', timeProfileStatus, timeProfileAttempts),
      sourceSchemas: hasTimeProfileSchema || timeProfileAttempts.some((attempt) => attempt.status === 'success')
        ? ['time-profile']
        : [],
    });

    for (const kind of INSTRUMENT_ORDER) {
      const matchingSchemas = this.matchSchemasForKind(schemas, kind);
      const analysis = analyses.get(kind);
      const attempts = this.exportAttemptsForSupportKind(kind);
      const hasSignal = matchingSchemas.length > 0 || !!analysis;
      const status = this.statusFromExportAttempts(attempts, hasSignal);
      const reason = this.supportReason(kind, status, attempts);

      if (analysis) {
        analysis.supportStatus = status;
      }

      statuses.push({
        kind,
        status,
        reason,
        sourceSchemas: analysis?.sourceSchemas ?? matchingSchemas,
      });
    }

    return statuses;
  }

  private exportAttemptsForSupportKind(kind: TraceKind): ExportAttempt[] {
    return this.exportAttempts.filter((attempt) =>
      attempt.kind === kind || (kind === 'network' && attempt.kind === 'har')
    );
  }

  private statusFromExportAttempts(
    attempts: ExportAttempt[],
    hasSchemaOrAnalysis: boolean
  ): SupportStatus {
    const success = attempts.filter((attempt) => attempt.status === 'success');
    const nonSuccess = attempts.filter((attempt) =>
      attempt.status === 'failed' || attempt.status === 'empty' || attempt.status === 'skipped'
    );

    if (success.length > 0 && nonSuccess.length > 0) {
      return 'partial';
    }
    if (success.length > 0) {
      return 'supported';
    }
    if (!hasSchemaOrAnalysis) {
      return 'unsupported';
    }
    return 'not_exportable';
  }

  private supportReason(
    kind: TraceKind,
    status: SupportStatus,
    attempts: ExportAttempt[]
  ): string {
    const section = this.instrumentSectionName(kind);
    switch (status) {
      case 'supported':
        return `${section} data was exported and parsed.`;
      case 'partial':
        return `${section} data was parsed, but some schemas failed, were empty, or were skipped.`;
      case 'not_exportable': {
        const failedAttempt = attempts.find((attempt) => attempt.status === 'failed' && attempt.message);
        if (failedAttempt?.message) {
          return `xctrace exposed ${kind} schemas, but no usable rows were exported: ${failedAttempt.message}`;
        }
        return `xctrace exposed ${kind} schemas, but no usable rows were exported.`;
      }
      case 'unsupported':
        return `The trace TOC does not expose ${kind} schemas.`;
    }
  }

  private instrumentSectionName(kind: TraceKind): string {
    switch (kind) {
      case 'time-profile':
        return 'Time Profiler';
      case 'memory':
        return 'Memory';
      case 'network':
        return 'Network';
      case 'energy':
        return 'Energy';
      case 'allocations':
        return 'Allocations';
      case 'leaks':
        return 'Leaks';
      case 'hangs':
        return 'Hangs';
    }
  }

  private analyzeMemoryRows(rows: TableRow[], sourceSchemas: string[]): InstrumentAnalysis {
    const metrics: InstrumentMetric[] = [];
    const findings: InstrumentFinding[] = this.unexportableFinding(rows, 'Memory');
    const peak = this.maxMetric(rows, [/peak.*memory/i, /peak/i]);
    const resident = this.maxMetric(rows, [/resident/i]);
    const dirty = this.maxMetric(rows, [/dirty/i]);

    this.pushByteMetric(metrics, 'Peak Memory', peak);
    this.pushByteMetric(metrics, 'Resident Memory', resident);
    this.pushByteMetric(metrics, 'Dirty Memory', dirty);

    if ((peak ?? resident ?? 0) > 512 * 1024 * 1024) {
      findings.push({
        severity: 'high',
        title: 'High peak memory usage',
        description: 'Peak memory exceeded 512 MB. Inspect retained objects, image caches, and large buffers.',
      });
    }

    return {
      kind: 'memory',
      title: 'Memory Analysis',
      summary: peak
        ? `Peak memory was ${this.formatBytes(peak)}.`
        : 'Memory data was found, but no peak memory metric was exportable.',
      metrics,
      findings,
      sourceSchemas,
    };
  }

  private analyzeAllocationRows(rows: TableRow[], sourceSchemas: string[]): InstrumentAnalysis {
    const metrics: InstrumentMetric[] = [];
    const findings: InstrumentFinding[] = this.unexportableFinding(rows, 'Allocations');
    const totalAllocations = this.maxMetric(rows, [/total.*alloc/i, /^allocations?$/i, /^count$/i]);
    const totalBytes = this.maxMetric(rows, [/total.*bytes/i, /allocated.*bytes/i, /^bytes$/i]);

    this.pushNumberMetric(metrics, 'Total Allocations', totalAllocations);
    this.pushByteMetric(metrics, 'Total Allocated Bytes', totalBytes);

    const top = this.topRowByBytes(rows);
    if (top.label && top.bytes) {
      metrics.push({
        name: 'Top Allocation Site',
        value: `${top.label} (${this.formatBytes(top.bytes)})`,
        numericValue: top.bytes,
        unit: 'bytes',
      });
    }

    if ((totalBytes ?? top.bytes ?? 0) > 100 * 1024 * 1024) {
      findings.push({
        severity: 'medium',
        title: 'High allocation volume',
        description: 'Allocated bytes exceeded 100 MB. Look for allocation churn in hot paths and repeated object creation.',
      });
    }

    return {
      kind: 'allocations',
      title: 'Allocations Analysis',
      summary: totalAllocations
        ? `${Math.round(totalAllocations).toLocaleString()} allocations were recorded.`
        : 'Allocation data was found.',
      metrics,
      findings,
      sourceSchemas,
    };
  }

  private analyzeLeakRows(rows: TableRow[], sourceSchemas: string[]): InstrumentAnalysis {
    const metrics: InstrumentMetric[] = [];
    const findings: InstrumentFinding[] = this.unexportableFinding(rows, 'Leaks');
    const leaks = this.maxMetric(rows, [/^leaks?$/i, /leak.*count/i, /^count$/i]);
    const leakedBytes = this.maxMetric(rows, [/leaked.*bytes/i, /leak.*size/i, /^bytes$/i]);

    this.pushNumberMetric(metrics, 'Leaks', leaks);
    this.pushByteMetric(metrics, 'Leaked Bytes', leakedBytes);

    const top = this.topRowByBytes(rows);
    if (top.label && top.bytes) {
      metrics.push({
        name: 'Top Leak Site',
        value: `${top.label} (${this.formatBytes(top.bytes)})`,
        numericValue: top.bytes,
        unit: 'bytes',
      });
    }

    if ((leaks ?? 0) > 0 || (leakedBytes ?? 0) > 0) {
      findings.push({
        severity: 'critical',
        title: 'Leaks detected',
        description: 'The trace contains leaked memory. Inspect the reported leak sites for missing releases or retain cycles.',
      });
    }

    return {
      kind: 'leaks',
      title: 'Leaks Analysis',
      summary: leaks ? `${Math.round(leaks)} leaks were detected.` : 'Leak data was found.',
      metrics,
      findings,
      sourceSchemas,
    };
  }

  private analyzeNetworkRows(rows: TableRow[], sourceSchemas: string[]): InstrumentAnalysis {
    const findings: InstrumentFinding[] = this.unexportableFinding(rows, 'Network');
    const usableRows = rows.filter((row) => row.Exportable !== false);
    const requests = usableRows.length;
    let failedRequests = 0;
    let transferredBytes = 0;
    const hosts = new Map<string, number>();

    for (const row of usableRows) {
      const status = this.firstMetric(row, [/status/i, /response.*code/i]);
      if (status !== undefined && status >= 400) {
        failedRequests++;
      }

      transferredBytes += this.sumMatchingMetrics(row, [/bytes/i, /body.*size/i]);

      const url = this.firstString(row, [/url/i, /host/i, /domain/i]);
      const host = this.hostFromURL(url);
      if (host) {
        hosts.set(host, (hosts.get(host) ?? 0) + 1);
      }
    }

    const metrics: InstrumentMetric[] = [
      { name: 'Requests', value: requests, numericValue: requests },
      { name: 'Failed Requests', value: failedRequests, numericValue: failedRequests },
      {
        name: 'Transferred Bytes',
        value: this.formatBytes(transferredBytes),
        numericValue: transferredBytes,
        unit: 'bytes',
      },
    ];

    const topHost = this.topMapEntry(hosts);
    if (topHost) {
      metrics.push({ name: 'Top Host', value: `${topHost[0]} (${topHost[1]} requests)`, numericValue: topHost[1] });
    }

    if (failedRequests > 0) {
      findings.push({
        severity: 'medium',
        title: 'Network failures detected',
        description: `${failedRequests} request${failedRequests === 1 ? '' : 's'} returned an error status.`,
      });
    }

    return {
      kind: 'network',
      title: 'Network Analysis',
      summary: `${requests} request${requests === 1 ? '' : 's'}, ${failedRequests} failed.`,
      metrics,
      findings,
      sourceSchemas,
    };
  }

  private analyzeNetworkHAR(har: any, sourceSchemas: string[]): InstrumentAnalysis | undefined {
    const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
    if (entries.length === 0) {
      return undefined;
    }

    const rows: TableRow[] = entries.map((entry: any) => ({
      URL: entry?.request?.url ?? '',
      Status: Number(entry?.response?.status ?? 0),
      'Request Bytes': Number(entry?.request?.bodySize ?? 0),
      'Response Bytes': Number(entry?.response?.bodySize ?? 0),
    }));

    return this.analyzeNetworkRows(rows, sourceSchemas);
  }

  private analyzeEnergyRows(rows: TableRow[], sourceSchemas: string[]): InstrumentAnalysis {
    const metrics: InstrumentMetric[] = [];
    const findings: InstrumentFinding[] = this.unexportableFinding(rows, 'Energy');
    const impact = this.maxMetric(rows, [/energy.*impact/i, /^impact$/i, /score/i]);
    const wakeups = this.maxMetric(rows, [/wakeups?/i]);
    const cpu = this.maxMetric(rows, [/cpu.*time/i, /^cpu$/i]);

    this.pushNumberMetric(metrics, 'Energy Impact', impact);
    this.pushNumberMetric(metrics, 'Wakeups', wakeups);
    this.pushNumberMetric(metrics, 'CPU Time', cpu, 'seconds');

    if ((impact ?? 0) >= 50) {
      findings.push({
        severity: 'high',
        title: 'High energy impact',
        description: 'Energy impact is elevated. Reduce background work, polling, wakeups, and expensive networking.',
      });
    }

    return {
      kind: 'energy',
      title: 'Energy Analysis',
      summary: impact ? `Energy impact peaked at ${impact}.` : 'Energy data was found.',
      metrics,
      findings,
      sourceSchemas,
    };
  }

  private extractSchemas(tocData: any): string[] {
    const schemas = new Set<string>();

    const visit = (node: any) => {
      if (!node || typeof node !== 'object') {
        return;
      }

      if (typeof node['@_schema'] === 'string') {
        schemas.add(node['@_schema']);
      }

      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          value.forEach(visit);
        } else {
          visit(value);
        }
      }
    };

    visit(tocData);
    return Array.from(schemas);
  }

  private extractUserProcessNames(tocData: any): string[] {
    const names = new Set<string>();

    const visit = (node: any, keyName?: string, attachedTarget = false) => {
      if (!node || typeof node !== 'object') {
        return;
      }

      const currentAttached = attachedTarget || this.isAttachedTargetNode(keyName, node);
      if (keyName === 'process') {
        const path = this.processPath(node);
        const name = this.processNameFromNode(node, path);
        if (name && (currentAttached || !this.isSystemProcessPath(path))) {
          names.add(name);
        }
      }

      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('@_')) {
          continue;
        }
        for (const child of this.arrayOf(value)) {
          visit(child, key, currentAttached);
        }
      }
    };

    visit(tocData);
    return Array.from(names);
  }

  private isAttachedTargetNode(keyName: string | undefined, node: any): boolean {
    if (keyName !== 'target') {
      return false;
    }
    const type = node?.['@_type'] ?? node?.type;
    return typeof type === 'string' && type.toLowerCase() === 'attached';
  }

  private processPath(node: any): string | undefined {
    const path = node?.['@_path'] ?? node?.path ?? node?.executablePath;
    return typeof path === 'string' && path.length > 0 ? path : undefined;
  }

  private processNameFromNode(node: any, path?: string): string | undefined {
    const rawName = this.nodeName(node) ?? this.readFmtField(node);
    if (rawName) {
      return rawName;
    }
    if (!path) {
      return undefined;
    }
    return basename(path).replace(/\.(app|xpc|appex|framework)$/i, '') || undefined;
  }

  private isSystemProcessPath(path?: string): boolean {
    if (!path) {
      return false;
    }
    return path.startsWith('/System/') ||
      path.startsWith('/usr/lib/') ||
      path.startsWith('/usr/libexec/');
  }

  private extractTableDescriptors(tocData: any): TraceTableDescriptor[] {
    const descriptors: TraceTableDescriptor[] = [];
    const seen = new Set<string>();
    const runs = this.arrayOf(tocData['trace-toc']?.run);

    const addDescriptor = (
      node: any,
      runNumber: number,
      xpath: string,
      trackName?: string,
      detailName?: string
    ) => {
      const schema = node?.['@_schema'];
      if (typeof schema !== 'string' || !schema) {
        return;
      }
      const key = `${runNumber}:${schema}:${xpath}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      descriptors.push({
        runNumber,
        schema,
        xpath,
        trackName,
        detailName,
      });
    };

    const visit = (
      node: any,
      runNumber: number,
      path: string,
      trackName?: string,
      detailName?: string
    ) => {
      if (!node || typeof node !== 'object') {
        return;
      }

      addDescriptor(node, runNumber, path, trackName, detailName);

      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('@_')) {
          continue;
        }
        for (const child of this.arrayOf(value)) {
          if (!child || typeof child !== 'object') {
            continue;
          }
          const childTrackName = key === 'track'
            ? this.nodeName(child) ?? trackName
            : trackName;
          const childDetailName = key === 'detail'
            ? this.nodeName(child) ?? detailName
            : detailName;
          visit(
            child,
            runNumber,
            `${path}/${this.xpathSegment(key, child)}`,
            childTrackName,
            childDetailName
          );
        }
      }
    };

    runs.forEach((run, index) => {
      const runNumber = this.parseNumeric(run?.['@_number']) ?? index + 1;
      visit(run, runNumber, `/trace-toc/run[@number="${runNumber}"]`);
    });

    return descriptors;
  }

  private unexportableFinding(rows: TableRow[], title: string): InstrumentFinding[] {
    if (rows.length === 0 || rows.every((row) => row.Exportable === false)) {
      return [
        {
          severity: 'low',
          title: `No exportable ${title} rows`,
          description: `xctrace exposed a ${title.toLowerCase()} table schema, but did not export usable rows for this trace.`,
        },
      ];
    }
    return [];
  }

  private matchSchemasForKind(schemas: string[], kind: InstrumentKind): string[] {
    const patterns = SCHEMA_PATTERNS[kind];
    return schemas.filter((schema) => patterns.some((pattern) => pattern.test(schema)));
  }

  private async exportRowsForSchemas(
    tracePath: string,
    schemas: string[],
    tableDescriptors: TraceTableDescriptor[],
    kind: Exclude<TraceKind, 'time-profile'>
  ): Promise<TableRow[]> {
    const rows: TableRow[] = [];

    for (const schema of schemas) {
      const descriptor = tableDescriptors.find((table) => table.schema === schema);
      const xpath = descriptor?.xpath;
      try {
        const xml = xpath && this.exporter.exportXPath
          ? await this.exporter.exportXPath(tracePath, xpath)
          : await this.exporter.exportTable(tracePath, schema, descriptor?.runNumber);
        const parsedRows = this.parseTableRows(xml);
        this.exportAttempts.push({
          kind,
          status: parsedRows.length > 0 ? 'success' : 'empty',
          schema,
          xpath,
        });
        rows.push(...parsedRows);
      } catch (error) {
        this.exportAttempts.push({
          kind,
          status: 'failed',
          schema,
          xpath,
          message: (error as Error).message,
        });
        rows.push({
          Schema: schema,
          Exportable: false,
        });
      }
    }

    return rows;
  }

  private networkSchemasSafeForRawExport(schemas: string[]): string[] {
    return schemas.filter((schema) =>
      !NETWORK_RAW_EXPORT_DENY_PATTERNS.some((pattern) => pattern.test(schema))
    );
  }

  private unexportedRowsForSchemas(schemas: string[]): TableRow[] {
    return schemas.map((schema) => ({
      Schema: schema,
      Exportable: false,
    }));
  }

  private parseTableRows(xmlData: string): TableRow[] {
    if (!xmlData || !xmlData.trim()) {
      return [];
    }

    const parsed = this.xmlParser.parse(xmlData);
    const table =
      parsed.table ?? parsed['trace-query-result']?.node ?? this.findFirstKey(parsed, 'table');
    if (!table) {
      return [];
    }

    return this.rowsFromTableNode(table).map((row) => this.flattenRow(row));
  }

  private rowsFromTableNode(table: any): any[] {
    const nodes = Array.isArray(table) ? table : [table];
    return nodes.flatMap((node) => {
      if (node?.row) {
        return Array.isArray(node.row) ? node.row : [node.row];
      }
      if (node?.table) {
        return this.rowsFromTableNode(node.table);
      }
      return [];
    });
  }

  private flattenRow(row: any): TableRow {
    const output: TableRow = {};

    const write = (key: string | undefined, value: any) => {
      if (!key || value === undefined || value === null || value === '') {
        return;
      }
      output[this.cleanKey(key)] = this.parseScalar(value);
    };

    const visitCell = (cell: any, fallbackKey?: string) => {
      if (cell === undefined || cell === null) {
        return;
      }
      if (typeof cell !== 'object') {
        write(fallbackKey, cell);
        return;
      }

      const name = cell['@_name'] ?? cell['@_key'] ?? cell['@_title'] ?? cell.name ?? cell.key ?? fallbackKey;
      const value = cell['@_value'] ?? cell.value ?? cell['#text'] ?? cell.text;
      if (value !== undefined) {
        write(String(name), value);
        return;
      }

      for (const [childKey, childValue] of Object.entries(cell)) {
        if (childKey.startsWith('@_')) {
          continue;
        }
        this.writeNestedValue(write, childKey, childValue);
      }
    };

    for (const [key, value] of Object.entries(row ?? {})) {
      if (key.startsWith('@_')) {
        write(key.slice(2), value);
      } else if (['column', 'cell', 'col', 'data'].includes(key)) {
        const cells = Array.isArray(value) ? value : [value];
        cells.forEach((cell) => visitCell(cell));
      } else {
        this.writeNestedValue(write, key, value);
      }
    }

    return output;
  }

  private writeNestedValue(
    write: (key: string | undefined, value: any) => void,
    key: string,
    value: any
  ): void {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item && typeof item === 'object') {
          const name = item['@_name'] ?? item['@_key'] ?? item.name ?? key;
          const nested = item['@_value'] ?? item.value ?? item['#text'] ?? item.text;
          write(String(name), nested);
        } else {
          write(key, item);
        }
      });
      return;
    }

    if (value && typeof value === 'object') {
      const name = value['@_name'] ?? value['@_key'] ?? value.name ?? key;
      const nested = value['@_value'] ?? value.value ?? value['#text'] ?? value.text;
      if (nested !== undefined) {
        write(String(name), nested);
      }
      return;
    }

    write(key, value);
  }

  private findFirstKey(node: any, key: string): any | undefined {
    if (!node || typeof node !== 'object') {
      return undefined;
    }
    if (node[key]) {
      return node[key];
    }
    for (const value of Object.values(node)) {
      const found = this.findFirstKey(value, key);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private cleanKey(key: string): string {
    return key.replace(/^@_/, '').trim();
  }

  private arrayOf<T>(value: T | T[] | undefined | null): T[] {
    if (value === undefined || value === null) {
      return [];
    }
    return Array.isArray(value) ? value : [value];
  }

  private nodeName(node: any): string | undefined {
    const name = node?.['@_name'] ?? node?.name ?? node?.['@_title'] ?? node?.title;
    return typeof name === 'string' && name ? name : undefined;
  }

  private xpathSegment(key: string, node: any): string {
    const schema = node?.['@_schema'];
    if (typeof schema === 'string' && schema) {
      return `${key}[@schema="${schema}"]`;
    }

    const name = this.nodeName(node);
    if (name) {
      return `${key}[@name="${name}"]`;
    }

    return key;
  }

  private parseScalar(value: any): string | number | boolean {
    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    const stringValue = String(value).trim();
    const numeric = this.parseNumeric(stringValue);
    return numeric ?? stringValue;
  }

  private parseNumeric(value: string | number | boolean | undefined): number | undefined {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim().replace(/,/g, '');
    const match = normalized.match(/^(-?\d+(?:\.\d+)?)(?:\s*([a-zA-Z%][a-zA-Z%/]*))?$/);
    if (!match) {
      return undefined;
    }

    const number = Number(match[1]);
    if (!Number.isFinite(number)) {
      return undefined;
    }

    const unit = match[2]?.toLowerCase();
    if (!unit) {
      return number;
    }

    const byteMultiplier = BYTE_UNIT_MULTIPLIERS[unit];
    if (byteMultiplier !== undefined) {
      return number * byteMultiplier;
    }

    if (!NUMERIC_UNITS.has(unit)) {
      return undefined;
    }

    return number;
  }

  private maxMetric(rows: TableRow[], patterns: RegExp[]): number | undefined {
    const values = rows.flatMap((row) => {
      const value = this.firstMetric(row, patterns);
      return value === undefined ? [] : [value];
    });

    return values.length > 0 ? Math.max(...values) : undefined;
  }

  private firstMetric(row: TableRow, patterns: RegExp[]): number | undefined {
    for (const [key, value] of Object.entries(row)) {
      if (patterns.some((pattern) => pattern.test(key))) {
        const numeric = this.parseNumeric(value);
        if (numeric !== undefined) {
          return numeric;
        }
      }
    }
    return undefined;
  }

  private firstString(row: TableRow, patterns: RegExp[]): string | undefined {
    for (const [key, value] of Object.entries(row)) {
      if (patterns.some((pattern) => pattern.test(key)) && typeof value === 'string') {
        return value;
      }
    }
    return undefined;
  }

  private sumMatchingMetrics(row: TableRow, patterns: RegExp[]): number {
    return Object.entries(row).reduce((sum, [key, value]) => {
      if (!patterns.some((pattern) => pattern.test(key))) {
        return sum;
      }
      return sum + (this.parseNumeric(value) ?? 0);
    }, 0);
  }

  private pushByteMetric(metrics: InstrumentMetric[], name: string, bytes?: number): void {
    if (bytes === undefined) {
      return;
    }
    metrics.push({
      name,
      value: this.formatBytes(bytes),
      numericValue: bytes,
      unit: 'bytes',
    });
  }

  private pushNumberMetric(
    metrics: InstrumentMetric[],
    name: string,
    value?: number,
    unit?: string
  ): void {
    if (value === undefined) {
      return;
    }
    metrics.push({
      name,
      value,
      numericValue: value,
      unit,
    });
  }

  private topRowByBytes(rows: TableRow[]): { label?: string; bytes?: number } {
    let best: { label?: string; bytes?: number } = {};

    for (const row of rows) {
      const bytes = this.firstMetric(row, [/bytes/i, /size/i]);
      if (bytes === undefined || bytes <= (best.bytes ?? 0)) {
        continue;
      }
      const label = this.firstString(row, [/type/i, /call.*site/i, /symbol/i, /name/i]);
      best = { label, bytes };
    }

    return best;
  }

  private topMapEntry(map: Map<string, number>): [string, number] | undefined {
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])[0];
  }

  private hostFromURL(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }
    try {
      return new URL(value).host;
    } catch {
      return value.includes('.') ? value : undefined;
    }
  }

  private formatBytes(bytes: number): string {
    const abs = Math.abs(bytes);
    if (abs >= 1024 * 1024 * 1024) {
      return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    }
    if (abs >= 1024 * 1024) {
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
    if (abs >= 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${bytes} B`;
  }

  /**
   * Parse a single sample row from XML
   */
  private parseSampleRow(row: any): Sample | null {
    try {
      const timestamp = this.parseSampleTimestamp(row);
      const threadId = this.parseSampleThreadId(row);
      const weight = this.parseSampleWeight(row);

      // Parse backtrace
      const backtrace: string[] = [];
      const backtraceNode = row.backtrace ?? row['tagged-backtrace']?.backtrace;
      if (backtraceNode) {
        const frames = Array.isArray(backtraceNode.frame)
          ? backtraceNode.frame
          : [backtraceNode.frame];

        for (const frame of frames) {
          if (frame && frame['@_name']) {
            backtrace.push(String(frame['@_name']));
          } else if (frame && typeof frame === 'string') {
            backtrace.push(frame);
          }
        }
      }

      return {
        timestamp,
        threadId,
        backtrace,
        weight,
      };
    } catch {
      return null;
    }
  }

  private parseSampleTimestamp(row: any): number {
    const value = row['@_time'] ?? row.time ?? row['sample-time'];
    const raw = this.nodeScalar(value);
    const numeric = this.parseNumeric(raw);
    if (numeric === undefined) {
      return 0;
    }

    // xctrace sample-time text values are nanoseconds; older fixtures use ms.
    return numeric > 100000 ? numeric / 1000000 : numeric;
  }

  private parseSampleThreadId(row: any): number {
    const value = row['@_thread'] ?? row.thread?.tid ?? row.thread;
    return this.parseNumeric(this.nodeScalar(value)) ?? 0;
  }

  private parseSampleWeight(row: any): number {
    const value = row['@_weight'] ?? row.weight;
    if (value && typeof value === 'object' && typeof value['@_fmt'] === 'string') {
      return this.parseDuration(value['@_fmt']);
    }

    const numeric = this.parseNumeric(this.nodeScalar(value));
    if (numeric === undefined) {
      return 1;
    }

    // xctrace weight text values are nanoseconds; older fixtures use ms.
    return numeric > 100000 ? numeric / 1000000 : numeric;
  }

  private nodeScalar(value: any): string | number | boolean | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== 'object') {
      return value;
    }
    return value['#text'] ?? value['@_value'] ?? value.value ?? value.text ?? value['@_fmt'];
  }

  /**
   * Aggregate function profiles from samples
   */
  private aggregateFunctionProfiles(
    sample: Sample,
    functionMap: Map<string, FunctionProfile>
  ): void {
    // Process each function in the backtrace
    for (let i = 0; i < sample.backtrace.length; i++) {
      const funcName = sample.backtrace[i];
      if (typeof funcName !== 'string' || funcName.trim() === '') {
        continue;
      }

      // Parse function name and module
      const { name, module } = this.parseFunctionName(funcName);
      const key = `${module || 'unknown'}::${name}`;

      let profile = functionMap.get(key);
      if (!profile) {
        profile = {
          name,
          module,
          totalTime: 0,
          selfTime: 0,
          callCount: 0,
          percentage: 0,
        };
        functionMap.set(key, profile);
      }

      // Add sample weight to total time
      profile.totalTime += sample.weight;
      profile.callCount += 1;

      // Self time is only for leaf nodes (last in backtrace)
      if (i === sample.backtrace.length - 1) {
        profile.selfTime += sample.weight;
      }
    }
  }

  /**
   * Parse function name to extract module and function
   */
  private parseFunctionName(fullName: string): { name: string; module?: string } {
    // Format can be: "ModuleName`functionName" or just "functionName"
    const backtickIndex = fullName.indexOf('`');
    if (backtickIndex > 0) {
      return {
        module: fullName.substring(0, backtickIndex),
        name: fullName.substring(backtickIndex + 1),
      };
    }

    // Check for other separators
    const colonIndex = fullName.indexOf('::');
    if (colonIndex > 0) {
      return {
        module: fullName.substring(0, colonIndex),
        name: fullName.substring(colonIndex + 2),
      };
    }

    return { name: fullName };
  }

  /**
   * Parse duration string to milliseconds
   */
  private parseDuration(duration: string | number): number {
    if (typeof duration === 'number') {
      return duration;
    }

    // Try to parse various duration formats
    const match = duration.match(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)?/);
    if (match) {
      const value = parseFloat(match[1]);
      const unit = match[2] || 's';

      switch (unit) {
        case 'ms':
          return value;
        case 's':
          return value * 1000;
        case 'm':
          return value * 60 * 1000;
        case 'h':
          return value * 60 * 60 * 1000;
      }
    }

    return 0;
  }
}

/**
 * Convenience function to parse a trace
 */
export async function parseTrace(
  tracePath: string,
  options?: TraceParserOptions
): Promise<ParsedTrace> {
  const parser = new TraceParser();
  return parser.parseTrace(tracePath, options);
}

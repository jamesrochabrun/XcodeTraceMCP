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
} from '../types.js';
import { exportHAR, exportTable, exportTOC } from '../utils/xctrace-runner.js';

export interface TraceExporter {
  exportTOC(tracePath: string): Promise<string>;
  exportTable(tracePath: string, schema: string, runNumber?: number): Promise<string>;
  exportHAR?(tracePath: string): Promise<string>;
}

const defaultExporter: TraceExporter = {
  exportTOC,
  exportTable,
  exportHAR,
};

type TableRow = Record<string, string | number | boolean>;

const INSTRUMENT_ORDER: Exclude<TraceKind, 'time-profile'>[] = [
  'memory',
  'network',
  'energy',
  'allocations',
  'leaks',
];

const SCHEMA_PATTERNS: Record<Exclude<TraceKind, 'time-profile'>, RegExp[]> = {
  memory: [/memory/i, /resident/i, /dirty/i, /vm/i],
  network: [/network/i, /connection/i, /http/i, /url/i],
  energy: [/energy/i, /power/i, /wakeups?/i, /battery/i],
  allocations: [/alloc/i, /malloc/i],
  leaks: [/leaks?/i],
};

const NETWORK_RAW_EXPORT_DENY_PATTERNS = [
  /cfnetwork/i,
  /drawables?/i,
  /intervals?/i,
  /aggregation/i,
  /harlogging/i,
];

/**
 * Main parser class for Xcode Instruments traces
 */
export class TraceParser {
  private xmlParser: XMLParser;
  private exporter: TraceExporter;

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
  async parseTrace(tracePath: string): Promise<ParsedTrace> {
    try {
      // Validate trace file exists
      await this.validateTraceFile(tracePath);

      // Get metadata and table schemas
      const { metadata, schemas } = await this.extractMetadataAndSchemas(tracePath);

      // Parse time profile data
      const timeProfile = await this.parseTimeProfile(tracePath);
      const instrumentAnalyses = await this.parseInstrumentAnalyses(tracePath, schemas);

      return {
        metadata,
        timeProfile,
        instrumentAnalyses,
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
  ): Promise<{ metadata: TraceMetadata; schemas: string[] }> {
    try {
      const tocXML = await this.exporter.exportTOC(tracePath);
      const tocData = this.xmlParser.parse(tocXML);
      const schemas = this.extractSchemas(tocData);

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

      return { metadata, schemas };
    } catch (error) {
      // Return minimal metadata if we can't parse TOC
      return {
        metadata: {
          fileName: basename(tracePath),
          filePath: tracePath,
          duration: 0,
          template: 'Unknown',
        },
        schemas: [],
      };
    }
  }

  /**
   * Parse Time Profiler data from trace
   */
  private async parseTimeProfile(tracePath: string): Promise<TimeProfileData | undefined> {
    try {
      const xmlData = await this.exporter.exportTable(tracePath, 'time-profile');

      if (!xmlData || xmlData.trim() === '') {
        // No time profile data available
        return undefined;
      }

      const parsed = this.xmlParser.parse(xmlData);

      // Extract table data. Recent xctrace versions wrap XPath exports in
      // trace-query-result/node instead of returning a bare table element.
      const table = parsed.table ?? parsed['trace-query-result']?.node;
      if (!table) {
        return undefined;
      }

      // Parse rows into samples and function profiles
      const samples: Sample[] = [];
      const functionMap = new Map<string, FunctionProfile>();

      // Parse table rows
      const rows = this.rowsFromTableNode(table);

      for (const row of rows) {
        if (!row) continue;

        // Extract sample data
        const sample = this.parseSampleRow(row);
        if (sample) {
          samples.push(sample);

          // Aggregate function profiles
          this.aggregateFunctionProfiles(sample, functionMap);
        }
      }

      // Convert function map to sorted array
      const functionProfiles = Array.from(functionMap.values())
        .sort((a, b) => b.totalTime - a.totalTime);

      // Calculate total duration from samples
      const totalDuration = samples.length > 0
        ? Math.max(...samples.map(s => s.timestamp))
        : 0;

      return {
        totalDuration,
        samples,
        functionProfiles,
      };
    } catch (error) {
      console.warn('Failed to parse time profile data:', error);
      return undefined;
    }
  }

  /**
   * Parse supported non-Time-Profiler instrument data.
   */
  private async parseInstrumentAnalyses(
    tracePath: string,
    schemas: string[]
  ): Promise<InstrumentAnalysis[]> {
    const analyses: InstrumentAnalysis[] = [];

    for (const kind of INSTRUMENT_ORDER) {
      const matchingSchemas = this.matchSchemasForKind(schemas, kind);
      if (kind === 'network') {
        const network = await this.parseNetworkAnalysis(tracePath, matchingSchemas);
        if (network) {
          analyses.push(network);
        }
        continue;
      }

      if (matchingSchemas.length === 0) {
        continue;
      }

      const rows = await this.exportRowsForSchemas(tracePath, matchingSchemas);
      const analysis = this.analyzeRowsForKind(kind, rows, matchingSchemas);
      if (analysis) {
        analyses.push(analysis);
      }
    }

    return analyses;
  }

  private async parseNetworkAnalysis(
    tracePath: string,
    matchingSchemas: string[]
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

    const rows = await this.exportRowsForSchemas(tracePath, exportableSchemas);
    rows.push(...this.unexportedRowsForSchemas(
      matchingSchemas.filter((schema) => !exportableSchemas.includes(schema))
    ));
    return this.analyzeRowsForKind('network', rows, matchingSchemas);
  }

  private async tryExportHAR(tracePath: string): Promise<any | undefined> {
    if (!this.exporter.exportHAR) {
      return undefined;
    }

    try {
      const har = await this.exporter.exportHAR(tracePath);
      if (!har || !har.trim()) {
        return undefined;
      }
      return JSON.parse(har);
    } catch {
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

  private matchSchemasForKind(
    schemas: string[],
    kind: Exclude<TraceKind, 'time-profile'>
  ): string[] {
    const patterns = SCHEMA_PATTERNS[kind];
    return schemas.filter((schema) => patterns.some((pattern) => pattern.test(schema)));
  }

  private async exportRowsForSchemas(tracePath: string, schemas: string[]): Promise<TableRow[]> {
    const rows: TableRow[] = [];

    for (const schema of schemas) {
      try {
        const xml = await this.exporter.exportTable(tracePath, schema);
        rows.push(...this.parseTableRows(xml));
      } catch {
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
    const table = parsed.table ?? this.findFirstKey(parsed, 'table');
    if (!table) {
      return [];
    }

    const rows: any[] = Array.isArray(table.row) ? table.row : [table.row].filter(Boolean);
    return rows.map((row) => this.flattenRow(row));
  }

  private rowsFromTableNode(table: any): any[] {
    const nodes = Array.isArray(table) ? table : [table];
    return nodes.flatMap((node) => {
      if (!node?.row) {
        return [];
      }
      return Array.isArray(node.row) ? node.row : [node.row];
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

    const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!match) {
      return undefined;
    }

    const number = Number(match[0]);
    if (!Number.isFinite(number)) {
      return undefined;
    }

    const lower = value.toLowerCase();
    if (/\bgb\b/.test(lower)) {
      return number * 1024 * 1024 * 1024;
    }
    if (/\bmb\b/.test(lower)) {
      return number * 1024 * 1024;
    }
    if (/\bkb\b/.test(lower)) {
      return number * 1024;
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
export async function parseTrace(tracePath: string): Promise<ParsedTrace> {
  const parser = new TraceParser();
  return parser.parseTrace(tracePath);
}

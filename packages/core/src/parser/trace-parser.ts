/**
 * TraceParser - Parses Xcode Instruments trace files
 */

import { XMLParser } from 'fast-xml-parser';
import { readFile, stat } from 'fs/promises';
import { basename } from 'path';
import {
  ParsedTrace,
  TraceMetadata,
  TimeProfileData,
  FunctionProfile,
  Sample,
  TraceParserError,
} from '../types.js';
import { exportTable, exportTOC } from '../utils/xctrace-runner.js';

/**
 * Main parser class for Xcode Instruments traces
 */
export class TraceParser {
  private xmlParser: XMLParser;

  constructor() {
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

      // Get metadata
      const metadata = await this.extractMetadata(tracePath);

      // Parse time profile data
      const timeProfile = await this.parseTimeProfile(tracePath);

      return {
        metadata,
        timeProfile,
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
  private async extractMetadata(tracePath: string): Promise<TraceMetadata> {
    try {
      const tocXML = await exportTOC(tracePath);
      const tocData = this.xmlParser.parse(tocXML);

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

      return metadata;
    } catch (error) {
      // Return minimal metadata if we can't parse TOC
      return {
        fileName: basename(tracePath),
        filePath: tracePath,
        duration: 0,
        template: 'Unknown',
      };
    }
  }

  /**
   * Parse Time Profiler data from trace
   */
  private async parseTimeProfile(tracePath: string): Promise<TimeProfileData | undefined> {
    try {
      const xmlData = await exportTable(tracePath, 'time-profile');

      if (!xmlData || xmlData.trim() === '') {
        // No time profile data available
        return undefined;
      }

      const parsed = this.xmlParser.parse(xmlData);

      // Extract table data
      const table = parsed.table;
      if (!table) {
        return undefined;
      }

      // Parse rows into samples and function profiles
      const samples: Sample[] = [];
      const functionMap = new Map<string, FunctionProfile>();

      // Parse table rows
      const rows = Array.isArray(table.row) ? table.row : [table.row];

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
   * Parse a single sample row from XML
   */
  private parseSampleRow(row: any): Sample | null {
    try {
      // Extract timestamp, thread, and backtrace
      // The exact structure depends on xctrace output format
      const timestamp = row['@_time'] || row.time || 0;
      const threadId = row['@_thread'] || row.thread || 0;
      const weight = row['@_weight'] || row.weight || 1;

      // Parse backtrace
      const backtrace: string[] = [];
      if (row.backtrace) {
        const frames = Array.isArray(row.backtrace.frame)
          ? row.backtrace.frame
          : [row.backtrace.frame];

        for (const frame of frames) {
          if (frame && frame['@_name']) {
            backtrace.push(frame['@_name']);
          } else if (frame && typeof frame === 'string') {
            backtrace.push(frame);
          }
        }
      }

      return {
        timestamp: Number(timestamp),
        threadId: Number(threadId),
        backtrace,
        weight: Number(weight),
      };
    } catch {
      return null;
    }
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

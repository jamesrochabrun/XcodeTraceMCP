/**
 * Utility for running xctrace commands
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { XCTraceError } from '../types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const EXPORT_TOC_TIMEOUT_MS = 10_000;
const EXPORT_TABLE_TIMEOUT_MS = 5_000;
const EXPORT_HAR_TIMEOUT_MS = 5_000;

async function runXcrun(args: string[], timeout?: number): Promise<string> {
  const { stdout } = await execFileAsync('xcrun', args, {
    maxBuffer: DEFAULT_MAX_BUFFER,
    timeout: timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return stdout.trimEnd();
}

function processErrorOutput(error: any): string {
  const output = [error.stdout, error.stderr]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n')
    .trim();

  return output || error.message || '';
}

/**
 * Check if xctrace is available on the system
 */
export async function isXCTraceAvailable(): Promise<boolean> {
  try {
    await runXcrun(['xctrace', 'version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get xctrace version
 */
export async function getXCTraceVersion(): Promise<string> {
  try {
    return (await runXcrun(['xctrace', 'version'])).trim();
  } catch (error) {
    throw new XCTraceError('Failed to get xctrace version', (error as any).code, (error as any).stderr);
  }
}

/**
 * Export table of contents from a trace file
 */
export async function exportTOC(tracePath: string): Promise<string> {
  try {
    return await runXcrun(['xctrace', 'export', '--input', tracePath, '--toc'], EXPORT_TOC_TIMEOUT_MS);
  } catch (error: any) {
    throw new XCTraceError(
      `Failed to export TOC from trace: ${tracePath}`,
      error.code,
      error.stderr
    );
  }
}

/**
 * Export specific data table from trace using XPath
 */
export async function exportTable(
  tracePath: string,
  schema: string,
  runNumber: number = 1
): Promise<string> {
  try {
    const xpath = `/trace-toc/run[@number="${runNumber}"]/data/table[@schema="${schema}"]`;
    return await runXcrun(
      ['xctrace', 'export', '--input', tracePath, '--xpath', xpath],
      EXPORT_TABLE_TIMEOUT_MS
    );
  } catch (error: any) {
    throw new XCTraceError(
      `Failed to export table '${schema}' from trace: ${tracePath}`,
      error.code,
      error.stderr
    );
  }
}

/**
 * Export network data as HTTP Archive, when xctrace supports it for the trace.
 */
export async function exportHAR(tracePath: string): Promise<string> {
  try {
    return await runXcrun(['xctrace', 'export', '--input', tracePath, '--har'], EXPORT_HAR_TIMEOUT_MS);
  } catch (error: any) {
    throw new XCTraceError(
      `Failed to export HAR from trace: ${tracePath}`,
      error.code,
      error.stderr
    );
  }
}

/**
 * List available Instruments templates
 */
export async function listTemplates(): Promise<string[]> {
  try {
    const stdout = await runXcrun(['xctrace', 'list', 'templates']);
    // Parse template names from output
    const lines = stdout.split('\n').filter(line => line.trim());
    return lines.map(line => line.trim()).filter(line => line && !line.startsWith('=='));
  } catch (error: any) {
    throw new XCTraceError('Failed to list templates', error.code, error.stderr);
  }
}

/**
 * List available devices
 */
export async function listDevices(): Promise<string[]> {
  try {
    const stdout = await runXcrun(['xctrace', 'list', 'devices']);
    const lines = stdout.split('\n').filter(line => line.trim());
    return lines.map(line => line.trim()).filter(line => line && !line.startsWith('=='));
  } catch (error: any) {
    throw new XCTraceError('Failed to list devices', error.code, error.stderr);
  }
}

/**
 * Record a new trace (simplified interface)
 */
export interface RecordOptions {
  template: string;
  instruments?: string[];
  device?: string;
  appIdentifier?: string;
  processName?: string;
  allProcesses?: boolean;
  duration?: number; // seconds
  outputPath: string;
  noPrompt?: boolean;
}

export function buildRecordTraceArgs(options: RecordOptions): string[] {
  if (!options.processName && !options.appIdentifier && !options.allProcesses) {
    throw new XCTraceError('Recording requires processName, appIdentifier, or allProcesses');
  }

  const args = [
    'xctrace',
    'record',
    '--template',
    options.template,
  ];

  for (const instrument of options.instruments ?? []) {
    args.push('--instrument', instrument);
  }

  if (options.processName) {
    args.push('--attach', options.processName);
  } else if (options.allProcesses) {
    args.push('--all-processes');
  } else if (options.appIdentifier) {
    args.push('--launch', '--', options.appIdentifier);
  }

  if (options.device) {
    args.push('--device', options.device);
  }

  if (options.duration) {
    args.push('--time-limit', `${options.duration}s`);
  }

  args.push('--output', options.outputPath);

  if (options.noPrompt !== false) {
    args.push('--no-prompt');
  }

  return args;
}

export async function recordTrace(options: RecordOptions): Promise<void> {
  const args = buildRecordTraceArgs(options);

  try {
    await runXcrun(args, (options.duration || 30) * 1000 + 30000);
  } catch (error: any) {
    const details = processErrorOutput(error);
    throw new XCTraceError(
      [
        `Failed to record trace for ${options.processName ?? options.appIdentifier ?? 'all processes'}`,
        details,
      ].filter(Boolean).join(': '),
      error.code,
      details
    );
  }
}

/**
 * Utility for running xctrace commands
 */

import { execFile } from 'child_process';
import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { XCTraceCapabilities, XCTraceError } from '../types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const EXPORT_TOC_TIMEOUT_MS = 10_000;
const EXPORT_TABLE_TIMEOUT_MS = 5_000;
const EXPORT_HAR_TIMEOUT_MS = 5_000;
const SYMBOLICATE_TIMEOUT_MS = 60_000;

async function runXcrun(args: string[], timeout?: number): Promise<string> {
  const { stdout } = await execFileAsync('xcrun', args, {
    maxBuffer: DEFAULT_MAX_BUFFER,
    timeout: timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return stdout.trimEnd();
}

async function runXcrunWithOutputFile(
  args: string[],
  extension: string,
  timeout?: number
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'xctrace-export-'));
  const outputPath = join(tempDir, `export.${extension}`);

  try {
    await execFileAsync('xcrun', [...args, '--output', outputPath], {
      maxBuffer: 1024 * 1024,
      timeout: timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return (await readFile(outputPath, 'utf8')).trimEnd();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runXcrunWithOutputDirectory(
  args: string[],
  extension: string,
  timeout?: number
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'xctrace-export-'));

  try {
    await execFileAsync('xcrun', [...args, '--output', tempDir], {
      maxBuffer: 1024 * 1024,
      timeout: timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    const files = await readdir(tempDir);
    const outputFile = files.find((file) => file.endsWith(`.${extension}`));
    if (!outputFile) {
      return '';
    }
    return (await readFile(join(tempDir, outputFile), 'utf8')).trimEnd();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function processErrorOutput(error: any): string {
  const output = [error.stdout, error.stderr]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n')
    .trim();

  return output || error.message || '';
}

function parseListOutput(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      line &&
      !line.startsWith('==') &&
      line !== 'No instruments found' &&
      !line.includes(' ERROR ') &&
      !line.includes(' WARN ') &&
      !line.startsWith('(kernel)') &&
      !line.startsWith('Failed to ')
    );
}

async function listXctraceValues(kind: 'templates' | 'devices' | 'instruments'): Promise<string[]> {
  const stdout = await runXcrun(['xctrace', 'list', kind]);
  return parseListOutput(stdout);
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
 * Best-effort capability snapshot for the local xctrace installation.
 */
export async function getXCTraceCapabilities(): Promise<XCTraceCapabilities> {
  const warnings: string[] = [];

  try {
    const version = await getXCTraceVersion();
    const [templates, devices, instruments] = await Promise.all([
      listTemplates().catch((error) => {
        warnings.push(`Failed to list templates: ${(error as Error).message}`);
        return [];
      }),
      listDevices().catch((error) => {
        warnings.push(`Failed to list devices: ${(error as Error).message}`);
        return [];
      }),
      listInstruments().catch((error) => {
        warnings.push(`Failed to list instruments: ${(error as Error).message}`);
        return [];
      }),
    ]);

    return {
      available: true,
      version,
      templates,
      devices,
      instruments,
      exportModes: ['toc', 'xpath', 'har'],
      recordModes: ['attach', 'launch', 'all-processes'],
      supportsSymbolication: true,
      warnings,
    };
  } catch (error) {
    return {
      available: false,
      templates: [],
      devices: [],
      instruments: [],
      exportModes: [],
      recordModes: [],
      supportsSymbolication: false,
      warnings: [`xctrace unavailable: ${(error as Error).message}`],
    };
  }
}

/**
 * Export table of contents from a trace file
 */
export async function exportTOC(tracePath: string): Promise<string> {
  try {
    return await runXcrunWithOutputFile(
      ['xctrace', 'export', '--input', tracePath, '--toc'],
      'xml',
      EXPORT_TOC_TIMEOUT_MS
    );
  } catch (error: any) {
    throw new XCTraceError(
      `Failed to export TOC from trace: ${tracePath}`,
      error.code,
      error.stderr
    );
  }
}

/**
 * Export a specific XPath from a trace.
 */
export async function exportXPath(tracePath: string, xpath: string): Promise<string> {
  try {
    return await runXcrunWithOutputFile(
      ['xctrace', 'export', '--input', tracePath, '--xpath', xpath],
      'xml',
      EXPORT_TABLE_TIMEOUT_MS
    );
  } catch (error: any) {
    throw new XCTraceError(
      `Failed to export XPath '${xpath}' from trace: ${tracePath}`,
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
  const xpath = `/trace-toc/run[@number="${runNumber}"]/data/table[@schema="${schema}"]`;

  try {
    return await exportXPath(tracePath, xpath);
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
    return await runXcrunWithOutputDirectory(
      ['xctrace', 'export', '--input', tracePath, '--har'],
      'har',
      EXPORT_HAR_TIMEOUT_MS
    );
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
    return await listXctraceValues('templates');
  } catch (error: any) {
    throw new XCTraceError('Failed to list templates', error.code, error.stderr);
  }
}

/**
 * List available devices
 */
export async function listDevices(): Promise<string[]> {
  try {
    return await listXctraceValues('devices');
  } catch (error: any) {
    throw new XCTraceError('Failed to list devices', error.code, error.stderr);
  }
}

/**
 * List available Instruments that can be added to templates, when xctrace exposes them.
 */
export async function listInstruments(): Promise<string[]> {
  try {
    return await listXctraceValues('instruments');
  } catch (error: any) {
    throw new XCTraceError('Failed to list instruments', error.code, error.stderr);
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
  launchCommand?: string;
  launchArguments?: string[];
  environment?: Record<string, string>;
  targetStdin?: string;
  targetStdout?: string;
  processName?: string;
  allProcesses?: boolean;
  duration?: number; // seconds
  outputPath: string;
  noPrompt?: boolean;
}

export function buildRecordTraceArgs(options: RecordOptions): string[] {
  const launchTarget = options.launchCommand ?? options.appIdentifier;
  const targetCount = [
    options.processName ? 'processName' : undefined,
    options.allProcesses ? 'allProcesses' : undefined,
    launchTarget ? 'launch' : undefined,
  ].filter(Boolean);

  if (targetCount.length === 0) {
    throw new XCTraceError('Recording requires processName, launchCommand/appIdentifier, or allProcesses');
  }
  if (targetCount.length > 1) {
    throw new XCTraceError(`Recording target is ambiguous: ${targetCount.join(', ')}`);
  }
  if ((options.environment || options.targetStdin || options.targetStdout) && !launchTarget) {
    throw new XCTraceError('Launch environment and stream redirection require launchCommand or appIdentifier');
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

  if (launchTarget) {
    if (options.targetStdin) {
      args.push('--target-stdin', options.targetStdin);
    }
    if (options.targetStdout) {
      args.push('--target-stdout', options.targetStdout);
    }
    for (const [name, value] of Object.entries(options.environment ?? {})) {
      args.push('--env', `${name}=${value}`);
    }
    args.push('--launch', '--', launchTarget, ...(options.launchArguments ?? []));
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

export interface SymbolicateOptions {
  inputPath: string;
  outputPath?: string;
  dsymPath?: string;
}

export function buildSymbolicateTraceArgs(options: SymbolicateOptions): string[] {
  const args = ['xctrace', 'symbolicate', '--input', options.inputPath];

  if (options.outputPath) {
    args.push('--output', options.outputPath);
  }
  if (options.dsymPath) {
    args.push('--dsym', options.dsymPath);
  }

  return args;
}

/**
 * Symbolicate a trace with xctrace. If outputPath is omitted, xctrace mutates the input trace.
 */
export async function symbolicateTrace(options: SymbolicateOptions): Promise<void> {
  try {
    await runXcrun(buildSymbolicateTraceArgs(options), SYMBOLICATE_TIMEOUT_MS);
  } catch (error: any) {
    const details = processErrorOutput(error);
    throw new XCTraceError(
      [`Failed to symbolicate trace: ${options.inputPath}`, details].filter(Boolean).join(': '),
      error.code,
      details
    );
  }
}

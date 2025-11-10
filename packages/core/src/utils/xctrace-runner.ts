/**
 * Utility for running xctrace commands
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { XCTraceError } from '../types.js';

const execAsync = promisify(exec);

/**
 * Check if xctrace is available on the system
 */
export async function isXCTraceAvailable(): Promise<boolean> {
  try {
    await execAsync('which xcrun');
    await execAsync('xcrun xctrace version');
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
    const { stdout } = await execAsync('xcrun xctrace version');
    return stdout.trim();
  } catch (error) {
    throw new XCTraceError('Failed to get xctrace version', (error as any).code, (error as any).stderr);
  }
}

/**
 * Export table of contents from a trace file
 */
export async function exportTOC(tracePath: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`xcrun xctrace export --input "${tracePath}" --toc`);
    return stdout;
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
    const { stdout } = await execAsync(
      `xcrun xctrace export --input "${tracePath}" --xpath '${xpath}'`
    );
    return stdout;
  } catch (error: any) {
    throw new XCTraceError(
      `Failed to export table '${schema}' from trace: ${tracePath}`,
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
    const { stdout } = await execAsync('xcrun xctrace list templates');
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
    const { stdout } = await execAsync('xcrun xctrace list devices');
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
  device?: string;
  appIdentifier: string;
  duration?: number; // seconds
  outputPath: string;
}

export async function recordTrace(options: RecordOptions): Promise<void> {
  const args = [
    'xcrun xctrace record',
    `--template '${options.template}'`,
    `--launch '${options.appIdentifier}'`,
    `--output '${options.outputPath}'`
  ];

  if (options.device) {
    args.push(`--device '${options.device}'`);
  }

  if (options.duration) {
    args.push(`--time-limit ${options.duration}s`);
  }

  const command = args.join(' ');

  try {
    await execAsync(command, { timeout: (options.duration || 30) * 1000 + 10000 });
  } catch (error: any) {
    throw new XCTraceError(
      `Failed to record trace for ${options.appIdentifier}`,
      error.code,
      error.stderr
    );
  }
}

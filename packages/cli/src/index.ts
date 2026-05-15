#!/usr/bin/env node

import { execFile as execFileCallback } from 'child_process';
import { readFileSync, realpathSync } from 'fs';
import { lstat, mkdir, mkdtemp, readdir, rm } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  analyzeTraceFile as defaultAnalyzeTraceFile,
  compareTraceFiles as defaultCompareTraceFiles,
  getXCTraceCapabilities as defaultGetXCTraceCapabilities,
  listDevices as defaultListDevices,
  listTemplates as defaultListTemplates,
  recordTrace as defaultRecordTrace,
  symbolicateTrace as defaultSymbolicateTrace,
  Analysis,
  AnalysisOptions,
  Comparison,
  ComparisonOptions,
  RecordOptions,
  TimeRangeMs,
  XCTraceCapabilities,
} from '@xctrace-analyzer/core';

const CLI_NAME = 'xctrace-analyzer';
const CLI_VERSION = readPackageVersion();
const DEFAULT_TRACE_ROOT = getDefaultTraceRoot();
const DEFAULT_MAX_DURATION_SECONDS = 300;
const MAX_TOP_N = 100;
const MAX_STRING_LENGTH = 4096;
const MAX_LAUNCH_ARGUMENTS = 128;
const MAX_USER_BINARY_HINTS = 64;
const MAX_ENVIRONMENT_VARIABLES = 64;

type OutputFormat = 'markdown' | 'json' | 'both';
type RedactionMode = 'balanced' | 'strict' | 'off';

interface ProfilePreset {
  template: string;
  instruments: string[];
}

const PROFILE_PRESETS: Record<string, ProfilePreset> = {
  cpu: { template: 'Time Profiler', instruments: [] },
  memory: { template: 'Allocations', instruments: ['Leaks'] },
  network: { template: 'Time Profiler', instruments: ['HTTP Traffic'] },
  energy: { template: 'Power Profiler', instruments: [] },
  full: { template: 'Time Profiler', instruments: ['Leaks', 'Allocations', 'HTTP Traffic'] },
  'full-ios': {
    template: 'Time Profiler',
    instruments: ['Leaks', 'Allocations', 'HTTP Traffic', 'Power Profiler'],
  },
};

export interface XCTraceAnalyzerCliIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export interface XCTraceAnalyzerCliDependencies {
  analyzeTraceFile: typeof defaultAnalyzeTraceFile;
  compareTraceFiles: typeof defaultCompareTraceFiles;
  listTemplates: typeof defaultListTemplates;
  listDevices: typeof defaultListDevices;
  getXCTraceCapabilities: typeof defaultGetXCTraceCapabilities;
  recordTrace: typeof defaultRecordTrace;
  symbolicateTrace?: typeof defaultSymbolicateTrace;
  openTrace?: (tracePath: string) => Promise<void>;
}

interface ParsedCliArgs {
  positionals: string[];
  options: Map<string, string[]>;
}

interface ResolvedSecurityOptions {
  allowLaunchProfiling: boolean;
  allowAllProcessesProfiling: boolean;
  allowExternalTraceOutput: boolean;
  allowExternalTraceCleanup: boolean;
  traceRoot: string;
  maxDurationSeconds: number;
  redaction: RedactionMode;
}

interface RecordTarget {
  fileLabel: string;
  reportLabel: string;
  workflowWarnings: string[];
  recordOptions: Partial<Pick<
    RecordOptions,
    | 'processName'
    | 'allProcesses'
    | 'launchCommand'
    | 'appIdentifier'
    | 'launchArguments'
    | 'environment'
    | 'targetStdin'
    | 'targetStdout'
  >>;
}

interface InstrumentsOpenResult {
  status: 'opened' | 'failed';
  error?: string;
}

interface RecordingResult {
  target: string;
  template: string;
  instruments: string[];
  duration: number;
  device?: string;
  outputPath: string;
  instrumentsOpen?: InstrumentsOpenResult;
  workflowWarnings: string[];
  analysis?: Analysis;
}

interface TraceCleanupEntry {
  path: string;
  status: 'would_delete' | 'deleted' | 'skipped' | 'failed';
  sizeBytes?: number;
  modifiedAt?: string;
  ageMinutes?: number;
  reason?: string;
}

interface TraceCleanupResult {
  dryRun: boolean;
  scope: string;
  matchedCount: number;
  deletedCount: number;
  skippedCount: number;
  failedCount: number;
  reclaimableBytes: number;
  reclaimedBytes: number;
  entries: TraceCleanupEntry[];
}

const defaultDependencies: XCTraceAnalyzerCliDependencies = {
  analyzeTraceFile: defaultAnalyzeTraceFile,
  compareTraceFiles: defaultCompareTraceFiles,
  listTemplates: defaultListTemplates,
  listDevices: defaultListDevices,
  getXCTraceCapabilities: defaultGetXCTraceCapabilities,
  recordTrace: defaultRecordTrace,
  symbolicateTrace: defaultSymbolicateTrace,
  openTrace: defaultOpenTrace,
};

function defaultOpenTrace(tracePath: string): Promise<void> {
  return new Promise((resolveOpen, rejectOpen) => {
    execFileCallback('open', [tracePath], (error) => {
      if (error) {
        rejectOpen(error);
        return;
      }
      resolveOpen();
    });
  });
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  io: XCTraceAnalyzerCliIo = { stdout: process.stdout, stderr: process.stderr },
  deps: XCTraceAnalyzerCliDependencies = defaultDependencies
): Promise<number> {
  const [command, ...rest] = argv;

  try {
    if (!command || command === '--help' || command === '-h') {
      io.stdout.write(formatHelp());
      return 0;
    }

    if (command === '--version' || command === '-v' || command === 'version') {
      io.stdout.write(`${CLI_NAME} ${CLI_VERSION}\n`);
      return 0;
    }

    switch (command) {
      case 'doctor':
      case 'check':
        return await runDoctor(rest, io, deps);
      case 'list-templates':
      case 'templates':
        return await runListTemplates(rest, io, deps);
      case 'list-devices':
      case 'devices':
        return await runListDevices(rest, io, deps);
      case 'analyze':
        return await runAnalyze(rest, io, deps);
      case 'compare':
        return await runCompare(rest, io, deps);
      case 'record':
      case 'profile':
        return await runRecord(rest, io, deps, 'record');
      case 'track':
        return await runRecord(rest, io, deps, 'track');
      case 'cleanup':
        return await runCleanup(rest, io);
      default:
        io.stderr.write(`Unknown command: ${command}\n\n`);
        io.stderr.write(formatHelp());
        return 2;
    }
  } catch (error) {
    io.stderr.write(`Error: ${formatCliError(error)}\n`);
    return 1;
  }
}

async function runDoctor(
  argv: string[],
  io: XCTraceAnalyzerCliIo,
  deps: XCTraceAnalyzerCliDependencies
): Promise<number> {
  const parsed = parseArgs(argv);
  assertNoPositionals(parsed, 'doctor');
  const outputFormatValue = outputFormat(parsed);
  const security = resolveSecurityOptions();
  const capabilities = await deps.getXCTraceCapabilities();

  const markdown = formatCapabilities(capabilities, security);
  io.stdout.write(formatOutput(markdown, { capabilities, traceRoot: security.traceRoot }, outputFormatValue) + '\n');
  return capabilities.available ? 0 : 1;
}

async function runListTemplates(
  argv: string[],
  io: XCTraceAnalyzerCliIo,
  deps: XCTraceAnalyzerCliDependencies
): Promise<number> {
  const parsed = parseArgs(argv);
  assertNoPositionals(parsed, 'list-templates');
  const templates = await deps.listTemplates();
  const markdown = ['Available Instruments Templates:', '', ...templates].join('\n');
  io.stdout.write(formatOutput(markdown, { templates }, outputFormat(parsed)) + '\n');
  return 0;
}

async function runListDevices(
  argv: string[],
  io: XCTraceAnalyzerCliIo,
  deps: XCTraceAnalyzerCliDependencies
): Promise<number> {
  const parsed = parseArgs(argv);
  assertNoPositionals(parsed, 'list-devices');
  const devices = await deps.listDevices();
  const markdown = ['Available Devices:', '', ...devices].join('\n');
  io.stdout.write(formatOutput(markdown, { devices }, outputFormat(parsed)) + '\n');
  return 0;
}

async function runAnalyze(
  argv: string[],
  io: XCTraceAnalyzerCliIo,
  deps: XCTraceAnalyzerCliDependencies
): Promise<number> {
  const parsed = parseArgs(argv);
  const [tracePath, ...extra] = parsed.positionals;
  if (!tracePath || extra.length > 0) {
    throw new Error('Usage: xctrace-analyzer analyze <trace.trace> [options]');
  }

  const preparedTracePath = await prepareTraceForAnalysis(
    tracePath,
    stringOption(parsed, 'dsym', 'dsym-path'),
    deps
  );
  const options = analysisOptions(parsed);
  const analysis = await deps.analyzeTraceFile(preparedTracePath, options);
  if (preparedTracePath !== tracePath) {
    analysis.exportAttempts = [
      {
        kind: 'symbolication',
        status: 'success',
        message: `Symbolicated ${tracePath} to ${preparedTracePath}`,
      },
      ...(analysis.exportAttempts ?? []),
    ];
  }

  const structured = structuredAnalysis(analysis);
  io.stdout.write(formatOutput(formatAnalysis(analysis), structured, outputFormat(parsed)) + '\n');
  return 0;
}

async function runCompare(
  argv: string[],
  io: XCTraceAnalyzerCliIo,
  deps: XCTraceAnalyzerCliDependencies
): Promise<number> {
  const parsed = parseArgs(argv);
  const [baselinePath, currentPath, ...extra] = parsed.positionals;
  if (!baselinePath || !currentPath || extra.length > 0) {
    throw new Error('Usage: xctrace-analyzer compare <baseline.trace> <current.trace> [options]');
  }

  const preparedBaseline = await prepareTraceForAnalysis(
    baselinePath,
    stringOption(parsed, 'baseline-dsym', 'baseline-dsym-path'),
    deps
  );
  const preparedCurrent = await prepareTraceForAnalysis(
    currentPath,
    stringOption(parsed, 'current-dsym', 'current-dsym-path'),
    deps
  );
  const comparisonOptions: ComparisonOptions = {
    regressionThreshold: numberOption(parsed, 'regression-threshold'),
    failOnRegression: booleanOption(parsed, 'fail-on-regression'),
  };
  const comparison = await deps.compareTraceFiles(
    preparedBaseline,
    preparedCurrent,
    undefined,
    comparisonOptions
  );

  io.stdout.write(formatOutput(formatComparison(comparison), comparison, outputFormat(parsed)) + '\n');
  return comparisonOptions.failOnRegression && comparison.hasRegression ? 1 : 0;
}

async function runRecord(
  argv: string[],
  io: XCTraceAnalyzerCliIo,
  deps: XCTraceAnalyzerCliDependencies,
  mode: 'record' | 'track'
): Promise<number> {
  const parsed = parseArgs(argv);
  const security = resolveSecurityOptions();
  const target = recordTargetOptions(parsed, security);
  const duration = numberOption(parsed, 'duration', 'duration-seconds') ?? 60;
  assertPositiveNumber(duration, 'duration');
  assertDurationWithinLimit(duration, security);
  const outputFormatValue = outputFormat(parsed);
  const openInInstruments = booleanOption(parsed, 'open', 'open-in-instruments') ?? true;
  const analyze = booleanOption(parsed, 'analyze') ?? true;

  const profilePreset = mode === 'record'
    ? profilePresetForName(stringOption(parsed, 'preset') ?? 'full')
    : undefined;
  const template = mode === 'track'
    ? parsed.positionals[0] ?? stringOption(parsed, 'template') ?? 'Leaks'
    : stringOption(parsed, 'template') ?? profilePreset?.template ?? 'Time Profiler';
  const unexpectedPositionals = mode === 'track' ? parsed.positionals.slice(1) : parsed.positionals;
  if (unexpectedPositionals.length > 0) {
    throw new Error(`Unexpected positional arguments: ${unexpectedPositionals.join(' ')}`);
  }

  const explicitInstruments = stringArrayOption(parsed, 'instrument');
  const instruments = mode === 'record' && !stringOption(parsed, 'template')
    ? [...(profilePreset?.instruments ?? []), ...explicitInstruments]
    : explicitInstruments;
  const device = stringOption(parsed, 'device');
  const outputPath = traceOutputPath(parsed, security, target.fileLabel, template);
  await mkdir(dirname(outputPath), { recursive: true });

  const recordOptions: RecordOptions = {
    template,
    instruments,
    ...target.recordOptions,
    duration,
    outputPath,
    ...(device ? { device } : {}),
  };
  await deps.recordTrace(recordOptions);

  const instrumentsOpen = await openTraceInInstruments(outputPath, openInInstruments, deps);
  const analysis = analyze ? await deps.analyzeTraceFile(outputPath, analysisOptions(parsed)) : undefined;
  const result: RecordingResult = {
    target: target.reportLabel,
    template,
    instruments,
    duration,
    device,
    outputPath,
    instrumentsOpen,
    workflowWarnings: target.workflowWarnings,
    analysis,
  };

  io.stdout.write(
    formatOutput(
      formatRecording(result, mode === 'record' ? stringOption(parsed, 'preset') ?? 'full' : undefined),
      {
        recording: {
          target: result.target,
          template: result.template,
          instruments: result.instruments,
          duration: result.duration,
          device: result.device,
          outputPath: result.outputPath,
          instrumentsOpen: result.instrumentsOpen,
          workflowWarnings: result.workflowWarnings,
        },
        analysis: analysis ? structuredAnalysis(analysis) : null,
      },
      outputFormatValue
    ) + '\n'
  );
  return 0;
}

async function runCleanup(argv: string[], io: XCTraceAnalyzerCliIo): Promise<number> {
  const parsed = parseArgs(argv);
  assertNoPositionals(parsed, 'cleanup');
  const security = resolveSecurityOptions();
  const dryRun = booleanOption(parsed, 'dry-run') ?? !booleanOption(parsed, 'delete');
  const tracePaths = stringArrayOption(parsed, 'trace', 'trace-path');
  const directory = resolve(stringOption(parsed, 'dir', 'directory') ?? security.traceRoot);
  const recursive = booleanOption(parsed, 'recursive') ?? false;
  const olderThanMinutes = numberOption(parsed, 'older-than-minutes');

  if (!dryRun && tracePaths.length === 0 && olderThanMinutes === undefined) {
    throw new Error(
      'Refusing destructive directory cleanup without --trace or --older-than-minutes. Run the dry run first, or pass an age filter.'
    );
  }

  if (!dryRun && tracePaths.length === 0) {
    assertCleanupDirectoryAllowed(directory, security);
  }

  const candidatePaths = tracePaths.length > 0
    ? tracePaths.map((path) => resolve(path))
    : await discoverTraceBundles(directory, recursive);
  const entries: TraceCleanupEntry[] = [];
  const seenPaths = new Set<string>();

  for (const candidatePath of candidatePaths) {
    if (seenPaths.has(candidatePath)) {
      continue;
    }
    seenPaths.add(candidatePath);
    entries.push(await cleanupTraceCandidate(candidatePath, dryRun, olderThanMinutes, security));
  }

  const result: TraceCleanupResult = {
    dryRun,
    scope: tracePaths.length > 0
      ? 'exact trace paths'
      : `${recursive ? 'recursive ' : ''}directory scan: ${directory}`,
    matchedCount: entries.filter((entry) =>
      entry.status === 'would_delete' || entry.status === 'deleted'
    ).length,
    deletedCount: entries.filter((entry) => entry.status === 'deleted').length,
    skippedCount: entries.filter((entry) => entry.status === 'skipped').length,
    failedCount: entries.filter((entry) => entry.status === 'failed').length,
    reclaimableBytes: entries
      .filter((entry) => entry.status === 'would_delete')
      .reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0),
    reclaimedBytes: entries
      .filter((entry) => entry.status === 'deleted')
      .reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0),
    entries,
  };

  io.stdout.write(formatOutput(formatCleanup(result), result, outputFormat(parsed)) + '\n');
  return result.failedCount > 0 ? 1 : 0;
}

function parseArgs(argv: string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (arg === '-h') {
      addOption(options, 'help', 'true');
      continue;
    }
    if (arg === '-v') {
      addOption(options, 'version', 'true');
      continue;
    }

    if (arg.startsWith('--')) {
      const raw = arg.slice(2);
      const equalsIndex = raw.indexOf('=');
      let name = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex);
      let value = equalsIndex === -1 ? undefined : raw.slice(equalsIndex + 1);

      if (name.startsWith('no-')) {
        name = name.slice(3);
        value = 'false';
      } else if (value === undefined) {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('-')) {
          value = next;
          index += 1;
        } else {
          value = 'true';
        }
      }

      addOption(options, name, value);
      continue;
    }

    positionals.push(arg);
  }

  return { positionals, options };
}

function addOption(options: Map<string, string[]>, name: string, value: string): void {
  const values = options.get(name) ?? [];
  values.push(value);
  options.set(name, values);
}

function assertNoPositionals(parsed: ParsedCliArgs, command: string): void {
  if (parsed.positionals.length > 0) {
    throw new Error(`${command} does not accept positional arguments: ${parsed.positionals.join(' ')}`);
  }
}

function optionValues(parsed: ParsedCliArgs, ...names: string[]): string[] {
  return names.flatMap((name) => parsed.options.get(name) ?? []);
}

function lastOptionValue(parsed: ParsedCliArgs, ...names: string[]): string | undefined {
  const values = optionValues(parsed, ...names);
  return values.length > 0 ? values[values.length - 1] : undefined;
}

function stringOption(parsed: ParsedCliArgs, ...names: string[]): string | undefined {
  const value = lastOptionValue(parsed, ...names);
  if (value === undefined || value === 'true') {
    return undefined;
  }
  if (value.trim() === '') {
    throw new Error(`${names[0]} must not be empty`);
  }
  if (value.length > MAX_STRING_LENGTH) {
    throw new Error(`${names[0]} must be ${MAX_STRING_LENGTH} characters or fewer`);
  }
  return value;
}

function stringArrayOption(parsed: ParsedCliArgs, ...names: string[]): string[] {
  const values = optionValues(parsed, ...names).filter((value) => value !== 'true');
  return values.map((value, index) => {
    if (value.trim() === '') {
      throw new Error(`${names[0]}[${index}] must not be empty`);
    }
    return value;
  });
}

function numberOption(parsed: ParsedCliArgs, ...names: string[]): number | undefined {
  const value = lastOptionValue(parsed, ...names);
  if (value === undefined || value === 'true') {
    return undefined;
  }
  const parsedNumber = Number(value);
  if (!Number.isFinite(parsedNumber)) {
    throw new Error(`${names[0]} must be a number`);
  }
  return parsedNumber;
}

function booleanOption(parsed: ParsedCliArgs, ...names: string[]): boolean | undefined {
  const value = lastOptionValue(parsed, ...names);
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`${names[0]} must be a boolean`);
}

function outputFormat(parsed: ParsedCliArgs): OutputFormat {
  if (booleanOption(parsed, 'json') === true) {
    return 'json';
  }
  const value = stringOption(parsed, 'format') ?? 'markdown';
  if (value !== 'markdown' && value !== 'json' && value !== 'both') {
    throw new Error('--format must be markdown, json, or both');
  }
  return value;
}

function analysisOptions(parsed: ParsedCliArgs): AnalysisOptions {
  const userBinaryHints = stringArrayOption(parsed, 'user-binary-hint', 'user-binary');
  if (userBinaryHints.length > MAX_USER_BINARY_HINTS) {
    throw new Error(`user-binary-hint must contain ${MAX_USER_BINARY_HINTS} values or fewer`);
  }

  return {
    slowThreshold: nonNegativeNumberOption(parsed, 'slow-threshold'),
    topN: positiveIntegerOption(parsed, 'top', 'top-n'),
    includeRecommendations: true,
    timeRangeMs: timeRangeOption(parsed),
    userBinaryHints,
  };
}

function nonNegativeNumberOption(parsed: ParsedCliArgs, ...names: string[]): number | undefined {
  const value = numberOption(parsed, ...names);
  if (value !== undefined && value < 0) {
    throw new Error(`${names[0]} must be non-negative`);
  }
  return value;
}

function positiveIntegerOption(parsed: ParsedCliArgs, ...names: string[]): number | undefined {
  const value = numberOption(parsed, ...names);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TOP_N) {
    throw new Error(`${names[0]} must be a positive integer no greater than ${MAX_TOP_N}`);
  }
  return value;
}

function timeRangeOption(parsed: ParsedCliArgs): TimeRangeMs | undefined {
  const timeRange = stringOption(parsed, 'time-range');
  const explicitStart = numberOption(parsed, 'start-ms');
  const explicitEnd = numberOption(parsed, 'end-ms');

  if (timeRange) {
    const [startText, endText] = timeRange.split(':');
    const startMs = Number(startText);
    const endMs = Number(endText);
    return validateTimeRange({ startMs, endMs });
  }

  if (explicitStart !== undefined || explicitEnd !== undefined) {
    return validateTimeRange({
      startMs: explicitStart ?? Number.NaN,
      endMs: explicitEnd ?? Number.NaN,
    });
  }

  return undefined;
}

function validateTimeRange(range: TimeRangeMs): TimeRangeMs {
  if (!Number.isFinite(range.startMs) || !Number.isFinite(range.endMs)) {
    throw new Error('time range requires finite start and end milliseconds');
  }
  if (range.startMs < 0) {
    throw new Error('time range start must be non-negative');
  }
  if (range.endMs <= range.startMs) {
    throw new Error('time range end must be greater than start');
  }
  return range;
}

function recordTargetOptions(parsed: ParsedCliArgs, security: ResolvedSecurityOptions): RecordTarget {
  const target = stringOption(parsed, 'target');
  if (target && !['attach', 'launch', 'all-processes'].includes(target)) {
    throw new Error('--target must be attach, launch, or all-processes');
  }

  const processName = stringOption(parsed, 'process', 'process-name', 'pid');
  const launchCommand = stringOption(parsed, 'launch', 'launch-command');
  const appIdentifier = stringOption(parsed, 'app-identifier');
  const allProcesses = booleanOption(parsed, 'all-processes') === true || target === 'all-processes';
  const targetCount = [
    processName ? 'process' : undefined,
    launchCommand || appIdentifier || target === 'launch' ? 'launch' : undefined,
    allProcesses ? 'all-processes' : undefined,
  ].filter(Boolean);

  if (targetCount.length === 0) {
    throw new Error('Recording requires --process, --launch, --app-identifier, or --all-processes');
  }
  if (targetCount.length > 1) {
    throw new Error(`Recording target is ambiguous: ${targetCount.join(', ')}`);
  }

  if (allProcesses) {
    if (!security.allowAllProcessesProfiling) {
      throw new Error(
        'All-process profiling is disabled by default because traces can expose data from unrelated apps. Set XCTRACE_ANALYZER_ALLOW_ALL_PROCESSES=1 for trusted sessions.'
      );
    }
    return {
      fileLabel: 'all-processes',
      reportLabel: 'all processes',
      workflowWarnings: [],
      recordOptions: { allProcesses: true },
    };
  }

  if (launchCommand || appIdentifier || target === 'launch') {
    const launchTarget = launchCommand ?? appIdentifier;
    if (!launchTarget) {
      throw new Error('Launch recording requires --launch or --app-identifier');
    }
    if (!security.allowLaunchProfiling) {
      throw new Error(
        'Launch profiling is disabled by default because it can execute local programs. Set XCTRACE_ANALYZER_ALLOW_LAUNCH=1 for trusted sessions.'
      );
    }
    if (launchTarget.length > 1024) {
      throw new Error('launch target must be 1024 characters or fewer');
    }
    const targetStdin = stringOption(parsed, 'target-stdin');
    const targetStdout = stringOption(parsed, 'target-stdout');
    assertStreamPathAllowed(targetStdin, 'target-stdin', security);
    assertStreamPathAllowed(targetStdout, 'target-stdout', security);
    return {
      fileLabel: launchTarget,
      reportLabel: `launch: ${launchTarget}`,
      workflowWarnings: [
        `Launch target "${launchTarget}" records startup behavior. For already-running app hangs or CPU bottlenecks, prefer attach-by-PID.`,
      ],
      recordOptions: {
        ...(launchCommand ? { launchCommand } : { appIdentifier }),
        launchArguments: launchArguments(parsed),
        environment: environmentOption(parsed),
        targetStdin,
        targetStdout,
      },
    };
  }

  const requiredProcess = processName ?? '';
  const workflowWarnings = /^\d+$/.test(requiredProcess)
    ? []
    : [
        `Attach target "${requiredProcess}" is a process name, not a PID. If several processes share this name, rerun with the exact PID in --process.`,
      ];
  return {
    fileLabel: requiredProcess,
    reportLabel: `attach: ${requiredProcess}`,
    workflowWarnings,
    recordOptions: { processName: requiredProcess },
  };
}

function launchArguments(parsed: ParsedCliArgs): string[] | undefined {
  const values = stringArrayOption(parsed, 'launch-arg', 'arg');
  if (values.length > MAX_LAUNCH_ARGUMENTS) {
    throw new Error(`launch arguments must contain ${MAX_LAUNCH_ARGUMENTS} values or fewer`);
  }
  return values.length > 0 ? values : undefined;
}

function environmentOption(parsed: ParsedCliArgs): Record<string, string> | undefined {
  const pairs = stringArrayOption(parsed, 'env');
  if (pairs.length > MAX_ENVIRONMENT_VARIABLES) {
    throw new Error(`environment must contain ${MAX_ENVIRONMENT_VARIABLES} entries or fewer`);
  }
  if (pairs.length === 0) {
    return undefined;
  }

  const environment: Record<string, string> = {};
  for (const pair of pairs) {
    const equalsIndex = pair.indexOf('=');
    if (equalsIndex <= 0) {
      throw new Error('--env values must use NAME=value');
    }
    const name = pair.slice(0, equalsIndex);
    const value = pair.slice(equalsIndex + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid environment variable name: ${name}`);
    }
    environment[name] = value;
  }
  return environment;
}

function profilePresetForName(preset: string): ProfilePreset {
  const profilePreset = PROFILE_PRESETS[preset];
  if (!profilePreset) {
    throw new Error(`Unknown preset: ${preset}. Use one of: ${Object.keys(PROFILE_PRESETS).join(', ')}`);
  }
  return profilePreset;
}

async function prepareTraceForAnalysis(
  tracePath: string,
  dsymPath: string | undefined,
  deps: XCTraceAnalyzerCliDependencies
): Promise<string> {
  if (!dsymPath) {
    return tracePath;
  }
  const symbolicateTrace = deps.symbolicateTrace ?? defaultSymbolicateTrace;
  const tempDir = await mkdtemp(join(tmpdir(), 'xctrace-analyzer-'));
  const outputPath = join(tempDir, `${safeFileName(basename(tracePath, '.trace'))}-symbolicated.trace`);
  await symbolicateTrace({ inputPath: tracePath, outputPath, dsymPath });
  return outputPath;
}

function traceOutputPath(
  parsed: ParsedCliArgs,
  security: ResolvedSecurityOptions,
  processName: string,
  template: string
): string {
  const explicitOutput = stringOption(parsed, 'output', 'output-path');
  if (explicitOutput) {
    const outputPath = resolve(explicitOutput);
    assertTraceOutputPathAllowed(outputPath, 'output', security);
    return outputPath;
  }

  const outputDirectory = resolve(stringOption(parsed, 'output-dir', 'output-directory') ?? security.traceRoot);
  assertTraceDirectoryAllowed(outputDirectory, 'output-dir', security);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(outputDirectory, `${safeFileName(processName)}-${safeFileName(template)}-${timestamp}.trace`);
}

async function openTraceInInstruments(
  tracePath: string,
  shouldOpen: boolean,
  deps: XCTraceAnalyzerCliDependencies
): Promise<InstrumentsOpenResult | undefined> {
  if (!shouldOpen || !deps.openTrace) {
    return undefined;
  }
  try {
    await deps.openTrace(tracePath);
    return { status: 'opened' };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

function formatCapabilities(capabilities: XCTraceCapabilities, security: ResolvedSecurityOptions): string {
  const lines = [
    `${CLI_NAME}: ${CLI_VERSION}`,
    `xcrun xctrace: ${capabilities.available ? 'available' : 'unavailable'}`,
  ];
  if (capabilities.version) {
    lines.push(`version: ${capabilities.version}`);
  }
  lines.push(`templates: ${capabilities.templates.length}`);
  lines.push(`devices: ${capabilities.devices.length}`);
  lines.push(`instruments: ${capabilities.instruments.length}`);
  lines.push(`export modes: ${capabilities.exportModes.join(', ') || 'none detected'}`);
  lines.push(`record modes: ${capabilities.recordModes.join(', ') || 'none detected'}`);
  lines.push(`symbolication: ${capabilities.supportsSymbolication ? 'supported' : 'not detected'}`);
  lines.push(`trace root: ${security.traceRoot}`);
  if (capabilities.warnings.length > 0) {
    lines.push('warnings:');
    lines.push(...capabilities.warnings.map((warning: string) => `- ${warning}`));
  }
  return lines.join('\n');
}

function formatAnalysis(analysis: Analysis): string {
  const lines = [
    '# Trace Analysis',
    '',
    analysis.summary,
    '',
    '## Metadata',
    `- Trace: ${analysis.metadata.filePath}`,
    `- Template: ${analysis.metadata.template}`,
    `- Duration: ${formatMs(analysis.metadata.duration)}`,
    '',
    '## Stats',
    `- Total time: ${formatMs(analysis.stats.totalTime)}`,
    `- Slow functions: ${analysis.stats.slowFunctions}`,
    `- Max function time: ${formatMs(analysis.stats.maxFunctionTime)}`,
    `- Threads: ${analysis.stats.threadCount}`,
  ];

  if (analysis.stats.timeRangeMs) {
    lines.push(
      `- Analysis window: ${analysis.stats.timeRangeMs.startMs}ms-${analysis.stats.timeRangeMs.endMs}ms`
    );
  }
  if (analysis.stats.timeProfileError) {
    lines.push(`- Time Profiler parse failure: ${analysis.stats.timeProfileError}`);
  }

  appendSupportStatus(lines, analysis);
  appendExportAttempts(lines, analysis);
  appendHangs(lines, analysis);
  appendBottlenecks(lines, analysis);
  appendUserFrames(lines, analysis);
  appendInstrumentAnalyses(lines, analysis);
  appendRecommendations(lines, analysis);

  return lines.join('\n');
}

function formatComparison(comparison: Comparison): string {
  const lines = [
    '# Trace Comparison',
    '',
    comparison.summary,
    '',
    '## Delta',
    `- Total time change: ${formatMs(comparison.delta.totalTimeChange)} (${comparison.delta.totalTimeChangePercent.toFixed(1)}%)`,
    `- Regressions: ${comparison.regressions.length}`,
    `- Improvements: ${comparison.improvements.length}`,
    `- Has regression: ${comparison.hasRegression ? 'yes' : 'no'}`,
    `- Has critical regression: ${comparison.hasCriticalRegression ? 'yes' : 'no'}`,
  ];

  if (comparison.regressions.length > 0) {
    lines.push('', '## Regressions');
    for (const regression of comparison.regressions.slice(0, 10)) {
      lines.push(
        `- ${regression.function}: +${formatMs(regression.absoluteIncrease)} (${regression.percentageIncrease.toFixed(1)}%, ${regression.severity})`
      );
    }
  }

  if (comparison.improvements.length > 0) {
    lines.push('', '## Improvements');
    for (const improvement of comparison.improvements.slice(0, 10)) {
      lines.push(
        `- ${improvement.function}: -${formatMs(improvement.absoluteDecrease)} (${improvement.percentageDecrease.toFixed(1)}%)`
      );
    }
  }

  return lines.join('\n');
}

function formatRecording(result: RecordingResult, preset?: string): string {
  const lines = [
    '# Recording Report',
    '',
    `- Target: ${result.target}`,
    ...(preset ? [`- Preset: ${preset}`] : []),
    `- Template: ${result.template}`,
    `- Instruments: ${result.instruments.length > 0 ? result.instruments.join(', ') : 'none'}`,
    `- Duration: ${result.duration}s`,
    ...(result.device ? [`- Device: ${result.device}`] : []),
    `- Trace: ${result.outputPath}`,
    '- Cleanup: trace retained; run xctrace-analyzer cleanup when it is no longer needed',
  ];

  if (result.instrumentsOpen) {
    lines.push(
      result.instrumentsOpen.status === 'opened'
        ? '- Instruments.app: opened'
        : `- Instruments.app: failed to open - ${result.instrumentsOpen.error ?? 'unknown error'}`
    );
  }
  if (result.workflowWarnings.length > 0) {
    lines.push('', '## Workflow Warnings');
    lines.push(...result.workflowWarnings.map((warning) => `- ${warning}`));
  }
  if (result.analysis) {
    lines.push('', formatAnalysis(result.analysis));
  } else {
    lines.push('', 'Analysis skipped.');
  }
  return lines.join('\n');
}

function formatCleanup(result: TraceCleanupResult): string {
  const lines = [
    '# Trace Cleanup',
    '',
    `- Mode: ${result.dryRun ? 'dry run' : 'delete'}`,
    `- Scope: ${result.scope}`,
    `- Matched: ${result.matchedCount}`,
    `- Deleted: ${result.deletedCount}`,
    `- Skipped: ${result.skippedCount}`,
    `- Failed: ${result.failedCount}`,
    `- Reclaimable: ${formatBytes(result.reclaimableBytes)}`,
    `- Reclaimed: ${formatBytes(result.reclaimedBytes)}`,
  ];

  if (result.entries.length > 0) {
    lines.push('', '## Entries');
    for (const entry of result.entries) {
      const reason = entry.reason ? ` (${entry.reason})` : '';
      lines.push(`- ${entry.status}: ${entry.path}${reason}`);
    }
  }

  return lines.join('\n');
}

function appendSupportStatus(lines: string[], analysis: Analysis): void {
  if (!analysis.supportStatus || analysis.supportStatus.length === 0) {
    return;
  }
  lines.push('', '## Support Matrix');
  for (const status of analysis.supportStatus) {
    lines.push(`- ${status.kind}: ${status.status}${status.reason ? ` - ${status.reason}` : ''}`);
  }
}

function appendExportAttempts(lines: string[], analysis: Analysis): void {
  if (!analysis.exportAttempts || analysis.exportAttempts.length === 0) {
    return;
  }
  lines.push('', '## Export Diagnostics');
  for (const attempt of analysis.exportAttempts.slice(0, 20)) {
    lines.push(`- ${attempt.kind}: ${attempt.status}${attempt.message ? ` - ${attempt.message}` : ''}`);
  }
}

function appendHangs(lines: string[], analysis: Analysis): void {
  if (!analysis.hangs || analysis.hangs.events.length === 0) {
    return;
  }
  lines.push('', '## Hangs');
  lines.push(`- Events: ${analysis.hangs.events.length}`);
  lines.push(`- Severe: ${analysis.hangs.severeCount}`);
  lines.push(`- Longest: ${formatMs(analysis.hangs.longestMs)}`);
  for (const event of analysis.hangs.events.slice(0, 10)) {
    lines.push(
      `- ${event.hangType}: start ${event.startMs}ms, duration ${formatMs(event.durationMs)}${event.processName ? `, process ${event.processName}` : ''}`
    );
  }
}

function appendBottlenecks(lines: string[], analysis: Analysis): void {
  if (analysis.bottlenecks.length === 0) {
    return;
  }
  lines.push('', '## Bottlenecks');
  for (const bottleneck of analysis.bottlenecks.slice(0, 10)) {
    lines.push(
      `- ${bottleneck.function}: ${formatMs(bottleneck.duration)} (${bottleneck.percentage.toFixed(1)}%, ${bottleneck.impact})`
    );
  }
}

function appendUserFrames(lines: string[], analysis: Analysis): void {
  if (!analysis.userFrameProfiles || analysis.userFrameProfiles.length === 0) {
    return;
  }
  lines.push('', '## Top User-Code Frames');
  for (const frame of analysis.userFrameProfiles.slice(0, 10)) {
    lines.push(
      `- ${frame.name}: ${formatMs(frame.selfTime)} (${frame.percentage.toFixed(1)}%, ${frame.sampleCount} samples)`
    );
  }
}

function appendInstrumentAnalyses(lines: string[], analysis: Analysis): void {
  if (analysis.instrumentAnalyses.length === 0) {
    return;
  }
  lines.push('', '## Instruments');
  for (const instrument of analysis.instrumentAnalyses) {
    lines.push(`- ${instrument.kind}: ${instrument.supportStatus ?? 'unknown'}`);
    for (const finding of instrument.findings.slice(0, 5)) {
      lines.push(`  - ${finding.severity}: ${finding.title}`);
    }
  }
}

function appendRecommendations(lines: string[], analysis: Analysis): void {
  if (analysis.recommendations.length === 0) {
    return;
  }
  lines.push('', '## Recommendations');
  for (const recommendation of analysis.recommendations.slice(0, 10)) {
    lines.push(`- ${recommendation.priority}: ${recommendation.title}`);
  }
}

function structuredAnalysis(analysis: Analysis) {
  return {
    analysis,
    supportStatus: analysis.supportStatus ?? [],
    exportAttempts: analysis.exportAttempts ?? [],
  };
}

function formatOutput(markdown: string, structured: unknown, outputFormatValue: OutputFormat): string {
  const security = resolveSecurityOptions();
  const safeMarkdown = redactText(markdown, security.redaction, false);
  const safeStructured = redactStructuredValue(structured, security.redaction);
  if (outputFormatValue === 'markdown') {
    return safeMarkdown;
  }
  const json = JSON.stringify(safeStructured, null, 2);
  if (outputFormatValue === 'json') {
    return json;
  }
  return `${safeMarkdown}\n\n## Structured Result\n\n${codeFenceFor(json)}json\n${json}\n${codeFenceFor(json)}`;
}

async function discoverTraceBundles(directory: string, recursive: boolean): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const tracePaths: string[] = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.name.endsWith('.trace')) {
      tracePaths.push(fullPath);
      continue;
    }
    if (recursive && entry.isDirectory()) {
      tracePaths.push(...(await discoverTraceBundles(fullPath, recursive)));
    }
  }
  return tracePaths;
}

async function cleanupTraceCandidate(
  tracePath: string,
  dryRun: boolean,
  olderThanMinutes: number | undefined,
  security: ResolvedSecurityOptions
): Promise<TraceCleanupEntry> {
  if (!tracePath.endsWith('.trace')) {
    return { path: tracePath, status: 'skipped', reason: 'not a .trace bundle' };
  }

  let stats;
  try {
    stats = await lstat(tracePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: tracePath, status: 'skipped', reason: 'path does not exist' };
    }
    return { path: tracePath, status: 'failed', reason: (error as Error).message };
  }

  if (stats.isSymbolicLink()) {
    return { path: tracePath, status: 'skipped', reason: 'symbolic links are not deleted' };
  }

  const ageMinutes = Math.max(0, (Date.now() - stats.mtimeMs) / 60_000);
  if (olderThanMinutes !== undefined && ageMinutes < olderThanMinutes) {
    return {
      path: tracePath,
      status: 'skipped',
      modifiedAt: stats.mtime.toISOString(),
      ageMinutes,
      reason: `newer than ${olderThanMinutes} minutes`,
    };
  }

  const sizeBytes = await tracePathSizeBytes(tracePath);
  const baseEntry = {
    path: tracePath,
    sizeBytes,
    modifiedAt: stats.mtime.toISOString(),
    ageMinutes,
  };

  if (dryRun) {
    return { ...baseEntry, status: 'would_delete' };
  }

  if (!security.allowExternalTraceCleanup && !isPathInside(resolve(tracePath), security.traceRoot)) {
    return {
      ...baseEntry,
      status: 'failed',
      reason: 'destructive cleanup outside the configured trace root is disabled',
    };
  }

  try {
    await rm(tracePath, { recursive: true });
    return { ...baseEntry, status: 'deleted' };
  } catch (error) {
    return { ...baseEntry, status: 'failed', reason: (error as Error).message };
  }
}

async function tracePathSizeBytes(tracePath: string): Promise<number> {
  const stats = await lstat(tracePath);
  if (stats.isSymbolicLink()) {
    return 0;
  }
  if (!stats.isDirectory()) {
    return stats.size;
  }

  let total = stats.size;
  const entries = await readdir(tracePath, { withFileTypes: true });
  for (const entry of entries) {
    total += await tracePathSizeBytes(join(tracePath, entry.name));
  }
  return total;
}

function resolveSecurityOptions(): ResolvedSecurityOptions {
  const maxDurationSeconds =
    envPositiveNumber('XCTRACE_ANALYZER_MAX_DURATION_SECONDS') ?? DEFAULT_MAX_DURATION_SECONDS;

  return {
    allowLaunchProfiling: envFlag('XCTRACE_ANALYZER_ALLOW_LAUNCH') ?? false,
    allowAllProcessesProfiling: envFlag('XCTRACE_ANALYZER_ALLOW_ALL_PROCESSES') ?? false,
    allowExternalTraceOutput: envFlag('XCTRACE_ANALYZER_ALLOW_EXTERNAL_OUTPUT') ?? false,
    allowExternalTraceCleanup: envFlag('XCTRACE_ANALYZER_ALLOW_EXTERNAL_CLEANUP') ?? false,
    traceRoot: resolve(process.env.XCTRACE_ANALYZER_TRACE_ROOT ?? DEFAULT_TRACE_ROOT),
    maxDurationSeconds,
    redaction: envRedactionMode() ?? 'balanced',
  };
}

function assertPositiveNumber(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
}

function assertDurationWithinLimit(duration: number, security: ResolvedSecurityOptions): void {
  if (duration > security.maxDurationSeconds) {
    throw new Error(
      `duration must be no greater than ${security.maxDurationSeconds}. Increase XCTRACE_ANALYZER_MAX_DURATION_SECONDS only for trusted profiling sessions.`
    );
  }
}

function assertTraceOutputPathAllowed(
  tracePath: string,
  fieldName: string,
  security: ResolvedSecurityOptions
): void {
  if (!tracePath.endsWith('.trace')) {
    throw new Error(`${fieldName} must end in .trace`);
  }
  assertTraceDirectoryAllowed(dirname(tracePath), fieldName, security);
}

function assertTraceDirectoryAllowed(
  directory: string,
  fieldName: string,
  security: ResolvedSecurityOptions
): void {
  if (security.allowExternalTraceOutput || isPathInside(resolve(directory), security.traceRoot)) {
    return;
  }
  throw new Error(
    `${fieldName} must be inside the configured trace root (${security.traceRoot}) unless external trace output is explicitly enabled.`
  );
}

function assertStreamPathAllowed(
  pathValue: string | undefined,
  fieldName: string,
  security: ResolvedSecurityOptions
): void {
  if (!pathValue || pathValue === '-') {
    return;
  }
  const resolvedPath = resolve(pathValue);
  if (security.allowExternalTraceOutput || isPathInside(resolvedPath, security.traceRoot)) {
    return;
  }
  throw new Error(
    `${fieldName} must be "-" or inside the configured trace root (${security.traceRoot}) unless external trace output is explicitly enabled.`
  );
}

function assertCleanupDirectoryAllowed(directory: string, security: ResolvedSecurityOptions): void {
  if (security.allowExternalTraceCleanup || isPathInside(resolve(directory), security.traceRoot)) {
    return;
  }
  throw new Error(
    `Refusing destructive cleanup outside the configured trace root: ${directory}. Set XCTRACE_ANALYZER_ALLOW_EXTERNAL_CLEANUP=1 only for trusted sessions.`
  );
}

function envFlag(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function envPositiveNumber(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function envRedactionMode(): RedactionMode | undefined {
  const value = process.env.XCTRACE_ANALYZER_REDACTION?.trim().toLowerCase();
  if (value === 'balanced' || value === 'strict' || value === 'off') {
    return value;
  }
  return undefined;
}

function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message, envRedactionMode() ?? 'balanced', true);
}

function redactStructuredValue(value: unknown, redaction: RedactionMode): unknown {
  const seen = new WeakMap<object, unknown>();

  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') {
      return redactText(item, redaction, false);
    }
    if (item === null || item === undefined || typeof item !== 'object') {
      return item;
    }
    if (item instanceof Date) {
      return item;
    }
    const cached = seen.get(item);
    if (cached) {
      return cached;
    }
    if (Array.isArray(item)) {
      const out: unknown[] = [];
      seen.set(item, out);
      out.push(...item.map(visit));
      return out;
    }
    const out: Record<string, unknown> = {};
    seen.set(item, out);
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      out[key] = visit(child);
    }
    return out;
  };

  return visit(value);
}

function redactText(value: string, mode: RedactionMode, collapseWhitespace: boolean): string {
  let output = value.replace(/\r\n?/g, '\n');
  output = output.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');

  if (mode !== 'off') {
    output = output
      .replace(/\/Users\/[^/\s]+/g, '/Users/<redacted>')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
      .replace(
        /([?&][^=\s&]*(?:token|secret|password|key|authorization)[^=\s&]*=)[^&\s]+/gi,
        '$1<redacted>'
      )
      .replace(
        /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|authorization)\s*[:=]\s*)(["']?)[^"',\s)]+/gi,
        '$1$2<redacted>'
      );
  }

  if (mode === 'strict') {
    output = output
      .replace(/\bhttps?:\/\/[^/\s?#]+/gi, 'https://<host-redacted>')
      .replace(/\b[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<host-redacted>');
  }

  if (collapseWhitespace) {
    output = output.replace(/\s+/g, ' ').replace(/```/g, "'''").trim();
  }

  return output;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return 'unknown';
  }
  if (Math.abs(ms) < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function safeFileName(value: string): string {
  return value
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'trace';
}

function isPathInside(pathValue: string, root: string): boolean {
  const relation = relative(root, pathValue);
  return relation === '' || (!!relation && !relation.startsWith('..') && !isAbsolute(relation));
}

function codeFenceFor(value: string): string {
  const maxBackticks = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  return '`'.repeat(Math.max(3, maxBackticks + 1));
}

function readPackageVersion(): string {
  try {
    const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function getDefaultTraceRoot(): string {
  return join(homedir(), 'Library', 'Application Support', 'xctrace-analyzer', 'traces');
}

function formatHelp(): string {
  return [
    'xctrace-analyzer',
    '',
    'Usage:',
    '  xctrace-analyzer doctor [--format markdown|json|both]',
    '  xctrace-analyzer list-templates [--json]',
    '  xctrace-analyzer list-devices [--json]',
    '  xctrace-analyzer analyze <trace.trace> [--format both] [--time-range start:end]',
    '  xctrace-analyzer compare <baseline.trace> <current.trace> [--fail-on-regression]',
    '  xctrace-analyzer record --process <pid-or-name> [--preset full] [--duration 60]',
    '  xctrace-analyzer track <template> --process <pid-or-name> [--duration 60]',
    '  xctrace-analyzer cleanup [--dir <path>] [--recursive] [--older-than-minutes n] [--delete]',
    '',
    'Recording targets:',
    '  --process <pid-or-name>       Attach to one running process. Prefer exact PID.',
    '  --launch <command>            Launch target. Requires XCTRACE_ANALYZER_ALLOW_LAUNCH=1.',
    '  --app-identifier <bundle-id>  Launch app identifier. Requires launch permission.',
    '  --all-processes              System-wide trace. Requires XCTRACE_ANALYZER_ALLOW_ALL_PROCESSES=1.',
    '',
    'Recording options:',
    '  --preset <name>               full, full-ios, cpu, memory, network, energy.',
    '  --template <name>             Override the Instruments template.',
    '  --instrument <name>           Add an instrument; repeatable.',
    '  --duration <seconds>          Default 60; capped by XCTRACE_ANALYZER_MAX_DURATION_SECONDS.',
    '  --output <file.trace>         Explicit output path.',
    '  --output-dir <directory>      Defaults to the configured trace root.',
    '  --device <name-or-udid>       xctrace device selector.',
    '  --no-open                    Do not open the saved trace in Instruments.app.',
    '  --no-analyze                 Record only.',
    '',
    `Default trace root: ${DEFAULT_TRACE_ROOT}`,
    '',
  ].join('\n');
}

export function isCliEntrypoint(modulePath: string, argvPath: string | undefined = process.argv[1]): boolean {
  return argvPath ? normalizeEntrypointPath(modulePath) === normalizeEntrypointPath(argvPath) : false;
}

function normalizeEntrypointPath(pathValue: string): string {
  const resolvedPath = resolve(pathValue);
  try {
    return realpathSync(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function isMainModule(): boolean {
  return isCliEntrypoint(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  runCli().then((exitCode) => {
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }).catch((error) => {
    process.stderr.write(`Failed to run CLI: ${formatCliError(error)}\n`);
    process.exit(1);
  });
}

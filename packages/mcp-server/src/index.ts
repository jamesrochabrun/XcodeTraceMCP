#!/usr/bin/env node

/**
 * Xcode Instruments Trace Analyzer MCP Server
 *
 * Provides intelligent analysis of Xcode Instruments traces via Model Context Protocol
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mkdir } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {
  analyzeTraceFile as defaultAnalyzeTraceFile,
  compareTraceFiles as defaultCompareTraceFiles,
  getXCTraceVersion as defaultGetXCTraceVersion,
  isXCTraceAvailable as defaultIsXCTraceAvailable,
  listDevices as defaultListDevices,
  listTemplates as defaultListTemplates,
  recordTrace as defaultRecordTrace,
  Analysis,
  AnalysisOptions,
  Comparison,
  ComparisonOptions,
  RecordOptions,
} from '@xctrace-analyzer/core';

export interface XCTraceAnalyzerDependencies {
  analyzeTraceFile: typeof defaultAnalyzeTraceFile;
  compareTraceFiles: typeof defaultCompareTraceFiles;
  listTemplates: typeof defaultListTemplates;
  listDevices: typeof defaultListDevices;
  isXCTraceAvailable: typeof defaultIsXCTraceAvailable;
  getXCTraceVersion: typeof defaultGetXCTraceVersion;
  recordTrace: typeof defaultRecordTrace;
}

const defaultDependencies: XCTraceAnalyzerDependencies = {
  analyzeTraceFile: defaultAnalyzeTraceFile,
  compareTraceFiles: defaultCompareTraceFiles,
  listTemplates: defaultListTemplates,
  listDevices: defaultListDevices,
  isXCTraceAvailable: defaultIsXCTraceAvailable,
  getXCTraceVersion: defaultGetXCTraceVersion,
  recordTrace: defaultRecordTrace,
};

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

interface ProfileTraceResult {
  template: string;
  tracePath: string;
  analysis?: Analysis;
  error?: string;
}

/**
 * MCP Server for Xcode Instruments trace analysis
 */
export class XCTraceAnalyzerServer {
  private server: Server;
  private deps: XCTraceAnalyzerDependencies;

  constructor(deps: XCTraceAnalyzerDependencies = defaultDependencies) {
    this.deps = deps;
    this.server = new Server(
      {
        name: 'xctrace-analyzer',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getTools(),
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return await this.callTool(request.params.name, request.params.arguments);
    });
  }

  /**
   * Define available MCP tools
   */
  private getTools(): Tool[] {
    return [
      {
        name: 'analyze_trace',
        description: 'Analyze an Xcode Instruments trace file for performance bottlenecks and generate recommendations',
        inputSchema: {
          type: 'object',
          properties: {
            tracePath: {
              type: 'string',
              description: 'Path to the .trace file to analyze',
            },
            slowThreshold: {
              type: 'number',
              description: 'Threshold in milliseconds to consider a function slow (default: 100)',
            },
            topN: {
              type: 'number',
              description: 'Number of top functions to show (default: 10)',
            },
          },
          required: ['tracePath'],
        },
      },
      {
        name: 'compare_traces',
        description: 'Compare two trace files to detect performance regressions or improvements',
        inputSchema: {
          type: 'object',
          properties: {
            baselinePath: {
              type: 'string',
              description: 'Path to the baseline .trace file',
            },
            currentPath: {
              type: 'string',
              description: 'Path to the current .trace file to compare',
            },
            regressionThreshold: {
              type: 'number',
              description: 'Percentage increase to flag as regression (default: 10)',
            },
            failOnRegression: {
              type: 'boolean',
              description: 'Whether to fail if regression is detected (default: false)',
            },
          },
          required: ['baselinePath', 'currentPath'],
        },
      },
      {
        name: 'track_running_app',
        description: 'Record a running app with xctrace, save the .trace file, and optionally analyze it',
        inputSchema: {
          type: 'object',
          properties: {
            processName: {
              type: 'string',
              description: 'Running process name or pid to attach to, for example MyApp',
            },
            template: {
              type: 'string',
              description: 'Instruments template to record with, for example Leaks, Allocations, Network, Power Profiler, or Time Profiler (default: Leaks)',
            },
            durationSeconds: {
              type: 'number',
              description: 'Recording duration in seconds (default: 60)',
            },
            device: {
              type: 'string',
              description: 'Optional device or simulator name/UDID to profile',
            },
            outputDirectory: {
              type: 'string',
              description: 'Directory where the .trace file should be saved (default: test-traces)',
            },
            outputPath: {
              type: 'string',
              description: 'Optional exact output .trace path. Overrides outputDirectory.',
            },
            analyze: {
              type: 'boolean',
              description: 'Analyze the trace after recording (default: true)',
            },
            slowThreshold: {
              type: 'number',
              description: 'Threshold in milliseconds to consider a function slow when analyzing Time Profiler data',
            },
            topN: {
              type: 'number',
              description: 'Number of top functions to show when analyzing Time Profiler data',
            },
          },
          required: ['processName'],
        },
      },
      {
        name: 'profile_running_app',
        description: 'Record a running app once with a profiling preset, save the generated trace, and return one combined report',
        inputSchema: {
          type: 'object',
          properties: {
            processName: {
              type: 'string',
              description: 'Running process name or pid to attach to, for example MyApp',
            },
            preset: {
              type: 'string',
              description: 'Profiling preset: full, full-ios, cpu, memory, network, or energy (default: full)',
            },
            durationSeconds: {
              type: 'number',
              description: 'Total recording duration in seconds (default: 60)',
            },
            device: {
              type: 'string',
              description: 'Optional device or simulator name/UDID to profile',
            },
            outputDirectory: {
              type: 'string',
              description: 'Directory where generated .trace files should be saved (default: test-traces)',
            },
            analyze: {
              type: 'boolean',
              description: 'Analyze traces after recording (default: true)',
            },
            slowThreshold: {
              type: 'number',
              description: 'Threshold in milliseconds to consider a function slow when analyzing Time Profiler data',
            },
            topN: {
              type: 'number',
              description: 'Number of top functions to show when analyzing Time Profiler data',
            },
          },
          required: ['processName'],
        },
      },
      {
        name: 'list_templates',
        description: 'List all available Instruments templates on this system',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'list_devices',
        description: 'List all available devices (simulators and real devices) for profiling',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'check_xctrace',
        description: 'Check if xctrace is available and get version information',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  /**
   * Handle tool calls
   */
  async callTool(toolName: string, args: any): Promise<any> {
    try {
      switch (toolName) {
        case 'analyze_trace':
          return await this.analyzeTrace(args);

        case 'compare_traces':
          return await this.compareTraces(args);

        case 'track_running_app':
          return await this.trackRunningApp(args);

        case 'profile_running_app':
          return await this.profileRunningApp(args);

        case 'list_templates':
          return await this.listTemplates();

        case 'list_devices':
          return await this.listDevices();

        case 'check_xctrace':
          return await this.checkXCTrace();

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (error) {
      const err = error as Error;
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Analyze a trace file
   */
  private async analyzeTrace(args: any) {
    const { tracePath, slowThreshold, topN } = args;

    const options: AnalysisOptions = {
      slowThreshold,
      topN,
      includeRecommendations: true,
    };

    const analysis = await this.deps.analyzeTraceFile(tracePath, options);

    // Format output for Claude
    const output = this.formatAnalysisOutput(analysis);

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  }

  /**
   * Compare two trace files
   */
  private async compareTraces(args: any) {
    const { baselinePath, currentPath, regressionThreshold, failOnRegression } = args;

    const comparisonOptions: ComparisonOptions = {
      regressionThreshold,
      failOnRegression,
    };

    const comparison = await this.deps.compareTraceFiles(
      baselinePath,
      currentPath,
      undefined,
      comparisonOptions
    );

    // Format output
    const output = this.formatComparisonOutput(comparison);

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
      ...(failOnRegression && comparison.hasRegression ? { isError: true } : {}),
    };
  }

  /**
   * Record a running app and optionally analyze the captured trace.
   */
  private async trackRunningApp(args: any) {
    const processName = this.requiredString(args?.processName, 'processName');
    const template = this.optionalString(args?.template, 'template') ?? 'Leaks';
    const duration = this.optionalPositiveNumber(args?.durationSeconds, 'durationSeconds') ?? 60;
    const outputPath = this.traceOutputPath(args, processName, template);

    await mkdir(dirname(outputPath), { recursive: true });

    const recordOptions: RecordOptions = {
      template,
      processName,
      duration,
      outputPath,
      ...(args?.device !== undefined && args?.device !== null
        ? { device: this.requiredString(args.device, 'device') }
        : {}),
    };

    await this.deps.recordTrace(recordOptions);

    const lines = this.formatTrackingHeader({
      processName,
      template,
      duration,
      device: recordOptions.device,
      outputPath,
    });

    if (args?.analyze === false) {
      lines.push('Analysis skipped.');
      return {
        content: [
          {
            type: 'text',
            text: lines.join('\n'),
          },
        ],
      };
    }

    const options: AnalysisOptions = {
      slowThreshold: args?.slowThreshold,
      topN: args?.topN,
      includeRecommendations: true,
    };

    const analysis = await this.deps.analyzeTraceFile(outputPath, options);
    lines.push(this.formatAnalysisOutput(analysis));

    return {
      content: [
        {
          type: 'text',
          text: lines.join('\n'),
        },
      ],
    };
  }

  /**
   * Record a running app with a preset of Instruments templates and return one report.
   */
  private async profileRunningApp(args: any) {
    const processName = this.requiredString(args?.processName, 'processName');
    const preset = this.optionalString(args?.preset, 'preset') ?? 'full';
    const profilePreset = this.profilePresetForName(preset);
    const duration = this.optionalPositiveNumber(args?.durationSeconds, 'durationSeconds') ?? 60;
    const outputDirectory = resolve(
      this.optionalString(args?.outputDirectory, 'outputDirectory') ?? 'test-traces'
    );
    const device = args?.device !== undefined && args?.device !== null
      ? this.requiredString(args.device, 'device')
      : undefined;
    const analyze = args?.analyze !== false;
    const startedAt = new Date().toISOString().replace(/[:.]/g, '-');
    const results: ProfileTraceResult[] = [];

    await mkdir(outputDirectory, { recursive: true });

    const outputPath = this.profileTraceOutputPath(
      outputDirectory,
      processName,
      preset,
      startedAt
    );

    try {
      await this.deps.recordTrace({
        template: profilePreset.template,
        instruments: profilePreset.instruments,
        processName,
        duration,
        outputPath,
        ...(device ? { device } : {}),
      });

      const analysis = analyze
        ? await this.deps.analyzeTraceFile(outputPath, {
          slowThreshold: args?.slowThreshold,
          topN: args?.topN,
          includeRecommendations: true,
        })
        : undefined;

      results.push({ template: profilePreset.template, tracePath: outputPath, analysis });
    } catch (error) {
      results.push({
        template: profilePreset.template,
        tracePath: outputPath,
        error: (error as Error).message,
      });
    }

    const output = this.formatProfileReport({
      processName,
      preset,
      baseTemplate: profilePreset.template,
      instruments: profilePreset.instruments,
      duration,
      device,
      results,
      analyze,
    });

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
      ...(results.every((result) => result.error) ? { isError: true } : {}),
    };
  }

  /**
   * List available templates
   */
  private async listTemplates() {
    const templates = await this.deps.listTemplates();

    return {
      content: [
        {
          type: 'text',
          text: `Available Instruments Templates:\n\n${templates.join('\n')}`,
        },
      ],
    };
  }

  /**
   * List available devices
   */
  private async listDevices() {
    const devices = await this.deps.listDevices();

    return {
      content: [
        {
          type: 'text',
          text: `Available Devices:\n\n${devices.join('\n')}`,
        },
      ],
    };
  }

  /**
   * Check xctrace availability
   */
  private async checkXCTrace() {
    const available = await this.deps.isXCTraceAvailable();

    if (!available) {
      return {
        content: [
          {
            type: 'text',
            text: '❌ xctrace is not available on this system.\n\nThis tool requires Xcode Command Line Tools to be installed on macOS.',
          },
        ],
      };
    }

    const version = await this.deps.getXCTraceVersion();

    return {
      content: [
        {
          type: 'text',
          text: `✅ xctrace is available and ready to use.\n\nVersion: ${version}`,
        },
      ],
    };
  }

  private requiredString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${fieldName} is required`);
    }
    return value.trim();
  }

  private optionalString(value: unknown, fieldName: string): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.requiredString(value, fieldName);
  }

  private optionalPositiveNumber(value: unknown, fieldName: string): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${fieldName} must be a positive number`);
    }
    return value;
  }

  private traceOutputPath(args: any, processName: string, template: string): string {
    if (args?.outputPath) {
      return resolve(this.requiredString(args.outputPath, 'outputPath'));
    }

    const outputDirectory = resolve(
      this.optionalString(args?.outputDirectory, 'outputDirectory') ?? 'test-traces'
    );
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = [
      this.safeFileName(processName),
      this.safeFileName(template),
      timestamp,
    ].join('-');

    return join(outputDirectory, `${fileName}.trace`);
  }

  private profilePresetForName(preset: string): ProfilePreset {
    const profilePreset = PROFILE_PRESETS[preset];
    if (!profilePreset) {
      throw new Error(
        `Unknown profiling preset: ${preset}. Use one of: ${Object.keys(PROFILE_PRESETS).join(', ')}`
      );
    }
    return profilePreset;
  }

  private profileTraceOutputPath(
    outputDirectory: string,
    processName: string,
    template: string,
    timestamp: string
  ): string {
    return join(
      outputDirectory,
      `${this.safeFileName(processName)}-${this.safeFileName(template)}-${timestamp}.trace`
    );
  }

  private safeFileName(value: string): string {
    return value
      .trim()
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'trace';
  }

  private formatTrackingHeader(recording: {
    processName: string;
    template: string;
    duration: number;
    device?: string;
    outputPath: string;
  }): string[] {
    const lines = [
      '# Running App Trace Report',
      '',
      `- Process: ${recording.processName}`,
      `- Template: ${recording.template}`,
      `- Duration: ${recording.duration}s`,
    ];

    if (recording.device) {
      lines.push(`- Device: ${recording.device}`);
    }

    lines.push(`- Trace: ${recording.outputPath}`);
    lines.push('');
    return lines;
  }

  private formatProfileReport(profile: {
    processName: string;
    preset: string;
    baseTemplate: string;
    instruments: string[];
    duration: number;
    device?: string;
    results: ProfileTraceResult[];
    analyze: boolean;
  }): string {
    const lines: string[] = [];
    const failedResults = profile.results.filter((result) => result.error);
    const analyzedResults = profile.results.filter((result) => result.analysis);

    lines.push('# Profiling Report');
    lines.push('');
    lines.push(`- Process: ${profile.processName}`);
    lines.push(`- Preset: ${profile.preset}`);
    lines.push('- Recording strategy: combined');
    lines.push(`- Duration: ${profile.duration}s`);
    lines.push(`- Base template: ${profile.baseTemplate}`);
    lines.push(
      `- Instruments: ${profile.instruments.length > 0 ? profile.instruments.join(', ') : 'none'}`
    );
    if (profile.device) {
      lines.push(`- Device: ${profile.device}`);
    }
    lines.push('');

    lines.push('## Summary');
    lines.push(`- Overall status: ${this.profileStatus(profile.results)}`);
    lines.push(`- Traces recorded: ${profile.results.length - failedResults.length}/${profile.results.length}`);
    lines.push(`- Traces analyzed: ${profile.analyze ? analyzedResults.length : 0}/${profile.results.length}`);
    if (failedResults.length > 0) {
      lines.push(`- Recording failures: ${failedResults.length}`);
    }
    lines.push('');

    lines.push('## Trace Files');
    for (const result of profile.results) {
      lines.push(`- ${result.template}: ${result.tracePath}`);
    }
    lines.push('');

    for (const result of profile.results) {
      lines.push(`## ${this.profileSectionTitle(result.template)}`);
      lines.push(`- Template: ${result.template}`);
      lines.push(`- Trace: ${result.tracePath}`);
      if (profile.instruments.length > 0) {
        lines.push(`- Instruments: ${profile.instruments.join(', ')}`);
      }

      if (result.error) {
        lines.push(`- Error: ${result.error}`);
        lines.push('');
        continue;
      }

      if (!result.analysis) {
        lines.push('Analysis skipped.');
        lines.push('');
        continue;
      }

      lines.push('');
      lines.push(result.analysis.summary);
      lines.push('');
      this.appendCpuHighlights(lines, result.analysis);
      lines.push('');
      this.appendInstrumentSections(lines, result.analysis);
    }

    lines.push('## Prioritized Recommendations');
    const recommendations = this.profileRecommendations(profile.results);
    if (recommendations.length === 0) {
      lines.push('- No high-priority recommendations found in the exported trace data.');
    } else {
      for (const recommendation of recommendations.slice(0, 10)) {
        lines.push(`- ${recommendation}`);
      }
    }

    return lines.join('\n');
  }

  private profileStatus(results: ProfileTraceResult[]): string {
    if (results.every((result) => result.error)) {
      return 'recording failed';
    }

    const severities = results
      .flatMap((result) => result.analysis?.instrumentAnalyses ?? [])
      .flatMap((instrument) => instrument.findings.map((finding) => finding.severity));
    const hasCriticalBottleneck = results.some((result) =>
      result.analysis?.bottlenecks.some((bottleneck) => bottleneck.impact === 'critical')
    );

    if (severities.includes('critical') || hasCriticalBottleneck) {
      return 'critical issues found';
    }
    if (severities.includes('high') || severities.includes('medium')) {
      return 'warnings found';
    }
    if (results.some((result) => result.error)) {
      return 'partial report with recording errors';
    }
    return 'no critical issues found';
  }

  private profileSectionTitle(template: string): string {
    switch (template) {
      case 'Time Profiler':
        return 'CPU / Time Profiler';
      case 'Leaks':
        return 'Leaks';
      case 'Allocations':
        return 'Allocations';
      case 'Network':
        return 'Network';
      case 'Power Profiler':
        return 'Energy / Power';
      default:
        return template;
    }
  }

  private instrumentSectionTitle(kind: string): string {
    switch (kind) {
      case 'memory':
        return 'Memory';
      case 'leaks':
        return 'Leaks';
      case 'allocations':
        return 'Allocations';
      case 'network':
        return 'Network';
      case 'energy':
        return 'Energy / Power';
      default:
        return kind;
    }
  }

  private appendCpuHighlights(lines: string[], analysis: Analysis): void {
    if (analysis.bottlenecks.length > 0) {
      lines.push('**Top Bottlenecks:**');
      for (const bottleneck of analysis.bottlenecks.slice(0, 5)) {
        lines.push(
          `- ${bottleneck.function}: ${bottleneck.duration.toFixed(0)}ms, ${bottleneck.impact} impact`
        );
      }
      lines.push('');
    }
  }

  private appendInstrumentSections(lines: string[], analysis: Analysis): void {
    for (const instrument of analysis.instrumentAnalyses) {
      lines.push(`## ${this.instrumentSectionTitle(instrument.kind)}`);
      lines.push(instrument.summary);
      lines.push('');

      if (instrument.metrics.length > 0) {
        lines.push('**Metrics:**');
        for (const metric of instrument.metrics) {
          lines.push(`- ${metric.name}: ${metric.value}`);
        }
        lines.push('');
      }

      if (instrument.findings.length > 0) {
        lines.push('**Findings:**');
        for (const finding of instrument.findings) {
          lines.push(`- ${finding.title}: ${finding.description}`);
        }
        lines.push('');
      }
    }
  }

  private profileRecommendations(results: ProfileTraceResult[]): string[] {
    const recommendations = new Set<string>();

    for (const result of results) {
      for (const bottleneck of result.analysis?.bottlenecks ?? []) {
        recommendations.add(
          `${bottleneck.impact} CPU issue in ${bottleneck.function}: ${bottleneck.suggestion}`
        );
      }

      for (const instrument of result.analysis?.instrumentAnalyses ?? []) {
        for (const finding of instrument.findings) {
          recommendations.add(
            `${finding.severity} ${instrument.title}: ${finding.title} - ${finding.description}`
          );
        }
      }

      for (const recommendation of result.analysis?.recommendations ?? []) {
        recommendations.add(
          `${recommendation.priority} ${recommendation.title}: ${recommendation.description}`
        );
      }

      if (result.error) {
        recommendations.add(`Recording failed for ${result.template}: ${result.error}`);
      }
    }

    return Array.from(recommendations);
  }

  /**
   * Format analysis output for human readability
   */
  private formatAnalysisOutput(analysis: Analysis): string {
    const lines: string[] = [];

    lines.push('# Performance Analysis Report');
    lines.push('');
    lines.push(`**File:** ${analysis.metadata.fileName}`);
    lines.push(`**Duration:** ${(analysis.stats.totalTime / 1000).toFixed(2)}s`);
    lines.push(`**Template:** ${analysis.metadata.template}`);
    lines.push('');

    // Summary
    lines.push('## Summary');
    lines.push(analysis.summary);
    lines.push('');

    // Statistics
    lines.push('## Performance Statistics');
    lines.push(`- Total execution time: ${(analysis.stats.totalTime / 1000).toFixed(2)}s`);
    lines.push(`- Slow functions: ${analysis.stats.slowFunctions}`);
    lines.push(`- Average function time: ${analysis.stats.avgFunctionTime.toFixed(2)}ms`);
    lines.push(`- Max function time: ${analysis.stats.maxFunctionTime.toFixed(2)}ms`);
    lines.push(`- Threads used: ${analysis.stats.threadCount}`);
    lines.push('');

    // Bottlenecks
    if (analysis.bottlenecks.length > 0) {
      lines.push('## Performance Bottlenecks');
      lines.push('');

      for (let i = 0; i < Math.min(5, analysis.bottlenecks.length); i++) {
        const b = analysis.bottlenecks[i];
        const icon = b.impact === 'critical' ? '🔴' : b.impact === 'high' ? '🟠' : '🟡';
        lines.push(`### ${icon} ${i + 1}. ${b.function}`);
        lines.push(`- **Impact:** ${b.impact}`);
        lines.push(`- **Duration:** ${b.duration.toFixed(0)}ms (${b.percentage.toFixed(1)}% of total)`);
        lines.push(`- **Call count:** ${b.callCount}`);
        lines.push(`- **Suggestion:** ${b.suggestion}`);
        lines.push('');
      }
    }

    if (analysis.instrumentAnalyses.length > 0) {
      lines.push('## Additional Instrument Analysis');
      lines.push('');

      for (const instrument of analysis.instrumentAnalyses) {
        lines.push(`### ${instrument.title}`);
        lines.push(instrument.summary);
        lines.push('');

        if (instrument.metrics.length > 0) {
          lines.push('**Metrics:**');
          for (const metric of instrument.metrics) {
            lines.push(`- ${metric.name}: ${metric.value}`);
          }
          lines.push('');
        }

        if (instrument.findings.length > 0) {
          lines.push('**Findings:**');
          for (const finding of instrument.findings) {
            lines.push(`- **${finding.title}:** ${finding.description}`);
          }
          lines.push('');
        }

        if (instrument.sourceSchemas.length > 0) {
          lines.push(`_Source: ${instrument.sourceSchemas.join(', ')}_`);
          lines.push('');
        }
      }
    }

    // Recommendations
    if (analysis.recommendations.length > 0) {
      lines.push('## Optimization Recommendations');
      lines.push('');

      for (let i = 0; i < Math.min(3, analysis.recommendations.length); i++) {
        const r = analysis.recommendations[i];
        const icon = r.priority === 'high' ? '⚠️' : r.priority === 'medium' ? 'ℹ️' : '💡';
        lines.push(`### ${icon} ${r.title}`);
        lines.push(`**Priority:** ${r.priority} | **Type:** ${r.type}`);
        lines.push('');
        lines.push(r.description);
        lines.push('');
        lines.push(`**Potential improvement:** ${r.potentialImprovement}`);

        if (r.codeExample) {
          lines.push('');
          lines.push('**Example:**');
          lines.push('```swift');
          lines.push(r.codeExample);
          lines.push('```');
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Format comparison output
   */
  private formatComparisonOutput(comparison: Comparison): string {
    const lines: string[] = [];

    lines.push('# Trace Comparison Report');
    lines.push('');
    lines.push(`**Baseline:** ${comparison.baseline.metadata.fileName}`);
    lines.push(`**Current:** ${comparison.current.metadata.fileName}`);
    lines.push('');

    // Summary
    lines.push('## Summary');
    lines.push(comparison.summary);
    lines.push('');

    // Performance Delta
    lines.push('## Performance Delta');
    const deltaMs = comparison.delta.totalTimeChange;
    const deltaPercent = comparison.delta.totalTimeChangePercent;
    const icon = deltaPercent > 5 ? '⚠️' : deltaPercent < -5 ? '✅' : '✓';
    lines.push(`${icon} Total time change: ${deltaMs > 0 ? '+' : ''}${(deltaMs / 1000).toFixed(2)}s (${deltaPercent > 0 ? '+' : ''}${deltaPercent.toFixed(1)}%)`);
    lines.push(`- Regressions: ${comparison.delta.functionChanges.regressions}`);
    lines.push(`- Improvements: ${comparison.delta.functionChanges.improvements}`);
    lines.push(`- Unchanged: ${comparison.delta.functionChanges.unchanged}`);
    lines.push('');

    // Regressions
    if (comparison.regressions.length > 0) {
      lines.push('## Regressions');
      lines.push('');

      for (let i = 0; i < Math.min(5, comparison.regressions.length); i++) {
        const r = comparison.regressions[i];
        const icon = r.severity === 'critical' ? '🔴' : r.severity === 'major' ? '🟠' : '🟡';
        lines.push(`${icon} **${r.function}** (${r.severity})`);
        lines.push(`  ${r.baselineTime.toFixed(0)}ms → ${r.currentTime.toFixed(0)}ms (+${r.percentageIncrease.toFixed(0)}%)`);
        lines.push('');
      }
    }

    // Improvements
    if (comparison.improvements.length > 0) {
      lines.push('## Improvements');
      lines.push('');

      for (let i = 0; i < Math.min(5, comparison.improvements.length); i++) {
        const imp = comparison.improvements[i];
        lines.push(`✅ **${imp.function}**`);
        lines.push(`  ${imp.baselineTime.toFixed(0)}ms → ${imp.currentTime.toFixed(0)}ms (-${imp.percentageDecrease.toFixed(0)}%)`);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Start the MCP server
   */
  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('Xcode Instruments Trace Analyzer MCP Server running on stdio');
  }
}

function isMainModule(): boolean {
  return process.argv[1]
    ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
    : false;
}

if (isMainModule()) {
  const server = new XCTraceAnalyzerServer();
  server.start().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

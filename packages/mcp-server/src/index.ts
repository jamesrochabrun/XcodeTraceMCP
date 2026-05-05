#!/usr/bin/env node

/**
 * Xcode Instruments Trace Analyzer MCP Server
 *
 * Provides intelligent analysis of Xcode Instruments traces via Model Context Protocol
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mkdir, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchemaValidator, jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';

import {
  analyzeTraceFile as defaultAnalyzeTraceFile,
  compareTraceFiles as defaultCompareTraceFiles,
  getXCTraceVersion as defaultGetXCTraceVersion,
  getXCTraceCapabilities as defaultGetXCTraceCapabilities,
  isXCTraceAvailable as defaultIsXCTraceAvailable,
  listDevices as defaultListDevices,
  listTemplates as defaultListTemplates,
  recordTrace as defaultRecordTrace,
  symbolicateTrace as defaultSymbolicateTrace,
  Analysis,
  AnalysisOptions,
  Comparison,
  ComparisonOptions,
  RecordOptions,
  XCTraceCapabilities,
} from '@xctrace-analyzer/core';

export interface XCTraceAnalyzerDependencies {
  analyzeTraceFile: typeof defaultAnalyzeTraceFile;
  compareTraceFiles: typeof defaultCompareTraceFiles;
  listTemplates: typeof defaultListTemplates;
  listDevices: typeof defaultListDevices;
  isXCTraceAvailable: typeof defaultIsXCTraceAvailable;
  getXCTraceVersion: typeof defaultGetXCTraceVersion;
  getXCTraceCapabilities?: typeof defaultGetXCTraceCapabilities;
  recordTrace: typeof defaultRecordTrace;
  symbolicateTrace?: typeof defaultSymbolicateTrace;
}

const defaultDependencies: XCTraceAnalyzerDependencies = {
  analyzeTraceFile: defaultAnalyzeTraceFile,
  compareTraceFiles: defaultCompareTraceFiles,
  listTemplates: defaultListTemplates,
  listDevices: defaultListDevices,
  isXCTraceAvailable: defaultIsXCTraceAvailable,
  getXCTraceVersion: defaultGetXCTraceVersion,
  getXCTraceCapabilities: defaultGetXCTraceCapabilities,
  recordTrace: defaultRecordTrace,
  symbolicateTrace: defaultSymbolicateTrace,
};

const passthroughJsonSchemaValidator: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown) => ({
      valid: true,
      data: input as T,
      errorMessage: undefined,
    });
  },
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

type OutputFormat = 'markdown' | 'json' | 'both';

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
        // This server does not issue elicitation requests, so avoid the SDK's
        // default AJV startup path.
        jsonSchemaValidator: passthroughJsonSchemaValidator,
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
        name: 'profile_advisor',
        description: 'Use first for vague profiling requests like "profile my app"; suggests the best recording or analysis workflow and exact next tool calls',
        inputSchema: {
          type: 'object',
          properties: {
            request: {
              type: 'string',
              description: 'Natural-language profiling request or goal',
            },
            processName: {
              type: 'string',
              description: 'Running process name or pid, if known. Prefer a pid when multiple app instances may be running.',
            },
            launchCommand: {
              type: 'string',
              description: 'Command, app path, or bundle identifier to launch, if startup behavior is the target',
            },
            tracePath: {
              type: 'string',
              description: 'Existing .trace path, if the user wants analysis rather than recording',
            },
            baselinePath: {
              type: 'string',
              description: 'Baseline .trace path for regression comparison',
            },
            currentPath: {
              type: 'string',
              description: 'Current .trace path for regression comparison',
            },
            platform: {
              type: 'string',
              enum: ['macos', 'ios', 'unknown'],
              description: 'Target platform, used to choose between full and full-ios presets',
            },
            durationSeconds: {
              type: 'number',
              description: 'Preferred recording duration in seconds (default: 60)',
            },
            outputFormat: {
              type: 'string',
              enum: ['markdown', 'json', 'both'],
              description: 'Response format: markdown, json, or both (default: markdown)',
            },
          },
          required: [],
        },
      },
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
            dsymPath: {
              type: 'string',
              description: 'Optional dSYM path or directory. The server symbolicates to a temporary trace before analysis.',
            },
            outputFormat: {
              type: 'string',
              enum: ['markdown', 'json', 'both'],
              description: 'Response format: markdown, json, or both (default: markdown)',
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
            baselineDsymPath: {
              type: 'string',
              description: 'Optional dSYM path or directory for the baseline trace',
            },
            currentDsymPath: {
              type: 'string',
              description: 'Optional dSYM path or directory for the current trace',
            },
            outputFormat: {
              type: 'string',
              enum: ['markdown', 'json', 'both'],
              description: 'Response format: markdown, json, or both (default: markdown)',
            },
          },
          required: ['baselinePath', 'currentPath'],
        },
      },
      {
        name: 'track_running_app',
        description: 'Record one explicit Instruments template. Use this when the user names a template such as Leaks or Allocations; for broad hangs/CPU profiling prefer profile_advisor or profile_running_app.',
        inputSchema: {
          type: 'object',
          properties: {
            processName: {
              type: 'string',
              description: 'Running process name or pid to attach to, for example MyApp. Use a pid when the name is ambiguous.',
            },
            target: {
              type: 'string',
              enum: ['attach', 'launch', 'all-processes'],
              description: 'Recording target mode. Defaults to attach when processName is provided.',
            },
            launchCommand: {
              type: 'string',
              description: 'Command, app path, or bundle identifier to launch when startup/cold-launch behavior is the target. Prefer processName with a PID for already-running apps.',
            },
            launchArguments: {
              type: 'array',
              items: { type: 'string' },
              description: 'Arguments passed after the launched command',
            },
            environment: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Environment variables for launch recordings',
            },
            targetStdin: {
              type: 'string',
              description: 'Standard input redirection for launch recordings',
            },
            targetStdout: {
              type: 'string',
              description: 'Standard output redirection for launch recordings',
            },
            allProcesses: {
              type: 'boolean',
              description: 'Record all processes. Equivalent to target: all-processes.',
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
            outputFormat: {
              type: 'string',
              enum: ['markdown', 'json', 'both'],
              description: 'Response format: markdown, json, or both (default: markdown)',
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
          required: [],
        },
      },
      {
        name: 'profile_running_app',
        description: 'Record an app once with a profiling preset and return one combined report. Prefer attach-by-PID for already-running apps; use launch mode only for startup/cold-launch profiling.',
        inputSchema: {
          type: 'object',
          properties: {
            processName: {
              type: 'string',
              description: 'Running process name or pid to attach to, for example MyApp. Use a pid when the name is ambiguous.',
            },
            target: {
              type: 'string',
              enum: ['attach', 'launch', 'all-processes'],
              description: 'Recording target mode. Defaults to attach when processName is provided.',
            },
            launchCommand: {
              type: 'string',
              description: 'Command, app path, or bundle identifier to launch when startup/cold-launch behavior is the target. Prefer processName with a PID for already-running apps.',
            },
            launchArguments: {
              type: 'array',
              items: { type: 'string' },
              description: 'Arguments passed after the launched command',
            },
            environment: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Environment variables for launch recordings',
            },
            targetStdin: {
              type: 'string',
              description: 'Standard input redirection for launch recordings',
            },
            targetStdout: {
              type: 'string',
              description: 'Standard output redirection for launch recordings',
            },
            allProcesses: {
              type: 'boolean',
              description: 'Record all processes. Equivalent to target: all-processes.',
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
            outputFormat: {
              type: 'string',
              enum: ['markdown', 'json', 'both'],
              description: 'Response format: markdown, json, or both (default: markdown)',
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
          required: [],
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
        case 'profile_advisor':
          return await this.profileAdvisor(args);

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
            text: this.formatToolError(err),
          },
        ],
        isError: true,
      };
    }
  }

  private formatToolError(error: Error): string {
    const message = `Error: ${error.message}`;
    if (!this.isTraceTocExportFailure(error.message)) {
      return message;
    }

    return [
      message,
      '',
      '## Next Steps',
      ...this.traceExportFailureNextSteps().map((step) => `- ${step}`),
    ].join('\n');
  }

  /**
   * Suggest the best profiling workflow for vague user requests.
   */
  private async profileAdvisor(args: any) {
    const outputFormat = this.outputFormat(args);
    const request = this.optionalString(args?.request, 'request') ?? 'Profile my app';
    const duration = this.optionalPositiveNumber(args?.durationSeconds, 'durationSeconds') ?? 60;
    const platform = this.optionalString(args?.platform, 'platform') ?? 'unknown';
    if (!['macos', 'ios', 'unknown'].includes(platform)) {
      throw new Error('platform must be macos, ios, or unknown');
    }

    const capabilities = this.deps.getXCTraceCapabilities
      ? await this.deps.getXCTraceCapabilities()
      : await this.fallbackCapabilities();
    const target = this.advisorTarget(args);
    const intent = this.inferProfilingIntent(request, args);
    const recommendations = this.advisorRecommendations({
      args,
      request,
      intent,
      duration,
      platform,
      target,
    });
    const workflowNotes = this.advisorWorkflowNotes(target);

    const structured = {
      request,
      inferredIntent: intent,
      target,
      capabilities,
      recommended: recommendations[0],
      options: recommendations,
      workflowNotes,
    };

    return {
      content: [
        {
          type: 'text',
          text: this.formatToolOutput(
            this.formatProfileAdvisorOutput(structured),
            structured,
            outputFormat
          ),
        },
      ],
    };
  }

  /**
   * Analyze a trace file
   */
  private async analyzeTrace(args: any) {
    const { slowThreshold, topN } = args;
    const tracePath = this.requiredString(args?.tracePath, 'tracePath');
    const outputFormat = this.outputFormat(args);
    const preparedTracePath = await this.prepareTraceForAnalysis(
      tracePath,
      this.optionalString(args?.dsymPath, 'dsymPath')
    );

    const options: AnalysisOptions = {
      slowThreshold,
      topN,
      includeRecommendations: true,
    };

    const analysis = await this.deps.analyzeTraceFile(preparedTracePath, options);
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

    // Format output for Claude
    const output = this.formatAnalysisOutput(analysis);
    const text = this.formatToolOutput(output, this.structuredAnalysis(analysis), outputFormat);

    return {
      content: [
        {
          type: 'text',
          text,
        },
      ],
    };
  }

  /**
   * Compare two trace files
   */
  private async compareTraces(args: any) {
    const { baselinePath, currentPath, regressionThreshold, failOnRegression } = args;
    const outputFormat = this.outputFormat(args);
    const preparedBaselinePath = await this.prepareTraceForAnalysis(
      this.requiredString(baselinePath, 'baselinePath'),
      this.optionalString(args?.baselineDsymPath, 'baselineDsymPath')
    );
    const preparedCurrentPath = await this.prepareTraceForAnalysis(
      this.requiredString(currentPath, 'currentPath'),
      this.optionalString(args?.currentDsymPath, 'currentDsymPath')
    );

    const comparisonOptions: ComparisonOptions = {
      regressionThreshold,
      failOnRegression,
    };

    const comparison = await this.deps.compareTraceFiles(
      preparedBaselinePath,
      preparedCurrentPath,
      undefined,
      comparisonOptions
    );

    // Format output
    const output = this.formatComparisonOutput(comparison);
    const text = this.formatToolOutput(output, comparison, outputFormat);

    return {
      content: [
        {
          type: 'text',
          text,
        },
      ],
      ...(failOnRegression && comparison.hasRegression ? { isError: true } : {}),
    };
  }

  /**
   * Record a running app and optionally analyze the captured trace.
   */
  private async trackRunningApp(args: any) {
    const target = this.recordTargetOptions(args);
    const template = this.optionalString(args?.template, 'template') ?? 'Leaks';
    const duration = this.optionalPositiveNumber(args?.durationSeconds, 'durationSeconds') ?? 60;
    const outputFormat = this.outputFormat(args);
    const outputPath = this.traceOutputPath(args, target.fileLabel, template);

    await mkdir(dirname(outputPath), { recursive: true });

    const recordOptions: RecordOptions = {
      template,
      ...target.recordOptions,
      duration,
      outputPath,
      ...(args?.device !== undefined && args?.device !== null
        ? { device: this.requiredString(args.device, 'device') }
        : {}),
    };

    await this.deps.recordTrace(recordOptions);

    const lines = this.formatTrackingHeader({
      target: target.reportLabel,
      template,
      duration,
      device: recordOptions.device,
      outputPath,
      workflowWarnings: target.workflowWarnings,
    });

    if (args?.analyze === false) {
      lines.push('Analysis skipped.');
      return {
        content: [
          {
            type: 'text',
            text: this.formatToolOutput(
              lines.join('\n'),
              {
                recording: {
                  target: target.reportLabel,
                  template,
                  duration,
                  outputPath,
                  workflowWarnings: target.workflowWarnings,
                },
                analysis: null,
              },
              outputFormat
            ),
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
    const markdown = lines.join('\n');

    return {
      content: [
        {
          type: 'text',
          text: this.formatToolOutput(
            markdown,
            {
              recording: {
                target: target.reportLabel,
                template,
                duration,
                outputPath,
                workflowWarnings: target.workflowWarnings,
              },
              ...this.structuredAnalysis(analysis),
            },
            outputFormat
          ),
        },
      ],
    };
  }

  /**
   * Record a running app with a preset of Instruments templates and return one report.
   */
  private async profileRunningApp(args: any) {
    const target = this.recordTargetOptions(args);
    const preset = this.optionalString(args?.preset, 'preset') ?? 'full';
    const profilePreset = this.profilePresetForName(preset);
    const duration = this.optionalPositiveNumber(args?.durationSeconds, 'durationSeconds') ?? 60;
    const outputFormat = this.outputFormat(args);
    const outputDirectory = resolve(
      this.optionalString(args?.outputDirectory, 'outputDirectory') ?? 'test-traces'
    );
    const device = args?.device !== undefined && args?.device !== null
      ? this.requiredString(args.device, 'device')
      : undefined;
    const analyze = args?.analyze !== false;
    const startedAt = new Date().toISOString().replace(/[:.]/g, '-');
    const results: ProfileTraceResult[] = [];
    const capabilityWarnings = await this.profileCapabilityWarnings(profilePreset);

    await mkdir(outputDirectory, { recursive: true });

    const outputPath = this.profileTraceOutputPath(
      outputDirectory,
      target.fileLabel,
      preset,
      startedAt
    );

    try {
      await this.deps.recordTrace({
        template: profilePreset.template,
        instruments: profilePreset.instruments,
        ...target.recordOptions,
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
      target: target.reportLabel,
      preset,
      baseTemplate: profilePreset.template,
      instruments: profilePreset.instruments,
      duration,
      device,
      results,
      analyze,
      capabilityWarnings,
      workflowWarnings: target.workflowWarnings,
    });
    const text = this.formatToolOutput(
      output,
      {
        recording: {
          target: target.reportLabel,
          preset,
          baseTemplate: profilePreset.template,
          instruments: profilePreset.instruments,
          duration,
          device,
          capabilityWarnings,
          workflowWarnings: target.workflowWarnings,
        },
        results: results.map((result) => ({
          template: result.template,
          tracePath: result.tracePath,
          error: result.error,
          analysis: result.analysis ? this.structuredAnalysis(result.analysis) : undefined,
        })),
      },
      outputFormat
    );

    return {
      content: [
        {
          type: 'text',
          text,
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
    const capabilities = this.deps.getXCTraceCapabilities
      ? await this.deps.getXCTraceCapabilities()
      : await this.fallbackCapabilities();

    if (!capabilities.available) {
      return {
        content: [
          {
            type: 'text',
            text: '❌ xctrace is not available on this system.\n\nThis tool requires Xcode Command Line Tools to be installed on macOS.',
          },
        ],
      };
    }

    const lines = [
      '✅ xctrace is available and ready to use.',
      '',
      `Version: ${capabilities.version ?? 'unknown'}`,
      '',
      'Capabilities:',
      `- Record modes: ${capabilities.recordModes.join(', ') || 'none detected'}`,
      `- Export modes: ${capabilities.exportModes.join(', ') || 'none detected'}`,
      `- Symbolication: ${capabilities.supportsSymbolication ? 'available' : 'not detected'}`,
      `- Templates detected: ${capabilities.templates.length}`,
      `- Devices detected: ${capabilities.devices.length}`,
      `- Addable instruments detected: ${capabilities.instruments.length}`,
    ];

    if (capabilities.templates.length > 0) {
      lines.push('');
      lines.push('Templates:');
      lines.push(...capabilities.templates.map((template) => `- ${template}`));
    }

    if (capabilities.warnings.length > 0) {
      lines.push('');
      lines.push('Warnings:');
      lines.push(...capabilities.warnings.map((warning) => `- ${warning}`));
    }

    return {
      content: [
        {
          type: 'text',
          text: lines.join('\n'),
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

  private outputFormat(args: any): OutputFormat {
    const value = this.optionalString(args?.outputFormat, 'outputFormat') ?? 'markdown';
    if (value !== 'markdown' && value !== 'json' && value !== 'both') {
      throw new Error('outputFormat must be markdown, json, or both');
    }
    return value;
  }

  private formatToolOutput(markdown: string, structured: unknown, outputFormat: OutputFormat): string {
    if (outputFormat === 'markdown') {
      return markdown;
    }

    const json = JSON.stringify(structured, null, 2);
    if (outputFormat === 'json') {
      return json;
    }

    return `${markdown}\n\n## Structured Result\n\n\`\`\`json\n${json}\n\`\``;
  }

  private structuredAnalysis(analysis: Analysis) {
    return {
      analysis,
      supportStatus: analysis.supportStatus ?? [],
      exportAttempts: analysis.exportAttempts ?? [],
    };
  }

  private async prepareTraceForAnalysis(tracePath: string, dsymPath?: string): Promise<string> {
    if (!dsymPath) {
      return tracePath;
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'xctrace-analyzer-'));
    const outputPath = join(tempDir, `${this.safeFileName(basename(tracePath, '.trace'))}-symbolicated.trace`);
    const symbolicateTrace = this.deps.symbolicateTrace ?? defaultSymbolicateTrace;
    await symbolicateTrace({
      inputPath: tracePath,
      outputPath,
      dsymPath,
    });
    return outputPath;
  }

  private recordTargetOptions(args: any): {
    fileLabel: string;
    reportLabel: string;
    workflowWarnings: string[];
    recordOptions: Pick<
      RecordOptions,
      | 'processName'
      | 'allProcesses'
      | 'launchCommand'
      | 'launchArguments'
      | 'environment'
      | 'targetStdin'
      | 'targetStdout'
    >;
  } {
    const target = this.optionalString(args?.target, 'target');
    if (target && !['attach', 'launch', 'all-processes'].includes(target)) {
      throw new Error('target must be attach, launch, or all-processes');
    }

    const launchCommand =
      this.optionalString(args?.launchCommand, 'launchCommand') ??
      this.optionalString(args?.appIdentifier, 'appIdentifier');

    if (target === 'all-processes' || args?.allProcesses === true) {
      return {
        fileLabel: 'all-processes',
        reportLabel: 'all processes',
        workflowWarnings: [],
        recordOptions: { allProcesses: true },
      };
    }

    if (target === 'launch' || launchCommand) {
      const command = launchCommand ?? this.requiredString(args?.launchCommand, 'launchCommand');
      return {
        fileLabel: command,
        reportLabel: `launch: ${command}`,
        workflowWarnings: [
          `Launch target "${command}" records startup/cold-launch behavior. For general hangs or CPU bottlenecks in an already-running app, prefer attach-by-PID. Launch traces can be saved but fail TOC export on some Xcode setups.`,
        ],
        recordOptions: {
          launchCommand: command,
          launchArguments: this.optionalStringArray(args?.launchArguments, 'launchArguments'),
          environment: this.optionalStringMap(args?.environment, 'environment'),
          targetStdin: this.optionalString(args?.targetStdin, 'targetStdin'),
          targetStdout: this.optionalString(args?.targetStdout, 'targetStdout'),
        },
      };
    }

    const processName = this.requiredString(args?.processName, 'processName');
    const workflowWarnings = /^\d+$/.test(processName)
      ? []
      : [
          `Attach target "${processName}" is a process name, not a PID. If multiple processes share this name, xctrace may fail as ambiguous; use profile_advisor first or rerun with the exact PID in processName.`,
        ];
    return {
      fileLabel: processName,
      reportLabel: `attach: ${processName}`,
      workflowWarnings,
      recordOptions: { processName },
    };
  }

  private optionalStringArray(value: unknown, fieldName: string): string[] | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`${fieldName} must be an array of strings`);
    }
    return value;
  }

  private optionalStringMap(value: unknown, fieldName: string): Record<string, string> | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.entries(value as Record<string, unknown>).some(
        ([key, item]) => typeof key !== 'string' || typeof item !== 'string'
      )
    ) {
      throw new Error(`${fieldName} must be an object with string values`);
    }
    return value as Record<string, string>;
  }

  private async fallbackCapabilities(): Promise<XCTraceCapabilities> {
    const available = await this.deps.isXCTraceAvailable();
    if (!available) {
      return {
        available: false,
        templates: [],
        devices: [],
        instruments: [],
        exportModes: [],
        recordModes: [],
        supportsSymbolication: false,
        warnings: ['xctrace is not available.'],
      };
    }

    return {
      available: true,
      version: await this.deps.getXCTraceVersion(),
      templates: await this.deps.listTemplates(),
      devices: await this.deps.listDevices(),
      instruments: [],
      exportModes: ['toc', 'xpath', 'har'],
      recordModes: ['attach', 'launch', 'all-processes'],
      supportsSymbolication: true,
      warnings: [],
    };
  }

  private async profileCapabilityWarnings(profilePreset: ProfilePreset): Promise<string[]> {
    const getCapabilities = this.deps.getXCTraceCapabilities;
    if (!getCapabilities) {
      return [];
    }

    const capabilities = await getCapabilities();
    const warnings = [...capabilities.warnings];
    if (!capabilities.available) {
      warnings.push('xctrace is not available; recording will fail until Xcode Command Line Tools are configured.');
      return warnings;
    }

    if (
      capabilities.templates.length > 0 &&
      !this.includesCaseInsensitive(capabilities.templates, profilePreset.template)
    ) {
      warnings.push(
        `Template "${profilePreset.template}" was not listed by xctrace; recording will still be attempted.`
      );
    }

    if (capabilities.instruments.length > 0) {
      for (const instrument of profilePreset.instruments) {
        if (!this.includesCaseInsensitive(capabilities.instruments, instrument)) {
          warnings.push(
            `Instrument "${instrument}" was not listed by xctrace; recording will still be attempted.`
          );
        }
      }
    }

    return warnings;
  }

  private includesCaseInsensitive(values: string[], expected: string): boolean {
    const lower = expected.toLowerCase();
    return values.some((value) => value.toLowerCase() === lower);
  }

  private advisorTarget(args: any): {
    mode: 'attach' | 'launch' | 'all-processes' | 'unknown';
    label: string;
    args: Record<string, unknown>;
  } {
    const processName = this.optionalString(args?.processName, 'processName');
    const launchCommand = this.optionalString(args?.launchCommand, 'launchCommand');
    if (args?.allProcesses === true) {
      return { mode: 'all-processes', label: 'all processes', args: { target: 'all-processes' } };
    }
    if (launchCommand) {
      return {
        mode: 'launch',
        label: launchCommand,
        args: { target: 'launch', launchCommand },
      };
    }
    if (processName) {
      return {
        mode: 'attach',
        label: processName,
        args: { processName },
      };
    }
    return {
      mode: 'unknown',
      label: 'target not specified',
      args: {},
    };
  }

  private inferProfilingIntent(request: string, args: any): string {
    const text = [
      request,
      args?.tracePath ? 'trace' : '',
      args?.baselinePath && args?.currentPath ? 'compare regression' : '',
    ].join(' ').toLowerCase();

    if (args?.baselinePath && args?.currentPath || /compar|regress|baseline/.test(text)) {
      return 'compare';
    }
    if (args?.tracePath || /analy[sz]e|existing trace|trace file/.test(text)) {
      return 'analyze';
    }
    if (/leak/.test(text)) {
      return 'leaks';
    }
    if (/alloc|memory|retain|heap/.test(text)) {
      return 'memory';
    }
    if (/network|http|request|url/.test(text)) {
      return 'network';
    }
    if (/energy|battery|power/.test(text)) {
      return 'energy';
    }
    if (/cpu|time profiler|slow|hang|freeze|stutter|performance/.test(text)) {
      return 'cpu';
    }
    return 'full';
  }

  private advisorRecommendations(input: {
    args: any;
    request: string;
    intent: string;
    duration: number;
    platform: string;
    target: { mode: string; label: string; args: Record<string, unknown> };
  }): Array<{
    label: string;
    when: string;
    tool: string;
    arguments: Record<string, unknown>;
  }> {
    const targetArgs = input.target.args;
    const defaultTargetHint = input.target.mode === 'unknown'
      ? { processName: '<running process name>' }
      : targetArgs;
    const profileTargetArgs = input.target.mode === 'unknown'
      ? defaultTargetHint
      : targetArgs;
    const fullPreset = input.platform === 'ios' ? 'full-ios' : 'full';

    const options = [
      {
        label: 'Full performance report',
        when: 'Best first pass when the problem is broad or unclear.',
        tool: 'profile_running_app',
        arguments: {
          ...profileTargetArgs,
          preset: fullPreset,
          durationSeconds: input.duration,
          outputFormat: 'both',
        },
      },
      {
        label: 'CPU and hangs',
        when: 'Use for slow UI, hangs, freezes, hot functions, or general CPU cost.',
        tool: 'profile_running_app',
        arguments: {
          ...profileTargetArgs,
          preset: 'cpu',
          durationSeconds: input.duration,
          outputFormat: 'both',
        },
      },
      {
        label: 'Leaks and allocation churn',
        when: 'Use for memory growth, suspected leaks, retain cycles, or high allocation volume.',
        tool: 'profile_running_app',
        arguments: {
          ...profileTargetArgs,
          preset: 'memory',
          durationSeconds: input.duration,
          outputFormat: 'both',
        },
      },
      {
        label: 'Network requests',
        when: 'Use for failed requests, transfer volume, HTTP timing, or top hosts.',
        tool: 'profile_running_app',
        arguments: {
          ...profileTargetArgs,
          preset: 'network',
          durationSeconds: input.duration,
          outputFormat: 'both',
        },
      },
      {
        label: 'Analyze existing trace',
        when: 'Use when a .trace file already exists.',
        tool: 'analyze_trace',
        arguments: {
          tracePath: input.args?.tracePath ?? '<path/to/app.trace>',
          outputFormat: 'both',
        },
      },
      {
        label: 'Compare baseline vs current',
        when: 'Use for CI or before/after regression checks.',
        tool: 'compare_traces',
        arguments: {
          baselinePath: input.args?.baselinePath ?? '<path/to/baseline.trace>',
          currentPath: input.args?.currentPath ?? '<path/to/current.trace>',
          failOnRegression: false,
          outputFormat: 'both',
        },
      },
    ];

    const priorityByIntent: Record<string, string[]> = {
      compare: ['Compare baseline vs current'],
      analyze: ['Analyze existing trace'],
      leaks: ['Leaks and allocation churn', 'Full performance report'],
      memory: ['Leaks and allocation churn', 'Full performance report'],
      network: ['Network requests', 'Full performance report'],
      energy: ['Full performance report'],
      cpu: ['CPU and hangs', 'Full performance report'],
      full: ['Full performance report'],
    };
    const priority = priorityByIntent[input.intent] ?? priorityByIntent.full;

    return [...options].sort((a, b) => {
      const aIndex = priority.indexOf(a.label);
      const bIndex = priority.indexOf(b.label);
      const aRank = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
      const bRank = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
      return aRank - bRank;
    });
  }

  private advisorWorkflowNotes(target: {
    mode: 'attach' | 'launch' | 'all-processes' | 'unknown' | string;
    label: string;
  }): string[] {
    const notes = [
      'Default recording duration is 60s. Use 20-30s only for explicit startup/cold-launch checks; otherwise record long enough to reproduce the hang.',
      'Use outputFormat: "both" while validating a profiling workflow so the report includes Markdown plus structured supportStatus/exportAttempts.',
      'For already-running macOS apps, attach by PID is the most reliable path when multiple app instances are running.',
      'A clean idle attach trace does not rule out startup or interaction hangs; reproduce the problematic workflow during the recording window.',
      'If Time Profiler, Hangs, or another family reports not_exportable, inspect Export Diagnostics before drawing performance conclusions.',
    ];

    if (target.mode === 'launch') {
      notes.push(
        'Do not select launch mode just because a built .app path exists; use it only when startup behavior is the explicit target.',
      );
      notes.push(
        'Launch-mode traces can be saved but still fail xctrace export --toc with Document Missing Template Error; treat that as an exportability failure and retry with attach-by-PID.'
      );
      notes.push(
        'If startup hangs remain suspected after launch export failure, inspect macOS Performance Diagnostics logs around the launch window for hang-risk warnings.'
      );
    } else if (target.mode === 'attach' && !/^\d+$/.test(target.label)) {
      notes.push(
        'If xctrace reports the process name is ambiguous, rerun with the exact PID as processName.'
      );
    } else if (target.mode === 'unknown') {
      notes.push(
        'If the app is already running, find its PID and pass it as processName; use launchCommand only when startup behavior is the target.'
      );
    }

    return notes;
  }

  private formatProfileAdvisorOutput(advice: {
    request: string;
    inferredIntent: string;
    target: { mode: string; label: string };
    capabilities: XCTraceCapabilities;
    recommended: {
      label: string;
      when: string;
      tool: string;
      arguments: Record<string, unknown>;
    };
    options: Array<{
      label: string;
      when: string;
      tool: string;
      arguments: Record<string, unknown>;
    }>;
    workflowNotes: string[];
  }): string {
    const lines: string[] = [];

    lines.push('# Profiling Advisor');
    lines.push('');
    lines.push(`- Request: ${advice.request}`);
    lines.push(`- Inferred intent: ${advice.inferredIntent}`);
    lines.push(`- Target: ${advice.target.label}`);
    lines.push(`- xctrace: ${advice.capabilities.available ? advice.capabilities.version ?? 'available' : 'not available'}`);
    lines.push('');

    lines.push('## Recommended Next Step');
    lines.push(`Use \`${advice.recommended.tool}\`: ${advice.recommended.label}.`);
    lines.push(advice.recommended.when);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify({
      tool: advice.recommended.tool,
      arguments: advice.recommended.arguments,
    }, null, 2));
    lines.push('```');
    lines.push('');

    lines.push('## Other Useful Options');
    for (const option of advice.options.slice(1, 6)) {
      lines.push(`- ${option.label}: \`${option.tool}\` - ${option.when}`);
    }

    if (advice.workflowNotes.length > 0) {
      lines.push('');
      lines.push('## Workflow Notes');
      lines.push(...advice.workflowNotes.map((note) => `- ${note}`));
    }

    const warnings = advice.capabilities.warnings;
    if (warnings.length > 0) {
      lines.push('');
      lines.push('## Capability Warnings');
      lines.push(...warnings.map((warning) => `- ${warning}`));
    }

    if (advice.target.mode === 'unknown') {
      lines.push('');
      lines.push('## Missing Target');
      lines.push('- Provide `processName` for an already-running app, `launchCommand` for a launched app, or `allProcesses: true` for system-wide recording.');
    }

    return lines.join('\n');
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
    target: string;
    template: string;
    duration: number;
    device?: string;
    outputPath: string;
    workflowWarnings: string[];
  }): string[] {
    const lines = [
      '# Running App Trace Report',
      '',
      `- Target: ${recording.target}`,
      `- Template: ${recording.template}`,
      `- Duration: ${recording.duration}s`,
    ];

    if (recording.device) {
      lines.push(`- Device: ${recording.device}`);
    }

    lines.push(`- Trace: ${recording.outputPath}`);
    lines.push('');
    if (recording.workflowWarnings.length > 0) {
      lines.push('## Workflow Warnings');
      lines.push(...recording.workflowWarnings.map((warning) => `- ${warning}`));
      lines.push('');
    }
    return lines;
  }

  private formatProfileReport(profile: {
    target: string;
    preset: string;
    baseTemplate: string;
    instruments: string[];
    duration: number;
    device?: string;
    results: ProfileTraceResult[];
    analyze: boolean;
    capabilityWarnings: string[];
    workflowWarnings: string[];
  }): string {
    const lines: string[] = [];
    const failedResults = profile.results.filter((result) => result.error);
    const analyzedResults = profile.results.filter((result) => result.analysis);

    lines.push('# Profiling Report');
    lines.push('');
    lines.push(`- Target: ${profile.target}`);
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
    if (profile.capabilityWarnings.length > 0) {
      lines.push('- Capability validation: warnings');
    }
    if (profile.workflowWarnings.length > 0) {
      lines.push('- Workflow validation: warnings');
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

    if (profile.capabilityWarnings.length > 0) {
      lines.push('## Capability Warnings');
      lines.push(...profile.capabilityWarnings.map((warning) => `- ${warning}`));
      lines.push('');
    }
    if (profile.workflowWarnings.length > 0) {
      lines.push('## Workflow Warnings');
      lines.push(...profile.workflowWarnings.map((warning) => `- ${warning}`));
      lines.push('');
    }
    if (profile.results.some((result) => result.error && this.isTraceTocExportFailure(result.error))) {
      lines.push('## Next Steps');
      lines.push(...this.traceExportFailureNextSteps().map((step) => `- ${step}`));
      lines.push('');
    }

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
      this.appendHangsSection(lines, result.analysis);
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

  private appendHangsSection(lines: string[], analysis: Analysis): void {
    const hangs = analysis.hangs;
    if (!hangs || hangs.events.length === 0) {
      if (!this.hasHangExportSignal(analysis)) {
        return;
      }
      lines.push('## Hangs');
      lines.push('No exported hang events were found in this trace window.');
      lines.push('This does not rule out startup or interaction hangs outside the captured window.');
      const sources = this.hangSourceSchemas(analysis);
      if (sources.length > 0) {
        lines.push('');
        lines.push(`_Source: ${sources.join(', ')}_`);
      }
      lines.push('');
      return;
    }

    const total = hangs.events.length;
    const totalSec = (hangs.totalHangMs / 1000).toFixed(2);
    const longestSec = (hangs.longestMs / 1000).toFixed(2);

    lines.push('## Hangs');
    lines.push(
      `${total} hang${total > 1 ? 's' : ''} detected (${hangs.severeCount} severe, ${hangs.hangCount} standard, ${hangs.microhangCount} micro). ` +
        `Total stalled main-thread time: ${totalSec}s. Longest: ${longestSec}s.`
    );
    lines.push('');

    const sortedByDuration = [...hangs.events]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 10);
    for (const event of sortedByDuration) {
      lines.push(
        `- ${formatHangStartTime(event.startMs)} — ${event.hangType} — ${formatHangDuration(event.durationMs)}` +
          (event.threadName ? ` — ${event.threadName}` : '') +
          (event.processName && !event.threadName?.includes(event.processName)
            ? ` (${event.processName})`
            : '')
      );
    }
    lines.push('');

    if (hangs.sourceSchemas.length > 0) {
      lines.push(`_Source: ${hangs.sourceSchemas.join(', ')}_`);
      lines.push('');
    }
  }

  private hasHangExportSignal(analysis: Analysis): boolean {
    return !!analysis.hangs || (analysis.exportAttempts?.some((attempt) => attempt.kind === 'hangs') ?? false);
  }

  private hangSourceSchemas(analysis: Analysis): string[] {
    const schemas = new Set<string>();
    for (const schema of analysis.hangs?.sourceSchemas ?? []) {
      schemas.add(schema);
    }
    for (const attempt of analysis.exportAttempts ?? []) {
      if (attempt.kind === 'hangs' && attempt.schema) {
        schemas.add(attempt.schema);
      }
    }
    return Array.from(schemas);
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

  private appendSupportStatus(lines: string[], analysis: Analysis): void {
    if (!analysis.supportStatus || analysis.supportStatus.length === 0) {
      return;
    }

    lines.push('## Support Matrix');
    for (const status of analysis.supportStatus) {
      lines.push(
        `- ${this.instrumentSectionTitle(status.kind)}: ${status.status} - ${status.reason}`
      );
    }
    lines.push('');
  }

  private appendExportDiagnostics(lines: string[], analysis: Analysis): void {
    if (!analysis.exportAttempts || analysis.exportAttempts.length === 0) {
      return;
    }

    const nonSuccess = analysis.exportAttempts.filter((attempt) => attempt.status !== 'success');
    if (nonSuccess.length === 0) {
      return;
    }

    lines.push('## Export Diagnostics');
    for (const attempt of nonSuccess.slice(0, 10)) {
      const label = attempt.schema ?? attempt.kind;
      const message = attempt.message ? ` - ${attempt.message}` : '';
      lines.push(`- ${label}: ${attempt.status}${message}`);
    }
    lines.push('');
  }

  private appendTraceExportFailureNextSteps(lines: string[], analysis: Analysis): void {
    const tocFailure = analysis.exportAttempts?.some((attempt) =>
      attempt.kind === 'toc' &&
      attempt.status === 'failed' &&
      this.isTraceTocExportFailure(attempt.message ?? '')
    );
    if (!tocFailure) {
      return;
    }

    lines.push('## Next Steps');
    lines.push(...this.traceExportFailureNextSteps().map((step) => `- ${step}`));
    lines.push('');
  }

  private isTraceTocExportFailure(message: string): boolean {
    return /could not export (its )?TOC|could not export the trace TOC|failed to export TOC|Document Missing Template Error/i.test(message);
  }

  private traceExportFailureNextSteps(): string[] {
    return [
      'Treat this trace as saved but not exportable; do not interpret missing Hangs or "no issues" as a valid result.',
      'Do not retry the same launch target with more launch templates unless startup-only exportability is being tested; the trace container is failing before table parsing.',
      'For an already-running app, retry with profile_running_app using the exact PID in processName.',
      'If the environment cannot list processes, ask the user for the PID or have them close duplicate app instances before attaching.',
      'For startup hangs on macOS, inspect Performance Diagnostics logs around the launch window for hang-risk warnings, for example: log show --last 30m --style compact --predicate \'process == "AppName" && eventMessage CONTAINS[c] "hang"\'.',
      'Use outputFormat: "both" so supportStatus and exportAttempts remain visible.',
    ];
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

    this.appendSupportStatus(lines, analysis);
    this.appendExportDiagnostics(lines, analysis);
    this.appendTraceExportFailureNextSteps(lines, analysis);

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

    this.appendHangsSection(lines, analysis);

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

/** Format a trace-relative offset as `mm:ss.SSS` (matches Instruments display). */
function formatHangStartTime(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms));
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/** Format a duration in ms as a compact human string (`562 ms`, `4.76 s`). */
function formatHangDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

if (isMainModule()) {
  const server = new XCTraceAnalyzerServer();
  server.start().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

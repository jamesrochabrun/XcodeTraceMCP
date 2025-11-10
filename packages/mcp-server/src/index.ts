#!/usr/bin/env node

/**
 * Xcode Instruments Trace Analyzer MCP Server
 *
 * Provides intelligent analysis of Xcode Instruments traces via Model Context Protocol
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {
  analyzeTraceFile,
  compareTraceFiles,
  listTemplates,
  listDevices,
  isXCTraceAvailable,
  AnalysisOptions,
  ComparisonOptions,
} from '@xctrace-analyzer/core';

/**
 * MCP Server for Xcode Instruments trace analysis
 */
class XCTraceAnalyzerServer {
  private server: Server;

  constructor() {
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
      return await this.handleToolCall(request.params.name, request.params.arguments);
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
  private async handleToolCall(toolName: string, args: any): Promise<any> {
    try {
      switch (toolName) {
        case 'analyze_trace':
          return await this.analyzeTrace(args);

        case 'compare_traces':
          return await this.compareTraces(args);

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
            text: `Error: ${err.message}\n\n${err.stack || ''}`,
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

    const analysis = await analyzeTraceFile(tracePath, options);

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

    const comparison = await compareTraceFiles(
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
    };
  }

  /**
   * List available templates
   */
  private async listTemplates() {
    const templates = await listTemplates();

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
    const devices = await listDevices();

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
    const available = await isXCTraceAvailable();

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

    return {
      content: [
        {
          type: 'text',
          text: '✅ xctrace is available and ready to use.',
        },
      ],
    };
  }

  /**
   * Format analysis output for human readability
   */
  private formatAnalysisOutput(analysis: any): string {
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
    lines.push(`- Slow functions (>${analysis.stats.slowFunctions}): ${analysis.stats.slowFunctions}`);
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
  private formatComparisonOutput(comparison: any): string {
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

// Start the server
const server = new XCTraceAnalyzerServer();
server.start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

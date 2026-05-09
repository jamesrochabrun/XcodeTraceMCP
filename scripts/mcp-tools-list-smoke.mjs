#!/usr/bin/env node

import { spawn } from 'child_process';
import { once } from 'events';
import { Buffer } from 'buffer';
import { resolve } from 'path';

const serverPath = resolve('packages/mcp-server/dist/index.js');
const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = Buffer.alloc(0);
let stderr = '';
const responses = new Map();

const timeout = setTimeout(() => {
  child.kill('SIGTERM');
  fail(`Timed out waiting for MCP smoke responses.\n${stderr}`);
}, 10_000);

child.stdout.on('data', (chunk) => {
  stdout = Buffer.concat([stdout, chunk]);
  parseFrames();
});

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8');
});

child.on('error', (error) => {
  clearTimeout(timeout);
  fail(error.message);
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

function writeMessage(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function parseFrames() {
  while (true) {
    const lineEnd = stdout.indexOf('\n');
    if (lineEnd === -1) {
      return;
    }

    const raw = stdout.subarray(0, lineEnd).toString('utf8').replace(/\r$/, '');
    stdout = stdout.subarray(lineEnd + 1);
    if (!raw.trim()) {
      continue;
    }
    const message = JSON.parse(raw);
    if (message.id !== undefined) {
      responses.set(message.id, message);
    }
  }
}

async function waitForResponse(id) {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const response = responses.get(id);
    if (response) {
      return response;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  fail(`No MCP response for request ${id}.\n${stderr}`);
}

writeMessage({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'xctrace-smoke',
      version: '0.0.0',
    },
  },
});

const init = await waitForResponse(1);
if (init.error) {
  fail(`MCP initialize failed: ${JSON.stringify(init.error)}`);
}

writeMessage({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
  params: {},
});

writeMessage({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
});

const list = await waitForResponse(2);
if (list.error) {
  fail(`MCP tools/list failed: ${JSON.stringify(list.error)}`);
}

const toolNames = new Set((list.result?.tools ?? []).map((tool) => tool.name));
for (const expectedTool of ['profile_running_app', 'track_running_app', 'analyze_trace', 'compare_traces', 'cleanup_traces', 'check_xctrace']) {
  if (!toolNames.has(expectedTool)) {
    fail(`Missing MCP tool ${expectedTool}. Tools: ${Array.from(toolNames).join(', ')}`);
  }
}

child.kill('SIGTERM');
clearTimeout(timeout);

if (child.exitCode === null) {
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolveExit) => setTimeout(resolveExit, 500)),
  ]);
}

console.log(`ok MCP tools/list (${toolNames.size} tools)`);

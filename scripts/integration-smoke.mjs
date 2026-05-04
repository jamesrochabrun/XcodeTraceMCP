#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runXctrace(args) {
  const { stdout, stderr } = await execFileAsync('xcrun', ['xctrace', ...args], {
    maxBuffer: 50 * 1024 * 1024,
    timeout: 30_000,
  });
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

async function main() {
  const version = await runXctrace(['version']);
  const exportHelp = await runXctrace(['help', 'export']);
  const recordHelp = await runXctrace(['help', 'record']);
  const templates = await runXctrace(['list', 'templates']);

  if (!exportHelp.includes('--toc') || !exportHelp.includes('--xpath')) {
    throw new Error('xctrace export does not expose the expected TOC/XPath modes.');
  }
  if (!recordHelp.includes('--attach') || !recordHelp.includes('--launch')) {
    throw new Error('xctrace record does not expose the expected attach/launch modes.');
  }

  console.log('xctrace integration smoke passed.');
  console.log(version);
  console.log(`Templates detected: ${templates.split('\n').filter((line) => line.trim() && !line.startsWith('==')).length}`);
}

main().catch((error) => {
  console.error(`xctrace integration smoke failed: ${error.message}`);
  process.exit(1);
});

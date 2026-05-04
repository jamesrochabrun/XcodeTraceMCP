#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runXcrun(args) {
  const { stdout } = await execFileAsync('xcrun', args, {
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

async function runXcrunOutputFile(args, extension) {
  const tempDir = await mkdtemp(join(tmpdir(), 'xctrace-inspect-'));
  const outputPath = join(tempDir, `export.${extension}`);

  try {
    await execFileAsync('xcrun', [...args, '--output', outputPath], {
      maxBuffer: 1024 * 1024,
    });
    return (await readFile(outputPath, 'utf8')).trimEnd();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runXcrunOutputDirectory(args, extension) {
  const tempDir = await mkdtemp(join(tmpdir(), 'xctrace-inspect-'));

  try {
    await execFileAsync('xcrun', [...args, '--output', tempDir], {
      maxBuffer: 1024 * 1024,
    });
    const files = await readdir(tempDir);
    const outputFile = files.find((file) => file.endsWith(`.${extension}`));
    return outputFile ? (await readFile(join(tempDir, outputFile), 'utf8')).trimEnd() : '';
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function extractSchemas(tocXML) {
  return Array.from(tocXML.matchAll(/schema="([^"]+)"/g))
    .map((match) => match[1])
    .filter((schema, index, all) => all.indexOf(schema) === index)
    .sort();
}

async function inspectTrace(tracePath) {
  await stat(tracePath);

  console.log(`\n${tracePath}`);
  console.log('='.repeat(tracePath.length));

  const tocXML = await runXcrun(['xctrace', 'export', '--input', tracePath, '--toc']);
  const schemas = extractSchemas(tocXML);

  if (schemas.length === 0) {
    console.log('No table schemas found in TOC.');
  } else {
    console.log('Schemas:');
    for (const schema of schemas) {
      console.log(`- ${schema}`);
    }
  }

  try {
    const har = await runXcrunOutputDirectory(
      ['xctrace', 'export', '--input', tracePath, '--har'],
      'har'
    );
    console.log(`HAR export: ${har.trim() ? 'available' : 'empty'}`);
  } catch (error) {
    const message = error.stderr?.trim() || error.message;
    console.log(`HAR export: unavailable (${message})`);
  }
}

const traces = process.argv.slice(2);
if (traces.length === 0) {
  console.error('Usage: node scripts/inspect-trace-schemas.mjs <trace> [trace...]');
  process.exit(1);
}

for (const trace of traces) {
  try {
    await inspectTrace(trace);
  } catch (error) {
    console.error(`\n${trace}`);
    console.error(`Failed: ${error.message}`);
    process.exitCode = 1;
  }
}

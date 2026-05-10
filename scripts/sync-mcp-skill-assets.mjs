#!/usr/bin/env node

import { copyFileSync, mkdirSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const destinationRoot = join(root, 'packages/mcp-server/skills/xctrace-profiler');

const files = [
  ['skills/xctrace-profiler/SKILL.md', 'SKILL.md'],
  ['skills/xctrace-profiler/agents/openai.yaml', 'agents/openai.yaml'],
  ['skills/xctrace-profiler/references/report.md', 'references/report.md'],
];

rmSync(destinationRoot, { recursive: true, force: true });

for (const [sourceRelative, destinationRelative] of files) {
  const source = join(root, sourceRelative);
  const destination = join(destinationRoot, destinationRelative);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

console.log(`synced xctrace-profiler skill assets to ${destinationRoot}`);
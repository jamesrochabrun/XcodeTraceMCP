#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { join, resolve } from 'path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const packages = [
  {
    dir: 'packages/core',
    name: '@xctrace-analyzer/core',
    requiredFiles: ['package/dist/index.js', 'package/dist/index.d.ts', 'package/README.md', 'package/LICENSE'],
  },
  {
    dir: 'packages/mcp-server',
    name: '@xctrace-analyzer/mcp-server',
    mcpName: 'io.github.jamesrochabrun/xctrace-analyzer',
    requiredFiles: ['package/dist/index.js', 'package/dist/index.d.ts', 'package/README.md', 'package/LICENSE'],
  },
];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function packedPackageJson(tarball) {
  return JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
}

function packedFiles(tarball) {
  return new Set(execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' }).trim().split('\n'));
}

function assertNoWorkspaceDependencies(pkg) {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field] ?? {};
    for (const [name, specifier] of Object.entries(deps)) {
      assert(
        typeof specifier !== 'string' || !specifier.startsWith('workspace:'),
        `${pkg.name} packed ${field}.${name} still uses ${specifier}`
      );
    }
  }
}

function assertProductionMetadata(pkg, expected) {
  assert(pkg.name === expected.name, `Expected package name ${expected.name}, got ${pkg.name}`);
  assert(pkg.repository?.url?.includes('github.com/jamesrochabrun/XcodeTraceMCP'), `${pkg.name} is missing repository.url`);
  assert(pkg.homepage?.includes('github.com/jamesrochabrun/XcodeTraceMCP'), `${pkg.name} is missing homepage`);
  assert(pkg.bugs?.url?.includes('github.com/jamesrochabrun/XcodeTraceMCP/issues'), `${pkg.name} is missing bugs.url`);
  assert(pkg.engines?.node === '>=18.0.0', `${pkg.name} must require Node >=18.0.0`);
  assert(Array.isArray(pkg.os) && pkg.os.includes('darwin'), `${pkg.name} must declare macOS-only support`);
  assert(pkg.publishConfig?.access === 'public', `${pkg.name} must publish with public access`);
  assert(pkg.types === './dist/index.d.ts', `${pkg.name} must expose TypeScript declarations`);
  assert(pkg.exports?.['.']?.import === './dist/index.js', `${pkg.name} must expose the ESM entrypoint`);
  assert(pkg.exports?.['.']?.types === './dist/index.d.ts', `${pkg.name} must expose declaration exports`);

  if (expected.mcpName) {
    assert(pkg.mcpName === expected.mcpName, `${pkg.name} must declare mcpName ${expected.mcpName}`);
    assert(pkg.bin?.['xctrace-analyzer-mcp'] === './dist/index.js', `${pkg.name} is missing the MCP binary`);
  }
}

function checkPackage(config) {
  const tempDir = mkdtempSync(join(tmpdir(), 'xctrace-pack-'));
  try {
    const packageDir = join(root, config.dir);
    execFileSync('pnpm', ['pack', '--pack-destination', tempDir], {
      cwd: packageDir,
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    const tarball = readdirSync(tempDir).find((file) => file.endsWith('.tgz'));
    assert(tarball, `${config.name} did not produce a tarball`);

    const tarballPath = join(tempDir, tarball);
    const pkg = packedPackageJson(tarballPath);
    const files = packedFiles(tarballPath);

    assertProductionMetadata(pkg, config);
    assertNoWorkspaceDependencies(pkg);

    for (const requiredFile of config.requiredFiles) {
      assert(files.has(requiredFile), `${pkg.name} package is missing ${requiredFile}`);
    }

    console.log(`ok ${pkg.name}@${pkg.version}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

for (const config of packages) {
  checkPackage(config);
}

const serverPackage = JSON.parse(readFileSync(join(root, 'packages/mcp-server/package.json'), 'utf8'));
const serverJson = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8'));
assert(serverJson.name === serverPackage.mcpName, 'server.json name must match package.json mcpName');
assert(serverJson.version === serverPackage.version, 'server.json version must match MCP server package version');
assert(
  serverJson.packages?.some(
    (pkg) =>
      pkg.registryType === 'npm' &&
      pkg.identifier === serverPackage.name &&
      pkg.version === serverPackage.version &&
      pkg.transport?.type === 'stdio'
  ),
  'server.json must point at the npm stdio package'
);
console.log(`ok server.json ${serverJson.name}@${serverJson.version}`);

// Populate src-tauri/resources/tsx-runtime/ with a self-contained tsx
// install (tsx + esbuild JS wrapper + per-platform @esbuild/<triple>
// binary + get-tsconfig). The Plugin Bridge consumes this at runtime
// via `--import file:///<runtime>/node_modules/tsx/dist/esm/index.mjs`,
// so OpenClaw plugins shipping raw `.ts` source can be transpiled
// without per-plugin `npm install` (which previously pruned our SDK
// shim because npm reconciles `node_modules/` against `package.json`
// even with `--no-save`).
//
// Why a *target*-platform install (not host): cross-arch builds must
// pick the right native esbuild binary. npm's `--os`/`--cpu` flags
// filter optionalDependencies to the requested platform, so
//   npm install tsx --os=win32 --cpu=x64
// produces `node_modules/@esbuild/win32-x64/bin/esbuild.exe` even on
// a Mac arm64 host. Per-platform release shell scripts pass their
// target triple here; dev / `build_dev.sh` passes the host arch.
//
// Usage:
//   node scripts/setup-tsx-runtime.mjs <os> <cpu>
// where:
//   <os>  ∈ darwin | linux | win32
//   <cpu> ∈ arm64  | x64

import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const [os, cpu] = process.argv.slice(2);
const VALID_OS = new Set(['darwin', 'linux', 'win32']);
const VALID_CPU = new Set(['arm64', 'x64']);
if (!VALID_OS.has(os) || !VALID_CPU.has(cpu)) {
  console.error(
    `Usage: node scripts/setup-tsx-runtime.mjs <os> <cpu>\n` +
      `  os  ∈ ${[...VALID_OS].join(', ')}\n` +
      `  cpu ∈ ${[...VALID_CPU].join(', ')}\n` +
      `Got: os=${os ?? '(none)'} cpu=${cpu ?? '(none)'}`,
  );
  process.exit(1);
}

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const RUNTIME_DIR = resolve(PROJECT_ROOT, 'src-tauri/resources/tsx-runtime');

// Read tsx version from the project so the runtime always matches what
// the project's other tooling (test runner / generate-sdk-shims) uses —
// avoids two-tsx-versions-in-one-install footguns.
const projectPkgRaw = await readFile(resolve(PROJECT_ROOT, 'package.json'), 'utf8');
const projectPkg = JSON.parse(projectPkgRaw);
const tsxVersion =
  projectPkg.dependencies?.tsx ||
  projectPkg.devDependencies?.tsx;
if (!tsxVersion) {
  console.error('tsx not found in project package.json — add it to dependencies');
  process.exit(1);
}

await rm(RUNTIME_DIR, { recursive: true, force: true });
await mkdir(RUNTIME_DIR, { recursive: true });

await writeFile(
  resolve(RUNTIME_DIR, 'package.json'),
  JSON.stringify(
    {
      name: 'myagents-tsx-runtime',
      private: true,
      // Comment-equivalent: this dir is populated by setup-tsx-runtime.mjs
      // and consumed by Plugin Bridge via absolute --import path. Don't
      // edit by hand; it gets nuked + reinstalled on every release build.
      dependencies: { tsx: tsxVersion },
    },
    null,
    2,
  ),
);

console.log(`→ npm install tsx@${tsxVersion} --os=${os} --cpu=${cpu} into ${RUNTIME_DIR}`);

execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  [
    'install',
    '--no-audit',
    '--no-fund',
    `--os=${os}`,
    `--cpu=${cpu}`,
  ],
  { cwd: RUNTIME_DIR, stdio: 'inherit' },
);

// Sanity check: the platform binary must end up under @esbuild/<triple>.
const triple = `${os === 'win32' ? 'win32' : os}-${cpu}`;
const binaryName = os === 'win32' ? 'esbuild.exe' : 'esbuild';
const platformBinary = resolve(RUNTIME_DIR, 'node_modules/@esbuild', triple, 'bin', binaryName);
if (!existsSync(platformBinary)) {
  console.error(`✘ Platform binary not produced at ${platformBinary}`);
  console.error(`  npm install --os=${os} --cpu=${cpu} did not pull @esbuild/${triple}.`);
  console.error(`  Check npm version (need ≥10.x for --os/--cpu flags) and network.`);
  process.exit(1);
}
console.log(`✓ tsx-runtime ready at ${RUNTIME_DIR} (target=${triple})`);

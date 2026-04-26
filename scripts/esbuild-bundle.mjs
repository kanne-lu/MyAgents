// Cross-platform esbuild driver for the three Node bundles we ship
// (server, plugin-bridge, CLI).
//
// Why this script exists: the previous inline `npm run build:*` commands
// embedded the esbuild banner via `--banner:js='...'` with single quotes.
// That worked under bash/zsh on macOS/Linux but **broke under Windows
// `cmd.exe`**, which doesn't recognise single quotes — it just split the
// banner arg on whitespace, and esbuild aborted with:
//
//   ✘ ERROR  Must use "outdir" when there are multiple input files
//
// Switching to the JS API removes shell-quoting entirely and gives us
// one source of truth for everything that defines a Node bundle: entry,
// banner, format, externals, sourcemap. Per-target post-build steps
// (e.g. CLI launcher copy, server-side hardcoded-path validation) live
// here too — used to be duplicated across build_macos.sh / build_linux.sh
// / build_windows.ps1, now centralised so a missed update can't ship a
// half-fixed bundle.

import { build } from 'esbuild';
import { copyFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// Banner content kept as plain string literals here — no shell parsing
// involved, so single/double quotes mean what they say.
//
// Aliasing `createRequire` here is load-bearing, not stylistic: at least one
// bundled source file (`src/server/utils/imageResize.ts`) uses
// `import { createRequire } from 'module'` at top level, and esbuild keeps
// that import literally in the output. If our banner *also* binds the bare
// name `createRequire`, Node ≥22's ESM loader rejects the module on first
// load with `SyntaxError: Identifier 'createRequire' has already been
// declared` — Sidecar dies before answering /health, the renderer hangs at
// "loading history". A unique alias here permanently sidesteps the
// collision regardless of how many depths-deep deps re-import the symbol.
const ESM_INTEROP_BANNER =
  'import { createRequire as __myAgentsCreateRequire } from "module"; const require = __myAgentsCreateRequire(import.meta.url);';
const CLI_SHEBANG_BANNER = '#!/usr/bin/env node';

const TARGETS = {
  server: {
    entryPoints: ['src/server/index.ts'],
    outfile: 'src-tauri/resources/server-dist.js',
    format: 'esm',
    sourcemap: true,
    banner: { js: ESM_INTEROP_BANNER },
    /** Post-build: catch hardcoded `__dirname = "<dev-machine path>"` leaks.
     *  esbuild treats a top-level `__dirname` as a compile-time constant; the
     *  source must use `import.meta.url` / `getScriptDir()` instead. If anyone
     *  regresses that contract, fail the build here so the bad bundle never
     *  ships (used to be a separate `grep` step in each .sh / .ps1 build
     *  script — three near-identical copies before the consolidation).
     */
    postBuild: async (outfile) => {
      const code = await readFile(outfile, 'utf8');
      const m = code.match(/var __dirname = "((?:\/Users|\/home|[A-Z]:\\)[^"]+)"/);
      if (m) {
        console.error(
          `✘ ${outfile}: hardcoded __dirname → ${m[1]}\n` +
            `  Source must use import.meta.url / utils.getScriptDir(), not __dirname.`,
        );
        process.exit(1);
      }
    },
  },
  bridge: {
    entryPoints: ['src/server/plugin-bridge/index.ts'],
    outfile: 'src-tauri/resources/plugin-bridge-dist.js',
    format: 'esm',
    sourcemap: true,
    banner: { js: ESM_INTEROP_BANNER },
    external: ['openclaw'],
  },
  cli: {
    entryPoints: ['src/cli/myagents.ts'],
    outfile: 'src-tauri/resources/cli/myagents.js',
    format: 'cjs',
    sourcemap: false,
    banner: { js: CLI_SHEBANG_BANNER },
    /** Post-build: drop the Windows launcher next to the bundle. Rust's
     *  `cmd_sync_cli` reads `resources/cli/myagents.js` AND `myagents.cmd`,
     *  so both have to be present in every release artifact regardless of
     *  the host OS doing the build. Doing the copy here means a single
     *  `npm run build:cli` invocation produces a complete CLI deliverable —
     *  no follow-up shell step in mac/linux/windows builders.
     */
    postBuild: async () => {
      const src = 'src/cli/myagents.cmd';
      const dst = 'src-tauri/resources/cli/myagents.cmd';
      await copyFile(src, dst);
      console.log(`  ↳ copied ${src} → ${dst}`);
    },
  },
};

const targetName = process.argv[2];
const cfg = TARGETS[targetName];
if (!cfg) {
  const known = Object.keys(TARGETS).join(', ');
  console.error(`Usage: node scripts/esbuild-bundle.mjs <${known}>`);
  process.exit(1);
}

// Ensure the outfile's directory exists. esbuild creates the file but
// requires the parent dir; on a clean checkout (or after `cargo clean`
// nuked target/), `src-tauri/resources/cli/` may not exist yet.
await mkdir(dirname(cfg.outfile), { recursive: true });

await build({
  bundle: true,
  platform: 'node',
  target: 'node22',
  // `postBuild` is our own hook — strip it before handing config to esbuild.
  ...(({ postBuild: _strip, ...rest }) => rest)(cfg),
});

if (cfg.postBuild) {
  await cfg.postBuild(cfg.outfile);
}

console.log(`✓ ${targetName} → ${cfg.outfile}`);

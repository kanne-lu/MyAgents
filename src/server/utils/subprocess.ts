/**
 * Bun.spawn → node:child_process adapter
 *
 * Exposes a Bun.spawn-shaped interface over node:child_process.spawn, so
 * existing call sites (`proc.pid` / `proc.stdin` / `proc.stdout` / `proc.stderr`
 * / `proc.exited` / `proc.kill`) port over without per-site rewrites.
 *
 * Stream-shape compatibility:
 *   - `stdout` / `stderr` are exposed as Web ReadableStream<Uint8Array>
 *     (via Readable.toWeb), matching Bun.spawn so callers using
 *     `new Response(proc.stdout).text()` or `.getReader()` continue to work.
 *   - `stdin` is a Bun-compatible writer exposing `.write(chunk)` → Promise and
 *     `.end()`; built on top of Node Writable. Callers did not rely on the
 *     full Web WritableStream surface, so this minimal shim suffices and
 *     avoids Readable.toWeb's one-way lock that breaks if we wrapped stdin too.
 */
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions as NodeSpawnOptions,
  type StdioOptions,
} from 'node:child_process';
import { Readable, type Writable } from 'node:stream';

export interface SubprocessStdin {
  /** Write a chunk; resolves when the chunk is flushed to OS buffer. */
  write(chunk: string | Uint8Array): Promise<void>;
  /** Close the stdin stream (EOF). */
  end(): Promise<void>;
  /** Expose the underlying Node Writable for callers that need full API. */
  readonly underlying: Writable;
}

export interface SubprocessHandle {
  readonly pid: number;
  readonly stdin: SubprocessStdin | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  /** Resolves with exit code (or -1 on signal-only termination). */
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: 'pipe' | 'ignore' | 'inherit';
  stdout?: 'pipe' | 'ignore' | 'inherit';
  stderr?: 'pipe' | 'ignore' | 'inherit';
  windowsHide?: boolean;
  detached?: boolean;
}

export function spawn(argv: string[], options: SpawnOptions = {}): SubprocessHandle {
  if (!argv.length) throw new Error('spawn: argv must be non-empty');
  const [cmd, ...args] = argv;

  const stdio: StdioOptions = [
    options.stdin ?? 'pipe',
    options.stdout ?? 'pipe',
    options.stderr ?? 'pipe',
  ];

  const nodeOpts: NodeSpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    stdio,
    windowsHide: options.windowsHide,
    detached: options.detached,
  };

  const child = nodeSpawn(cmd, args, nodeOpts);
  return wrapChildProcess(child);
}

function wrapStdin(w: Writable | null): SubprocessStdin | null {
  if (!w) return null;
  return {
    underlying: w,
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        const ok = w.write(chunk, (err) => {
          if (err) reject(err);
        });
        if (ok) {
          resolve();
        } else {
          w.once('drain', resolve);
        }
      });
    },
    end() {
      return new Promise<void>((resolve) => {
        w.end(() => resolve());
      });
    },
  };
}

/** Wrap an existing ChildProcess in the SubprocessHandle shape. */
export function wrapChildProcess(child: ChildProcess): SubprocessHandle {
  const exited = new Promise<number>((resolve) => {
    let settled = false;
    const settle = (value: number): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('exit', (code, signal) => {
      if (code !== null) settle(code);
      else if (signal !== null) settle(-1);
      else settle(-1);
    });
    child.once('error', () => settle(-1));
  });

  // Readable.toWeb locks the underlying Readable — must cache the Web wrappers
  // so repeated .stdout / .stderr access returns the same stream.
  let cachedStdin: SubprocessStdin | null | undefined;
  let cachedStdout: ReadableStream<Uint8Array> | null | undefined;
  let cachedStderr: ReadableStream<Uint8Array> | null | undefined;

  return {
    get pid() {
      return child.pid ?? -1;
    },
    get stdin() {
      if (cachedStdin === undefined) cachedStdin = wrapStdin(child.stdin);
      return cachedStdin;
    },
    get stdout() {
      if (cachedStdout === undefined) {
        cachedStdout = child.stdout
          ? (Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>)
          : null;
      }
      return cachedStdout;
    },
    get stderr() {
      if (cachedStderr === undefined) {
        cachedStderr = child.stderr
          ? (Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>)
          : null;
      }
      return cachedStderr;
    },
    exited,
    kill(signal) {
      // Node's child.kill accepts both names and numbers at runtime; TS type is too narrow.
      return child.kill(signal as NodeJS.Signals);
    },
  };
}

export type Subprocess = SubprocessHandle;

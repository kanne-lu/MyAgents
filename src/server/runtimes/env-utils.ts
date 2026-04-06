// Shared environment utilities for external runtime subprocesses (v0.1.60)

/**
 * Build an augmented env with user-level binary directories in PATH.
 * Used when spawning external CLI runtimes (claude, codex) from the Bun Sidecar,
 * since GUI-launched apps don't inherit shell PATH.
 *
 * NOTE: The Sidecar process already has NO_PROXY injected by Rust's
 * proxy_config::apply_to_subprocess(). process.env inherits it, so
 * external CLI subprocesses spawned here are also protected.
 */
export function augmentedProcessEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  const home = env.HOME || env.USERPROFILE || '';
  if (!home) return env;
  const sep = process.platform === 'win32' ? ';' : ':';
  const extraDirs = [
    `${home}/.local/bin`,   // Claude Code / Codex global install
    `${home}/.bun/bin`,     // Bun global installs
    '/opt/homebrew/bin',    // macOS Apple Silicon homebrew
    '/usr/local/bin',       // macOS Intel homebrew / Linux
  ];
  const currentPath = env.PATH || '';
  const pathParts = currentPath ? currentPath.split(sep) : [];
  for (const dir of extraDirs) {
    if (!pathParts.includes(dir)) pathParts.push(dir);
  }
  env.PATH = pathParts.join(sep);
  return env;
}

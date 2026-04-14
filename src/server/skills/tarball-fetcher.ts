/**
 * tarball-fetcher.ts — Download a GitHub/raw zip and extract it into memory.
 *
 * Responsibilities:
 *   - Fetch via Bun `fetch()` (inherits HTTP_PROXY / NO_PROXY from env)
 *   - Default-branch fallback (try main → master on 404)
 *   - Enforce size / file-count / per-file limits (zip-bomb defense)
 *   - Strip the GitHub-style wrapper root (`<repo>-<ref>/...`) automatically
 *   - Return an in-memory tree {relativePath: Buffer} for downstream extraction
 *
 * Does NOT write to disk — callers are responsible for choosing a target
 * directory and using the existing zip-slip-protected write path in
 * `/api/skill/upload`.
 */

import AdmZip from 'adm-zip';
import { buildGithubZipCandidates, SkillUrlError, type ResolvedSkillSource } from './url-resolver';

// ---------------------------------------------------------------------------
// Limits (tuned for "pit of success" — refuse anything suspicious by default)
// ---------------------------------------------------------------------------

const MAX_TARBALL_BYTES = 50 * 1024 * 1024; // 50 MB total download
const MAX_FILES_PER_REPO = 2000;             // plenty for 99% of skill repos
const MAX_FILE_BYTES = 5 * 1024 * 1024;      // 5 MB per file (skill assets rarely exceed this)
const FETCH_TIMEOUT_MS = 60_000;             // 60 s hard timeout

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * In-memory file tree after extraction.
 * Keys are POSIX-style relative paths (no leading slash, no `..`).
 * GitHub's wrapper root (`<repo>-<sha>/`) has been stripped.
 */
export interface ExtractedTree {
  files: Map<string, Buffer>;
  /** Original download URL that actually succeeded (for logging / provenance) */
  sourceUrl: string;
  /** Effective ref used (populated when default-branch fallback was taken) */
  effectiveRef?: string;
}

export class TarballFetchError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'TarballFetchError';
    this.statusCode = statusCode;
  }
}

/**
 * Fetch the zip for a resolved skill source and return the extracted tree.
 * Throws TarballFetchError on any HTTP/size/format failure.
 */
export async function fetchSkillZip(src: ResolvedSkillSource): Promise<ExtractedTree> {
  const candidates = src.kind === 'github'
    ? buildGithubZipCandidates(src)
    : [src.rawZipUrl!];

  let lastError: TarballFetchError | null = null;

  for (const url of candidates) {
    try {
      const { buffer, effectiveRef } = await downloadZip(url, src);
      const files = extractZipInMemory(buffer);
      return { files, sourceUrl: url, effectiveRef };
    } catch (err) {
      if (err instanceof TarballFetchError && err.statusCode === 404 && candidates.length > 1) {
        // Default-branch fallback: try next candidate
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new TarballFetchError('No candidate URLs to try', 500);
}

// ---------------------------------------------------------------------------
// HTTP download with size + timeout enforcement
// ---------------------------------------------------------------------------

async function downloadZip(
  url: string,
  src: ResolvedSkillSource,
): Promise<{ buffer: Buffer; effectiveRef?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'MyAgents-Skill-Installer/1.0',
        'Accept': 'application/zip, application/octet-stream',
      },
    });

    if (!resp.ok) {
      if (resp.status === 404) {
        throw new TarballFetchError(`仓库或分支不存在 (${resp.status})`, 404);
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new TarballFetchError(`无权访问仓库 (${resp.status}) — 暂不支持私有仓库`, resp.status);
      }
      throw new TarballFetchError(`下载失败：HTTP ${resp.status}`, resp.status);
    }

    // Early abort if Content-Length is too big
    const contentLength = resp.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_TARBALL_BYTES) {
      throw new TarballFetchError(
        `仓库太大 (${Math.round(Number(contentLength) / 1024 / 1024)} MB > 50 MB)`,
        413,
      );
    }

    const arrayBuffer = await resp.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_TARBALL_BYTES) {
      throw new TarballFetchError(
        `下载体积超限 (${Math.round(arrayBuffer.byteLength / 1024 / 1024)} MB > 50 MB)`,
        413,
      );
    }

    // Determine effective ref from successful URL
    const refMatch = url.match(/\/refs\/heads\/([^/]+)$/);
    return {
      buffer: Buffer.from(arrayBuffer),
      effectiveRef: refMatch ? decodeURIComponent(refMatch[1]) : src.ref,
    };
  } catch (err) {
    if (err instanceof TarballFetchError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new TarballFetchError('下载超时 — 请检查网络或代理配置', 504);
    }
    throw new TarballFetchError(`下载失败：${(err as Error).message}`, 500);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Zip → in-memory tree, stripping the GitHub wrapper root if present
// ---------------------------------------------------------------------------

function extractZipInMemory(buffer: Buffer): Map<string, Buffer> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new TarballFetchError(`无法解压 zip：${(err as Error).message}`, 422);
  }

  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw new TarballFetchError('zip 是空的', 422);
  }
  if (entries.length > MAX_FILES_PER_REPO) {
    throw new TarballFetchError(
      `文件数过多 (${entries.length} > ${MAX_FILES_PER_REPO})`,
      413,
    );
  }

  // Detect single wrapper root (GitHub uses `<repo>-<ref-or-sha>/`)
  const topLevel = new Set<string>();
  for (const entry of entries) {
    const head = entry.entryName.split('/')[0];
    if (head && head !== '__MACOSX') topLevel.add(head);
  }
  const stripRoot = topLevel.size === 1 ? Array.from(topLevel)[0] : null;
  const prefixToStrip = stripRoot ? `${stripRoot}/` : '';

  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.entryName.startsWith('__MACOSX')) continue;

    let rel = entry.entryName;
    if (prefixToStrip && rel.startsWith(prefixToStrip)) {
      rel = rel.slice(prefixToStrip.length);
    }
    if (!rel) continue;

    // POSIX-normalize and reject any path traversal attempts
    if (rel.includes('..') || rel.startsWith('/')) continue;

    // Per-file size limit
    const data = entry.getData();
    if (data.length > MAX_FILE_BYTES) {
      throw new TarballFetchError(
        `文件过大：${rel} (${Math.round(data.length / 1024 / 1024)} MB > 5 MB)`,
        413,
      );
    }

    files.set(rel, data);
  }

  if (files.size === 0) {
    throw new TarballFetchError('zip 中未找到任何有效文件', 422);
  }

  return files;
}

// Exported for testing
export const _internals = {
  MAX_TARBALL_BYTES,
  MAX_FILES_PER_REPO,
  MAX_FILE_BYTES,
  FETCH_TIMEOUT_MS,
  extractZipInMemory,
};

// Re-export so consumers only need one import
export { SkillUrlError };

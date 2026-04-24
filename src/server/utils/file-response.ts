/**
 * Web Response helper for serving files from disk under Node.js.
 *
 * Replaces Bun's `new Response(Bun.file(path))` idiom. Bun.file returns
 * a lazy-streaming handle that Bun.serve knows how to flush directly;
 * under Node we build an equivalent Web Response from fs.createReadStream
 * via Readable.toWeb, so large files stream without being slurped into
 * memory.
 *
 * Returns null if the file does not exist (caller should 404).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

export interface FileResponseInit {
  status?: number;
  headers?: HeadersInit;
  /** Explicit Content-Type override (otherwise skipped; clients sniff). */
  contentType?: string;
}

/**
 * Build a Response that streams a file from disk, or return null if missing.
 * Sets Content-Length from the stat result so clients don't need to buffer.
 */
export async function fileResponse(
  absolutePath: string,
  init: FileResponseInit = {},
): Promise<Response | null> {
  let size: number;
  try {
    const st = await stat(absolutePath);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }

  const nodeStream = createReadStream(absolutePath);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

  const headers = new Headers(init.headers);
  headers.set('Content-Length', String(size));
  if (init.contentType) headers.set('Content-Type', init.contentType);

  return new Response(webStream, {
    status: init.status ?? 200,
    headers,
  });
}

/**
 * Read a byte range from a file and return its contents as a Buffer.
 * For small in-memory operations; large streams should use fileResponse().
 */
export async function readFileBytes(
  absolutePath: string,
  start?: number,
  end?: number,
): Promise<Buffer | null> {
  try {
    await stat(absolutePath);
  } catch {
    return null;
  }
  const chunks: Buffer[] = [];
  const stream = createReadStream(absolutePath, start !== undefined ? { start, end } : undefined);
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

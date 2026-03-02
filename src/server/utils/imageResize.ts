import { createJimp } from '@jimp/core';
import { defaultFormats, defaultPlugins } from 'jimp';
import webp from '@jimp/wasm-webp';

// Custom Jimp instance with WebP support
const Jimp = createJimp({
  formats: [...defaultFormats, webp],
  plugins: defaultPlugins,
});

const MAX_DIMENSION = 1920;
/** Max dimension for MCP tool result images (e.g. browser screenshots). Claude API hard limit is 8000px. */
const MAX_TOOL_IMAGE_DIMENSION = 4096;

type ImagePayload = { name: string; mimeType: string; data: string };

/** MCP protocol image content block */
type McpImageContent = { type: 'image'; data: string; mimeType: string };
/** MCP protocol text content block */
type McpTextContent = { type: 'text'; text: string };
/** MCP tool result content block (subset of MCP protocol types) */
type McpContentBlock = McpImageContent | McpTextContent | { type: string; [key: string]: unknown };

export async function resizeImageIfNeeded(img: ImagePayload): Promise<ImagePayload> {
  try {
    const buffer = Buffer.from(img.data, 'base64');
    const image = await Jimp.fromBuffer(buffer);
    const { width, height } = image;

    if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
      return img; // No resize needed
    }

    // Scale proportionally to fit within MAX_DIMENSION
    image.scaleToFit({ w: MAX_DIMENSION, h: MAX_DIMENSION });

    // GIF loses animation after processing → output as PNG; others keep original format
    const outputMime = img.mimeType === 'image/gif' ? 'image/png' : img.mimeType;
    let outBuffer: Buffer;
    if (outputMime === 'image/jpeg') {
      outBuffer = await image.getBuffer('image/jpeg', { quality: 92 });
    } else {
      outBuffer = await image.getBuffer(outputMime as 'image/png' | 'image/webp' | 'image/bmp' | 'image/tiff');
    }
    const base64 = outBuffer.toString('base64');

    console.log(`[image-resize] Resized ${img.name}: ${width}x${height} → ${image.width}x${image.height}`);

    return { name: img.name, mimeType: outputMime, data: base64 };
  } catch (err) {
    // Unsupported format or processing failure → use original (don't block message)
    console.warn(`[image-resize] Failed to process ${img.name}, using original:`, err);
    return img;
  }
}

/**
 * Base64 size threshold for fast-reject before full image decode (~50 MB decoded).
 * base64 is ~4/3 of raw bytes; a 10000x10000 RGBA image ≈ 400 MB decoded.
 * We reject payloads > 64 MB base64 (~48 MB raw) to prevent OOM in the Bun sidecar.
 */
const MAX_BASE64_LENGTH = 64 * 1024 * 1024;

/**
 * Resize oversized images in MCP tool result content blocks.
 * Returns a shallow-copied tool_response with resized images, or null if unchanged.
 *
 * MCP tool results use the format: { content: [{ type: "image", data: "base64...", mimeType: "image/png" }, ...] }
 */
export async function resizeToolImageContent(
  toolResponse: unknown
): Promise<Record<string, unknown> | null> {
  // Validate shape: must be object with content array
  if (
    typeof toolResponse !== 'object' ||
    toolResponse === null ||
    !Array.isArray((toolResponse as { content?: unknown }).content)
  ) {
    return null;
  }

  const originalContent = (toolResponse as { content: McpContentBlock[] }).content;
  // Shallow copy to avoid mutating SDK's input data
  const content = [...originalContent];
  let modified = false;

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block.type !== 'image' || !('data' in block) || typeof block.data !== 'string') {
      continue;
    }

    // Fast-reject: skip decode for extremely large payloads to prevent OOM
    if (block.data.length > MAX_BASE64_LENGTH) {
      console.warn(
        `[image-resize] Tool image block ${i} too large (${(block.data.length / 1024 / 1024).toFixed(1)} MB base64), replacing with text`
      );
      content[i] = { type: 'text', text: '[Image too large to process — stripped to prevent API error]' } as McpTextContent;
      modified = true;
      continue;
    }

    try {
      const buffer = Buffer.from(block.data, 'base64');
      const image = await Jimp.fromBuffer(buffer);
      const { width, height } = image;

      if (width <= MAX_TOOL_IMAGE_DIMENSION && height <= MAX_TOOL_IMAGE_DIMENSION) {
        continue;
      }

      image.scaleToFit({ w: MAX_TOOL_IMAGE_DIMENSION, h: MAX_TOOL_IMAGE_DIMENSION });

      const mimeType = ('mimeType' in block && typeof block.mimeType === 'string')
        ? block.mimeType
        : 'image/png';
      const outputMime = mimeType === 'image/gif' ? 'image/png' : mimeType;

      let outBuffer: Buffer;
      if (outputMime === 'image/jpeg') {
        outBuffer = await image.getBuffer('image/jpeg', { quality: 92 });
      } else {
        outBuffer = await image.getBuffer(outputMime as 'image/png' | 'image/webp' | 'image/bmp' | 'image/tiff');
      }

      console.log(
        `[image-resize] Tool image resized: ${width}x${height} → ${image.width}x${image.height}`
      );

      content[i] = { ...block, data: outBuffer.toString('base64'), mimeType: outputMime };
      modified = true;
    } catch (err) {
      // Resize failed — strip the oversized image to prevent Claude API 400 error
      console.warn(`[image-resize] Failed to resize tool image block ${i}, stripping:`, err);
      content[i] = { type: 'text', text: '[Image could not be processed — stripped to prevent API error]' } as McpTextContent;
      modified = true;
    }
  }

  return modified ? { ...(toolResponse as object), content } : null;
}

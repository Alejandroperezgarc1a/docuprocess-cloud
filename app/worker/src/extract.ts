/**
 * Metadata extraction for the DocuProcess Cloud worker: validates the real
 * file content and computes size, SHA-256 and page/dimension metadata.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { fileTypeFromBuffer } from 'file-type';
import { imageSize } from 'image-size';
import { PDFDocument } from 'pdf-lib';
import type { DocumentResult } from './types.js';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain',
]);

/** Defensive limit against images with disproportionate dimensions. */
const MAX_IMAGE_PIXELS = 50_000_000;
const HEADER_BYTES = 4100;

export class PermanentProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentProcessingError';
  }
}

export class FileTooLargeError extends PermanentProcessingError {
  constructor() {
    super('file too large');
    this.name = 'FileTooLargeError';
  }
}

export class UnsupportedFileTypeError extends PermanentProcessingError {
  constructor() {
    super('unsupported file type');
    this.name = 'UnsupportedFileTypeError';
  }
}

export class InvalidFileError extends PermanentProcessingError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFileError';
  }
}

async function readHeader(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function looksLikeText(header: Buffer): boolean {
  if (header.length === 0 || header.includes(0)) {
    return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(header);
    return true;
  } catch {
    return false;
  }
}

async function detectMime(
  header: Buffer,
  declaredContentType: string,
): Promise<string> {
  const detected = await fileTypeFromBuffer(header);
  if (detected !== undefined) {
    return detected.mime;
  }
  if (looksLikeText(header)) {
    return 'text/plain';
  }
  // If the client declared text but the content is not valid UTF-8, it is not
  // accepted: the worker validates the real file, not the declared header.
  void declaredContentType;
  throw new UnsupportedFileTypeError();
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * Extracts metadata from the real file. Throws permanent errors that the
 * process turns into FAILED with a stable message for the frontend.
 */
export async function extractMetadata(
  filePath: string,
  declaredContentType: string,
  maxFileBytes: number,
): Promise<DocumentResult> {
  const info = await stat(filePath);
  if (info.size === 0) {
    throw new InvalidFileError('empty file');
  }
  if (info.size > maxFileBytes) {
    throw new FileTooLargeError();
  }

  const header = await readHeader(filePath);
  const mimeType = await detectMime(header, declaredContentType);
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new UnsupportedFileTypeError();
  }

  const result: DocumentResult = {
    sizeBytes: info.size,
    mimeType,
    sha256: await hashFile(filePath),
  };

  if (mimeType === 'application/pdf') {
    try {
      const bytes = await readFile(filePath);
      const pdf = await PDFDocument.load(bytes);
      result.pages = pdf.getPageCount();
    } catch {
      throw new InvalidFileError('invalid pdf');
    }
  }

  if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
    try {
      const dimensions = imageSize(await readFile(filePath));
      if (
        dimensions.width === undefined ||
        dimensions.height === undefined ||
        dimensions.width <= 0 ||
        dimensions.height <= 0
      ) {
        throw new Error('invalid dimensions');
      }
      if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
        throw new InvalidFileError('image too large');
      }
      result.width = dimensions.width;
      result.height = dimensions.height;
    } catch (error) {
      if (error instanceof InvalidFileError) {
        throw error;
      }
      throw new InvalidFileError('invalid image');
    }
  }

  return result;
}

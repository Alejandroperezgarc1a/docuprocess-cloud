import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { fileTypeFromBuffer } from 'file-type';
import { imageSize } from 'image-size';
import { PDFDocument } from 'pdf-lib';
import { extractText, getDocumentProxy } from 'unpdf';
import exifr from 'exifr';
import { cleanExtractedText, summarizeText, textWords } from './summarize.js';
import type {
  DocumentMetadata,
  DocumentResult,
  ExifMetadata,
  GpsMetadata,
  ImageMetadata,
  PdfMetadata,
  PdfPageSize,
  TextChunk,
  TextMetadata,
} from './types.js';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain',
]);

/** Limite defensivo contra imagenes con dimensiones desproporcionadas. */
const MAX_IMAGE_PIXELS = 50_000_000;
const HEADER_BYTES = 4100;

/** Topes de analisis de texto: el archivo puede pesar 10 MB, el resultado no. */
const MAX_ANALYSIS_CHARS = 200_000;
const MAX_PDF_TEXT_PAGES = 40;
const SUMMARY_MAX_CHARS = 600;
const PREVIEW_MAX_CHARS = 400;
const MAX_PAGE_SIZES = 100;
const MAX_KEYWORDS = 50;
const MAX_TEXT_CHUNKS = 20;

/** Limite practico del item de DynamoDB (400 KB); se deja margen para el resto del item. */
const MAX_RESULT_BYTES = 350_000;

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'text/plain': 'txt',
};

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
  // Si el cliente declaro texto pero el contenido no es UTF-8 valido, no se
  // acepta: el worker valida el archivo real, no la cabecera declarada.
  void declaredContentType;
  throw new UnsupportedFileTypeError();
}

interface FileHashes {
  sha256: string;
  sha1: string;
  md5: string;
}

async function hashFile(filePath: string): Promise<FileHashes> {
  const sha256 = createHash('sha256');
  const sha1 = createHash('sha1');
  const md5 = createHash('md5');
  for await (const chunk of createReadStream(filePath)) {
    const buffer = chunk as Buffer;
    sha256.update(buffer);
    sha1.update(buffer);
    md5.update(buffer);
  }
  return {
    sha256: sha256.digest('hex'),
    sha1: sha1.digest('hex'),
    md5: md5.digest('hex'),
  };
}

/** Elimina controles, recorta y limita cualquier cadena que venga del archivo. */
function cleanString(value: unknown, max = 500): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const clean = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length === 0) {
    return undefined;
  }
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value;
}

function isoDate(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) {
      return date.toISOString();
    }
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) continue;
    output[key] = entry;
  }
  return output as T;
}

/* ------------------------------------------------------------------ */
/* Texto: estadisticas, preview y resumen extractivo                   */
/* ------------------------------------------------------------------ */

function newlineKind(value: string): string {
  if (value.includes('\r\n')) return 'CRLF';
  if (value.includes('\r')) return 'CR';
  return 'LF';
}

function buildTextMetadata(
  value: string,
  source: 'txt' | 'pdf',
  options: {
    bom?: boolean;
    pagesAnalyzed?: number;
    truncated?: boolean;
    previewText?: string;
  } = {},
): TextMetadata {
  const truncatedChars = Array.from(value);
  const analysis =
    truncatedChars.length > MAX_ANALYSIS_CHARS
      ? truncatedChars.slice(0, MAX_ANALYSIS_CHARS).join('')
      : value;
  const lines = analysis.length === 0 ? 0 : analysis.split(/\r\n|\r|\n/).length;
  const paragraphs = analysis
    .split(/\r\n\s*\r\n|\r\s*\r|\n\s*\n/)
    .filter((paragraph) => paragraph.trim().length > 0).length;
  const previewSource = options.previewText ?? analysis;

  return {
    source,
    encoding: 'utf-8',
    bom: options.bom ?? false,
    newline: newlineKind(analysis),
    lines,
    words: textWords(analysis).length,
    characters: truncatedChars.length,
    paragraphs,
    ...(options.pagesAnalyzed !== undefined
      ? { pagesAnalyzed: options.pagesAnalyzed }
      : {}),
    truncated: (options.truncated ?? false) || truncatedChars.length > MAX_ANALYSIS_CHARS,
    preview: truncate(previewSource.replace(/\s+/g, ' ').trim(), PREVIEW_MAX_CHARS),
  };
}

/* ------------------------------------------------------------------ */
/* PNG: IHDR, pHYs y chunks de texto                                   */
/* ------------------------------------------------------------------ */

interface PngInfo {
  bitDepth?: number;
  colorType?: string;
  hasAlpha?: boolean;
  interlaced?: boolean;
  dpi?: number;
  textChunks?: TextChunk[];
}

const PNG_COLOR_TYPES: Record<number, string> = {
  0: 'Gris',
  2: 'Color RGB',
  3: 'Paleta',
  4: 'Gris con alfa',
  6: 'Color RGB con alfa',
};

function parsePng(bytes: Buffer): PngInfo {
  const info: PngInfo = {};
  const chunks: TextChunk[] = [];
  let hasAlpha = false;
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length) break;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) break;
    const data = bytes.subarray(start, end);

    if (type === 'IHDR' && data.length >= 13) {
      const colorTypeValue = data.readUInt8(9);
      info.bitDepth = data.readUInt8(8);
      info.colorType =
        PNG_COLOR_TYPES[colorTypeValue] ?? `Desconocido (${colorTypeValue})`;
      info.interlaced = data.readUInt8(12) !== 0;
      hasAlpha = colorTypeValue === 4 || colorTypeValue === 6;
    } else if (type === 'pHYs' && data.length >= 9) {
      const pixelsPerMeterX = data.readUInt32BE(0);
      const unit = data[8];
      if (unit === 1 && pixelsPerMeterX > 0) {
        info.dpi = Math.round(pixelsPerMeterX * 0.0254);
      }
    } else if (type === 'tRNS') {
      hasAlpha = true;
    } else if (type === 'tEXt' || type === 'iTXt') {
      if (chunks.length >= MAX_TEXT_CHUNKS) {
        offset = end + 4;
        continue;
      }
      const separator = data.indexOf(0);
      if (separator > 0) {
        const keyword = cleanString(data.toString('latin1', 0, separator), 80);
        let text: string | undefined;
        if (type === 'tEXt') {
          text = cleanString(data.toString('latin1', separator + 1), 300);
        } else if (data.length > separator + 3) {
          const compressed = data[separator + 1] !== 0;
          // El texto comprimido se omite: no se justifica inflar chunks del archivo.
          if (!compressed) {
            let cursor = separator + 3;
            const languageEnd = data.indexOf(0, cursor);
            if (languageEnd >= 0) {
              cursor = data.indexOf(0, languageEnd + 1) + 1;
              if (cursor > 0 && cursor < data.length) {
                text = cleanString(data.toString('utf8', cursor), 300);
              }
            }
          }
        }
        if (keyword && text) {
          chunks.push({ keyword, text });
        }
      }
    }

    offset = end + 4;
    if (type === 'IEND') break;
  }

  info.hasAlpha = hasAlpha;
  if (chunks.length > 0) info.textChunks = chunks;
  return info;
}

/* ------------------------------------------------------------------ */
/* JPEG: SOF (profundidad/componentes), JFIF (DPI) y EXIF              */
/* ------------------------------------------------------------------ */

interface JpegInfo {
  bitDepth?: number;
  components?: number;
  dpi?: number;
  textChunks?: TextChunk[];
}

function parseJpeg(bytes: Buffer): JpegInfo {
  const info: JpegInfo = {};
  const chunks: TextChunk[] = [];
  let offset = 2;

  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let markerOffset = offset + 1;
    while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    const marker = bytes[markerOffset];
    if (marker === undefined) break;
    offset = markerOffset + 1;

    // Marcadores sin longitud (SOI, EOI, RSTn, TEM).
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)) {
      if (marker === 0xd9) break;
      continue;
    }
    if (offset + 2 > bytes.length) break;

    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    const start = offset + 2;
    const data = bytes.subarray(start, offset + length);

    if (marker === 0xe0 && data.length >= 12 && data.toString('ascii', 0, 5) === 'JFIF\0') {
      const unit = data[7];
      const xDensity = data.readUInt16BE(8);
      if (unit === 1 && xDensity > 0) {
        info.dpi = xDensity;
      } else if (unit === 2 && xDensity > 0) {
        info.dpi = Math.round(xDensity * 2.54);
      }
    } else if (
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc &&
      data.length >= 6
    ) {
      info.bitDepth = data[0];
      info.components = data[5];
    } else if (marker === 0xfe && chunks.length < MAX_TEXT_CHUNKS) {
      const comment = cleanString(data.toString('utf8'), 300);
      if (comment) chunks.push({ keyword: 'Comentario', text: comment });
    }

    if (marker === 0xda) break; // empieza el scan; el resto son datos comprimidos
    offset += length;
  }

  if (chunks.length > 0) info.textChunks = chunks;
  return info;
}

async function extractExif(bytes: Buffer): Promise<{
  exif?: ExifMetadata;
  gps?: GpsMetadata;
}> {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = (await exifr.parse(bytes, { gps: true })) as
      | Record<string, unknown>
      | undefined;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};

  const iso = parsed.ISO;
  const isoValue = Array.isArray(iso) ? finiteNumber(iso[0]) : finiteNumber(iso);
  const colorSpace = finiteNumber(parsed.ColorSpace);
  const flash = finiteNumber(parsed.Flash);
  const whiteBalance = finiteNumber(parsed.WhiteBalance);
  const metering = finiteNumber(parsed.MeteringMode);
  const program = finiteNumber(parsed.ExposureProgram);

  const exif = pruneUndefined({
    make: cleanString(parsed.Make, 120),
    model: cleanString(parsed.Model, 120),
    lensModel: cleanString(parsed.LensModel ?? parsed.Lens, 120),
    software: cleanString(parsed.Software, 120),
    artist: cleanString(parsed.Artist, 120),
    copyright: cleanString(parsed.Copyright, 160),
    description: cleanString(parsed.ImageDescription, 300),
    dateTimeOriginal: isoDate(parsed.DateTimeOriginal ?? parsed.CreateDate),
    createDate: isoDate(parsed.CreateDate),
    modifyDate: isoDate(parsed.ModifyDate),
    exposureTime: finiteNumber(parsed.ExposureTime),
    fNumber: finiteNumber(parsed.FNumber),
    iso: isoValue,
    focalLength: finiteNumber(parsed.FocalLength),
    focalLength35mm: finiteNumber(parsed.FocalLengthIn35mmFormat),
    orientation: finiteNumber(parsed.Orientation),
    colorSpace:
      colorSpace === 1 ? 'sRGB' : colorSpace === 65535 ? 'Sin calibrar' : undefined,
    flash:
      flash === undefined
        ? undefined
        : (flash & 1) === 1
          ? 'Sí'
          : 'No',
    whiteBalance:
      whiteBalance === undefined
        ? undefined
        : whiteBalance === 0
          ? 'Automático'
          : 'Manual',
    meteringMode: metering === undefined ? undefined : `Modo ${metering}`,
    exposureProgram: program === undefined ? undefined : `Programa ${program}`,
  }) as ExifMetadata;

  const latitude = finiteNumber(parsed.latitude);
  const longitude = finiteNumber(parsed.longitude);
  const altitudeRaw = finiteNumber(parsed.GPSAltitude);
  const altitudeRef = finiteNumber(parsed.GPSAltitudeRef);
  const gps =
    latitude !== undefined &&
    longitude !== undefined &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
      ? pruneUndefined({
          latitude,
          longitude,
          altitude:
            altitudeRaw === undefined
              ? undefined
              : altitudeRef === 1
                ? -altitudeRaw
                : altitudeRaw,
        })
      : undefined;

  return {
    ...(Object.keys(exif).length > 0 ? { exif } : {}),
    ...(gps !== undefined ? { gps: gps as unknown as GpsMetadata } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

function pdfVersion(header: Buffer): string | undefined {
  const match = header.toString('latin1').match(/%PDF-(\d+\.\d+)/);
  return match?.[1];
}

function keywordsList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value
      .map((entry) => cleanString(entry, 120))
      .filter((entry): entry is string => entry !== undefined)
      .slice(0, MAX_KEYWORDS);
    return list.length > 0 ? list : undefined;
  }
  const text = cleanString(value, 1000);
  if (!text) return undefined;
  const list = text
    .split(/[,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, MAX_KEYWORDS);
  return list.length > 0 ? list : undefined;
}

async function extractPdf(
  bytes: Buffer,
  header: Buffer,
): Promise<{ pdf: PdfMetadata; text?: string; pagesAnalyzed?: number; truncated: boolean }> {
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch {
    throw new InvalidFileError('invalid pdf');
  }

  let pages: number;
  try {
    pages = document.getPageCount();
  } catch {
    // pdf-lib difiere la lectura del arbol de paginas; un archivo truncado puede
    // fallar aqui aunque load() haya aceptado la cabecera.
    throw new InvalidFileError('invalid pdf');
  }
  const pageSizes: PdfPageSize[] = [];
  try {
    document.getPages().slice(0, MAX_PAGE_SIZES).forEach((page, index) => {
      const size = page.getSize();
      pageSizes.push({
        page: index + 1,
        width: Math.round(size.width * 100) / 100,
        height: Math.round(size.height * 100) / 100,
      });
    });
  } catch {
    // pdf-lib puede fallar en paginas danadas; el resto de metadatos sigue siendo util.
  }

  const uniformPageSize =
    pageSizes.length > 0 &&
    pageSizes.every(
      (size) =>
        Math.abs(size.width - pageSizes[0]!.width) < 0.01 &&
        Math.abs(size.height - pageSizes[0]!.height) < 0.01,
    )
      ? { width: pageSizes[0]!.width, height: pageSizes[0]!.height }
      : undefined;

  const safe = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };

  let hasForm = false;
  try {
    hasForm = document.getForm().getFields().length > 0;
  } catch {
    hasForm = false;
  }

  const pdf: PdfMetadata = pruneUndefined({
    version: pdfVersion(header),
    pages,
    pageSizes: pageSizes.length > 0 ? pageSizes : undefined,
    uniformPageSize,
    title: cleanString(safe(() => document.getTitle())),
    author: cleanString(safe(() => document.getAuthor())),
    subject: cleanString(safe(() => document.getSubject()), 800),
    keywords: keywordsList(safe(() => document.getKeywords())),
    creator: cleanString(safe(() => document.getCreator())),
    producer: cleanString(safe(() => document.getProducer())),
    creationDate: isoDate(safe(() => document.getCreationDate())),
    modificationDate: isoDate(safe(() => document.getModificationDate())),
    encrypted: document.isEncrypted,
    hasForm,
    linearized: header.subarray(0, 4096).toString('latin1').includes('/Linearized'),
  }) as PdfMetadata;

  // La extraccion de texto es best-effort: un PDF escaneado, cifrado o con fuentes
  // danadas sigue siendo un PDF valido y debe terminar DONE sin resumen.
  try {
    const proxy = await getDocumentProxy(new Uint8Array(bytes));
    const analyzedPages = Math.min(proxy.numPages, MAX_PDF_TEXT_PAGES);
    const extracted = await extractText(proxy, { mergePages: false });
    const pagesText = Array.isArray(extracted.text)
      ? extracted.text.slice(0, analyzedPages)
      : [String(extracted.text)];
    const text = cleanExtractedText(pagesText.join('\n\n'), {
      pages: pagesText,
    });
    return {
      pdf,
      ...(text.length > 0
        ? {
            text,
            pagesAnalyzed: analyzedPages,
            truncated: proxy.numPages > MAX_PDF_TEXT_PAGES || text.length > MAX_ANALYSIS_CHARS,
          }
        : { truncated: false }),
    };
  } catch {
    return { pdf, truncated: false };
  }
}

/* ------------------------------------------------------------------ */
/* Recorte final para DynamoDB                                         */
/* ------------------------------------------------------------------ */

function resultSize(result: DocumentResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

/**
 * DynamoDB limita el item a 400 KB. Si el resultado crece demasiado se eliminan
 * primero los datos voluminosos y menos criticos, marcando metadataTruncated.
 */
export function fitResultForStorage(result: DocumentResult): DocumentResult {
  if (resultSize(result) <= MAX_RESULT_BYTES) {
    return result;
  }

  result.metadataTruncated = true;
  if (result.metadata) result.metadata.metadataTruncated = true;

  const droppers: Array<() => boolean> = [
    () => {
      const pdf = result.metadata?.pdf;
      if (pdf?.pageSizes === undefined) return false;
      delete pdf.pageSizes;
      return true;
    },
    () => {
      const text = result.metadata?.text;
      if (text?.preview === undefined) return false;
      delete text.preview;
      return true;
    },
    () => {
      const image = result.metadata?.image;
      if (image?.exif === undefined) return false;
      delete image.exif;
      return true;
    },
    () => {
      const image = result.metadata?.image;
      if (image?.textChunks === undefined) return false;
      delete image.textChunks;
      return true;
    },
    () => {
      const pdf = result.metadata?.pdf;
      if (pdf?.keywords === undefined) return false;
      delete pdf.keywords;
      return true;
    },
    () => {
      if (result.metadata?.text === undefined) return false;
      delete result.metadata.text;
      return true;
    },
    () => {
      const image = result.metadata?.image;
      if (image?.gps === undefined) return false;
      delete image.gps;
      return true;
    },
  ];

  for (const drop of droppers) {
    if (resultSize(result) <= MAX_RESULT_BYTES) break;
    drop();
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Punto de entrada                                                    */
/* ------------------------------------------------------------------ */

/**
 * Extrae metadatos del archivo real. Lanza errores permanentes que el proceso
 * convierte en FAILED con un mensaje estable para el frontend.
 *
 * `processedAt` y `processingMs` los completa process.ts, que es quien mide el
 * tiempo total de procesamiento.
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

  const hashes = await hashFile(filePath);
  const result: DocumentResult = {
    sizeBytes: info.size,
    mimeType,
    ...hashes,
    metadataVersion: 2,
  };
  const metadata: DocumentMetadata = {
    file: {
      extension: EXTENSIONS[mimeType] ?? mimeType.split('/').pop() ?? 'bin',
      sizeBytes: info.size,
      mimeType,
      ...hashes,
    },
  };

  if (mimeType === 'application/pdf') {
    const bytes = await readFile(filePath);
    const pdfResult = await extractPdf(bytes, header);
    result.pages = pdfResult.pdf.pages;
    result.metadata = { ...metadata, pdf: pdfResult.pdf };

    if (pdfResult.text !== undefined) {
      const textMetadata = buildTextMetadata(pdfResult.text, 'pdf', {
        pagesAnalyzed: pdfResult.pagesAnalyzed,
        truncated: pdfResult.truncated,
      });
      result.metadata.text = textMetadata;
      const summary = summarizeText(pdfResult.text, {
        maxChars: SUMMARY_MAX_CHARS,
      });
      if (summary !== undefined) result.summary = summary;
    }
  } else if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
    const bytes = await readFile(filePath);
    const dimensions = imageSize(bytes);
    if (
      dimensions.width === undefined ||
      dimensions.height === undefined ||
      dimensions.width <= 0 ||
      dimensions.height <= 0
    ) {
      throw new InvalidFileError('invalid image');
    }
    if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
      throw new InvalidFileError('image too large');
    }

    const image: ImageMetadata = {
      format: mimeType === 'image/png' ? 'PNG' : 'JPEG',
      width: dimensions.width,
      height: dimensions.height,
      aspectRatio:
        Math.round((dimensions.width / dimensions.height) * 1000) / 1000,
      megapixels:
        Math.round(((dimensions.width * dimensions.height) / 1_000_000) * 100) / 100,
    };

    if (mimeType === 'image/png') {
      const png = parsePng(bytes);
      image.colorType = png.colorType;
      image.bitDepth = png.bitDepth;
      image.hasAlpha = png.hasAlpha;
      image.interlaced = png.interlaced;
      image.dpi = png.dpi;
      image.textChunks = png.textChunks;
    } else {
      const jpeg = parseJpeg(bytes);
      image.bitDepth = jpeg.bitDepth;
      image.dpi = jpeg.dpi;
      image.colorType =
        jpeg.components === 1
          ? 'Gris'
          : jpeg.components === 4
            ? 'CMYK'
            : jpeg.components === 3
              ? 'YCbCr'
              : undefined;
      image.hasAlpha = false;
      image.interlaced = false;
      image.textChunks = jpeg.textChunks;
      const exif = await extractExif(bytes);
      image.exif = exif.exif;
      image.gps = exif.gps;
    }

    result.width = dimensions.width;
    result.height = dimensions.height;
    result.metadata = { ...metadata, image };
  } else {
    const bytes = await readFile(filePath);
    const bom =
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf;
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(
      bom ? bytes.subarray(3) : bytes,
    );
    const cleaned = cleanExtractedText(decoded);
    const textMetadata = buildTextMetadata(decoded, 'txt', {
      bom,
      previewText: cleaned,
    });
    result.metadata = { ...metadata, text: textMetadata };
    const summary = summarizeText(cleaned, { maxChars: SUMMARY_MAX_CHARS });
    if (summary !== undefined) result.summary = summary;
  }

  return fitResultForStorage(result);
}

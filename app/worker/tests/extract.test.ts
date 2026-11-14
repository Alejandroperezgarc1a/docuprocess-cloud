import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, it } from 'node:test';
import {
  extractMetadata,
  FileTooLargeError,
  InvalidFileError,
  UnsupportedFileTypeError,
} from '../src/extract.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function withTemp<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'docuprocess-extract-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('extractMetadata', () => {
  it('extrae paginas, tamano y sha256 de un PDF', async () => {
    await withTemp(async (dir) => {
      const pdf = await PDFDocument.create();
      pdf.addPage([200, 300]);
      const bytes = await pdf.save();
      const path = join(dir, 'sample.pdf');
      await writeFile(path, bytes);

      const result = await extractMetadata(path, 'application/pdf', 10_000_000);

      assert.equal(result.mimeType, 'application/pdf');
      assert.equal(result.pages, 1);
      assert.equal(result.sizeBytes, bytes.length);
      assert.match(result.sha256, /^[0-9a-f]{64}$/);
      assert.match(result.sha1 ?? '', /^[0-9a-f]{40}$/);
      assert.match(result.md5 ?? '', /^[0-9a-f]{32}$/);
      assert.equal(result.width, undefined);
      assert.equal(result.metadataVersion, 3);
      assert.equal(result.metadata?.file.extension, 'pdf');
      assert.equal(result.metadata?.pdf?.pages, 1);
      assert.deepEqual(result.metadata?.pdf?.pageSizes?.[0], {
        page: 1,
        width: 200,
        height: 300,
      });
      assert.deepEqual(result.metadata?.pdf?.uniformPageSize, {
        width: 200,
        height: 300,
      });
    });
  });

  it('extrae metadatos tecnicos, texto y resumen de un PDF', async () => {
    await withTemp(async (dir) => {
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const page = pdf.addPage([300, 400]);
      page.drawText('Este informe describe el procesamiento de documentos.', {
        x: 24,
        y: 340,
        size: 11,
        font,
      });
      page.drawText('La aplicacion extrae metadatos tecnicos y genera un resumen.', {
        x: 24,
        y: 320,
        size: 11,
        font,
      });
      pdf.setTitle('Informe de prueba');
      pdf.setAuthor('Equipo DocuProcess');
      pdf.setSubject('Metadatos y resumen');
      pdf.setKeywords(['informe', 'metadatos']);
      pdf.setCreator('Pruebas automatizadas');
      pdf.setProducer('pdf-lib');
      pdf.setCreationDate(new Date('2024-01-02T03:04:05Z'));
      const bytes = await pdf.save();
      const path = join(dir, 'informe.pdf');
      await writeFile(path, bytes);

      const result = await extractMetadata(path, 'application/pdf', 10_000_000);

      assert.equal(result.metadata?.pdf?.title, 'Informe de prueba');
      assert.equal(result.metadata?.pdf?.author, 'Equipo DocuProcess');
      assert.equal(result.metadata?.pdf?.subject, 'Metadatos y resumen');
      assert.equal(result.metadata?.pdf?.creator, 'Pruebas automatizadas');
      assert.equal(result.metadata?.pdf?.producer, 'pdf-lib');
      assert.equal(result.metadata?.pdf?.creationDate, '2024-01-02T03:04:05.000Z');
      assert.equal(result.metadata?.pdf?.encrypted, false);
      assert.ok((result.metadata?.pdf?.keywords ?? []).join(' ').includes('informe'));
      assert.equal(result.metadata?.text?.source, 'pdf');
      assert.equal(result.metadata?.text?.pagesAnalyzed, 1);
      assert.ok((result.metadata?.text?.words ?? 0) > 5);
      assert.match(result.summary ?? '', /informe/i);
    });
  });

  it('extrae dimensiones de un PNG real', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'sample.png');
      await writeFile(path, PNG_1X1);

      const result = await extractMetadata(path, 'image/png', 10_000_000);

      assert.equal(result.mimeType, 'image/png');
      assert.equal(result.width, 1);
      assert.equal(result.height, 1);
      assert.equal(result.pages, undefined);
      assert.equal(result.metadata?.image?.format, 'PNG');
      assert.equal(result.metadata?.image?.bitDepth, 8);
      assert.equal(result.metadata?.image?.hasAlpha, true);
    });
  });

  it('detecta texto plano aunque file-type no lo reconozca', async () => {
    await withTemp(async (dir) => {
      const content = Buffer.from('hola mundo\n', 'utf8');
      const path = join(dir, 'sample.txt');
      await writeFile(path, content);

      const result = await extractMetadata(path, 'text/plain', 10_000_000);

      assert.equal(result.mimeType, 'text/plain');
      assert.equal(result.sizeBytes, content.length);
      assert.equal(result.pages, undefined);
      assert.equal(result.width, undefined);
      assert.equal(result.metadata?.text?.source, 'txt');
      assert.equal(result.metadata?.text?.newline, 'LF');
      assert.ok((result.metadata?.text?.words ?? 0) >= 2);
      assert.equal(typeof result.summary, 'string');
    });
  });

  it('detecta BOM y saltos CRLF en un TXT', async () => {
    await withTemp(async (dir) => {
      const content = Buffer.from(
        '\uFEFFPrimera linea del documento.\r\nSegunda linea con mas texto.\r\nTercera linea final.\r\n',
        'utf8',
      );
      const path = join(dir, 'windows.txt');
      await writeFile(path, content);

      const result = await extractMetadata(path, 'text/plain', 10_000_000);

      assert.equal(result.metadata?.file.extension, 'txt');
      assert.equal(result.metadata?.text?.bom, true);
      assert.equal(result.metadata?.text?.newline, 'CRLF');
      assert.equal(result.metadata?.text?.lines, 4);
      assert.equal(result.metadata?.text?.paragraphs, 1);
      assert.ok((result.metadata?.text?.characters ?? 0) > 0);
      assert.ok(result.metadata?.text?.preview?.includes('Primera linea'));
      assert.match(result.summary ?? '', /documento/i);
    });
  });

  it('rechaza un tipo no permitido', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'archive.zip');
      await writeFile(
        path,
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
      );

      await assert.rejects(
        extractMetadata(path, 'application/zip', 10_000_000),
        UnsupportedFileTypeError,
      );
    });
  });

  it('rechaza un archivo mayor al limite', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'big.txt');
      await writeFile(path, Buffer.from('123456'));

      await assert.rejects(
        extractMetadata(path, 'text/plain', 5),
        FileTooLargeError,
      );
    });
  });

  it('rechaza un PDF corrupto sin romper el proceso', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'broken.pdf');
      await writeFile(path, Buffer.from('%PDF-1.4\nesto no es un pdf'));

      await assert.rejects(
        extractMetadata(path, 'application/pdf', 10_000_000),
        (error: unknown) =>
          error instanceof InvalidFileError && error.message === 'invalid pdf',
      );
    });
  });

  it('rechaza un archivo vacio', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'empty.txt');
      await writeFile(path, Buffer.alloc(0));

      await assert.rejects(
        extractMetadata(path, 'text/plain', 10_000_000),
        (error: unknown) =>
          error instanceof InvalidFileError && error.message === 'empty file',
      );
    });
  });
});

/* ------------------------------------------------------------------ */
/* Metadata ampliada (v3): chunks PNG, EXIF/GPS JPEG y metricas de texto */
/* ------------------------------------------------------------------ */

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

function pngWithMetadataChunks(): Buffer {
  const signature = PNG_1X1.subarray(0, 8);
  const chunks: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= PNG_1X1.length) {
    const length = PNG_1X1.readUInt32BE(offset);
    const type = PNG_1X1.toString('ascii', offset + 4, offset + 8);
    chunks.push(PNG_1X1.subarray(offset, offset + 12 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const gama = pngChunk('gAMA', Buffer.from([0x00, 0x01, 0x86, 0xa0]));
  const srgb = pngChunk('sRGB', Buffer.from([3]));
  const iccp = pngChunk(
    'iCCP',
    Buffer.concat([Buffer.from('icc\0'), Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00])]),
  );
  const time = pngChunk('tIME', Buffer.from([0x07, 0xea, 0x0b, 0x0d, 0x0c, 0x30, 0x00]));
  const bkgd = pngChunk('bKGD', Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  chunks.splice(chunks.length - 1, 0, gama, srgb, iccp, time, bkgd);
  return Buffer.concat([signature, ...chunks]);
}

const pad4 = (n: number): number => (n + 3) & ~3;
const exifAscii = (s: string): Buffer => Buffer.from(s + '\0', 'latin1');
const rat = (n: number, d: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(n, 0);
  b.writeUInt32LE(d, 4);
  return b;
};
const exifShort = (v: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
};

type ExifEntry = { tag: number; type: number; data?: Buffer; offset?: number };

function buildExifIfd(entries: ExifEntry[], base: number): { ifd: Buffer; extra: Buffer[] } {
  const headerSize = 2 + entries.length * 12 + 4;
  let extraOffset = base + headerSize;
  const ifd = Buffer.alloc(headerSize);
  const extra: Buffer[] = [];
  ifd.writeUInt16LE(entries.length, 0);
  let o = 2;
  for (const e of entries) {
    if (e.data === undefined) {
      ifd.writeUInt16LE(e.tag, o);
      ifd.writeUInt16LE(e.type, o + 2);
      ifd.writeUInt32LE(1, o + 4);
      ifd.writeUInt32LE(e.offset ?? 0, o + 8);
      o += 12;
      continue;
    }
    const sz = e.data.length;
    const count = Math.ceil(sz / (e.type === 3 ? 2 : e.type === 5 ? 8 : 1));
    ifd.writeUInt16LE(e.tag, o);
    ifd.writeUInt16LE(e.type, o + 2);
    ifd.writeUInt32LE(count, o + 4);
    if (sz <= 4) {
      Buffer.concat([e.data, Buffer.alloc(4 - sz)]).copy(ifd, o + 8);
    } else {
      ifd.writeUInt32LE(extraOffset, o + 8);
      extra.push(Buffer.concat([e.data, Buffer.alloc(pad4(sz) - sz)]));
      extraOffset += pad4(sz);
    }
    o += 12;
  }
  ifd.writeUInt32LE(0, o);
  return { ifd, extra };
}

function buildExifJpeg(): Buffer {
  const ifd0Entries: ExifEntry[] = [
    { tag: 0x010f, type: 2, data: exifAscii('TestCam') },
    { tag: 0x0110, type: 2, data: exifAscii('TestCam X1') },
    { tag: 0x0132, type: 2, data: exifAscii('2026:11:13 12:48:00') },
    { tag: 0x8769, type: 4 },
    { tag: 0x8825, type: 4 },
  ];
  const exifEntries: ExifEntry[] = [
    { tag: 0x829a, type: 5, data: rat(1, 250) },
    { tag: 0x829d, type: 5, data: rat(28, 10) },
    { tag: 0x8827, type: 3, data: exifShort(200) },
    { tag: 0x9003, type: 2, data: exifAscii('2026:11:13 12:48:00') },
    { tag: 0x920a, type: 5, data: rat(50, 10) },
    { tag: 0xa431, type: 2, data: exifAscii('SN123456') },
    { tag: 0xa434, type: 2, data: exifAscii('TestLens 50mm') },
  ];
  const gpsEntries: ExifEntry[] = [
    { tag: 0x0000, type: 1, data: Buffer.from([2, 3, 0, 0]) },
    { tag: 0x0001, type: 2, data: exifAscii('N') },
    { tag: 0x0002, type: 5, data: Buffer.concat([rat(4, 1), rat(36, 1), rat(30, 1)]) },
    { tag: 0x0003, type: 2, data: exifAscii('W') },
    { tag: 0x0004, type: 5, data: Buffer.concat([rat(74, 1), rat(5, 1), rat(0, 1)]) },
    { tag: 0x0005, type: 1, data: Buffer.from([0]) },
    { tag: 0x0006, type: 5, data: rat(1234, 100) },
    { tag: 0x000b, type: 5, data: rat(8, 10) },
    { tag: 0x000c, type: 2, data: exifAscii('M') },
    { tag: 0x000d, type: 5, data: rat(3, 10) },
    { tag: 0x0010, type: 2, data: exifAscii('T') },
    { tag: 0x0011, type: 5, data: rat(90, 1) },
    { tag: 0x001b, type: 7, data: Buffer.from('GPS\0', 'latin1') },
    { tag: 0x001d, type: 2, data: exifAscii('2026:11:13') },
  ];

  const ifd0Size = 2 + ifd0Entries.length * 12 + 4;
  const exifSize = 2 + exifEntries.length * 12 + 4;
  const extraSize = (entries: ExifEntry[]): number =>
    entries
      .filter((e) => e.data !== undefined)
      .reduce((acc, e) => (e.data && e.data.length > 4 ? acc + pad4(e.data.length) : acc), 0);

  const ifd0At = 8;
  const exifAt = ifd0At + ifd0Size + extraSize(ifd0Entries);
  const gpsAt = exifAt + exifSize + extraSize(exifEntries);
  const ifd0ExifPtr = ifd0Entries.find((e) => e.tag === 0x8769);
  const ifd0GpsPtr = ifd0Entries.find((e) => e.tag === 0x8825);
  if (!ifd0ExifPtr || !ifd0GpsPtr) {
    throw new Error('IFD pointer entries missing');
  }
  ifd0ExifPtr.offset = exifAt;
  ifd0GpsPtr.offset = gpsAt;

  const ifd0 = buildExifIfd(ifd0Entries, ifd0At);
  const exif = buildExifIfd(exifEntries, exifAt);
  const gps = buildExifIfd(gpsEntries, gpsAt);

  const tiff = Buffer.concat([
    Buffer.from('II*\0', 'latin1'),
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(8, 0);
      return b;
    })(),
    ifd0.ifd,
    ...ifd0.extra,
    exif.ifd,
    ...exif.extra,
    gps.ifd,
    ...gps.extra,
  ]);
  const exifSegment = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1Len = Buffer.alloc(2);
  app1Len.writeUInt16BE(exifSegment.length + 2, 0);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), app1Len, exifSegment]);
  const sof = Buffer.concat([
    Buffer.from([0xff, 0xc0]),
    (() => {
      const l = Buffer.alloc(2);
      l.writeUInt16BE(17, 0);
      return l;
    })(),
    Buffer.from([8, 0, 4, 0, 4, 3, 1, 0x22, 0x00, 2, 0x11, 0x01, 3, 0x11, 0x01]),
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
}

describe('metadata ampliada (v3)', () => {
  it('extrae chunks de PNG (gamma, srgb, icc, tIME, bKGD, metodos)', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'chunks.png');
      await writeFile(path, pngWithMetadataChunks());

      const result = await extractMetadata(path, 'image/png', 10_000_000);

      assert.equal(result.mimeType, 'image/png');
      assert.equal(result.width, 1);
      assert.equal(result.metadataVersion, 3);
      const image = result.metadata?.image;
      assert.equal(image?.format, 'PNG');
      assert.equal(image?.gamma, 1);
      assert.equal(image?.srgbIntent, 3);
      assert.equal(image?.hasIccProfile, true);
      assert.equal(image?.compressionMethod, 0);
      assert.equal(image?.filterMethod, 0);
      assert.equal(image?.lastModified, '2026-11-13T12:48:00Z');
      assert.equal(image?.backgroundColor, 'presente');
    });
  });

  it('extrae EXIF y GPS de un JPEG sintetico', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'photo.jpg');
      await writeFile(path, buildExifJpeg());

      const result = await extractMetadata(path, 'image/jpeg', 10_000_000);

      assert.equal(result.mimeType, 'image/jpeg');
      assert.equal(result.width, 4);
      assert.equal(result.height, 4);
      assert.equal(result.metadataVersion, 3);
      const exif = result.metadata?.image?.exif;
      assert.equal(exif?.make, 'TestCam');
      assert.equal(exif?.model, 'TestCam X1');
      assert.equal(exif?.lensModel, 'TestLens 50mm');
      assert.equal(exif?.bodySerialNumber, 'SN123456');
      assert.equal(exif?.iso, 200);
      assert.equal(exif?.fNumber, 2.8);
      assert.equal(exif?.exposureTime, 0.004);
      assert.equal(exif?.focalLength, 5);
      assert.match(exif?.dateTimeOriginal ?? '', /^2026-11-13T/);
      const gps = result.metadata?.image?.gps;
      assert.ok(Math.abs((gps?.latitude ?? 0) - 4.608333333333333) < 1e-9);
      assert.ok(Math.abs((gps?.longitude ?? 0) - -74.08333333333333) < 1e-9);
      assert.equal(gps?.altitude, 12.34);
      assert.equal(gps?.dop, 0.8);
      assert.equal(gps?.speed, 0.3);
      assert.equal(gps?.imgDirection, 90);
      assert.equal(gps?.timestamp, '2026-11-13T00:00:00.000Z');
      assert.equal(gps?.processingMethod, 'GPS');
    });
  });

  it('calcula metricas de texto e idioma en TXT en espanol', async () => {
    await withTemp(async (dir) => {
      const content = Buffer.from(
        'DocuProcess Cloud es una plataforma que procesa documentos en la nube. ' +
          'Los usuarios suben archivos PDF PNG JPEG y TXT al bucket de S3. ' +
          'El worker reclama cada documento pendiente y extrae metadatos tecnicos completos. ' +
          'Los resultados se guardan en DynamoDB con su historial de eventos. ' +
          'El sistema envia notificaciones por correo electronico cuando el procesamiento termina.',
        'utf8',
      );
      const path = join(dir, 'metricas.txt');
      await writeFile(path, content);

      const result = await extractMetadata(path, 'text/plain', 10_000_000);

      assert.equal(result.mimeType, 'text/plain');
      const text = result.metadata?.text;
      assert.equal(text?.source, 'txt');
      assert.ok((text?.words ?? 0) >= 50);
      assert.ok((text?.uniqueWords ?? 0) > 0);
      assert.ok((text?.uniqueWords ?? 0) < (text?.words ?? 0));
      assert.ok((text?.avgWordsPerSentence ?? 0) > 5);
      assert.ok((text?.avgSentenceLength ?? 0) >= (text?.avgWordsPerSentence ?? 0));
      assert.equal(text?.language, 'es');
      assert.ok((result.summary ?? '').length > 0);
    });
  });
});

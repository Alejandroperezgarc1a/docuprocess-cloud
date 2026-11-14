import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      assert.equal(result.metadataVersion, 2);
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

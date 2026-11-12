import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
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
      assert.equal(result.width, undefined);
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

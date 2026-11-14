import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cleanExtractedText,
  splitSentences,
  summarizeText,
} from '../src/summarize.js';

describe('cleanExtractedText', () => {
  it('une palabras cortadas con guion al final de linea', () => {
    const cleaned = cleanExtractedText('docu-\nmento importante para el proceso');
    assert.equal(cleaned, 'documento importante para el proceso');
  });

  it('elimina numeros de pagina y lineas basura', () => {
    const cleaned = cleanExtractedText(
      'Primer parrafo del documento.\n3\n---\nSegundo parrafo con contenido.\n',
    );
    assert.ok(cleaned.includes('Primer parrafo del documento.'));
    assert.ok(cleaned.includes('Segundo parrafo con contenido.'));
    assert.ok(!/^\s*3\s*$/m.test(cleaned));
    assert.ok(!cleaned.includes('---'));
  });

  it('quita encabezados y pies repetidos entre paginas', () => {
    const pages = [
      'INFORME ANUAL\nContenido de la pagina uno con detalles.\n3',
      'INFORME ANUAL\nContenido de la pagina dos con otros detalles.\n4',
      'INFORME ANUAL\nContenido de la pagina tres con mas detalles.\n5',
    ];
    const cleaned = cleanExtractedText(pages.join('\n\n'), { pages });
    assert.ok(!cleaned.includes('INFORME ANUAL'));
    assert.ok(!/^\s*3\s*$/m.test(cleaned));
    assert.ok(cleaned.includes('pagina uno'));
    assert.ok(cleaned.includes('pagina tres'));
  });
});

describe('splitSentences', () => {
  it('no corta en abreviaturas ni decimales', () => {
    const sentences = splitSentences(
      'El Dr. Garcia llego a las 3.14 horas. Luego se marcho sin avisar.',
    );
    assert.equal(sentences.length, 2);
    assert.ok(sentences[0]?.includes('Dr.'));
    assert.ok(sentences[0]?.includes('3.14'));
    assert.equal(sentences[1], 'Luego se marcho sin avisar.');
  });

  it('usa las vinetas como frontera de oracion', () => {
    const sentences = splitSentences(
      'Primer punto importante.\n• Segundo punto relevante.\n• Tercer punto final.',
    );
    assert.equal(sentences.length, 3);
    assert.ok(sentences[1]?.includes('Segundo punto'));
    assert.ok(sentences[2]?.includes('Tercer punto'));
  });
});

describe('summarizeText', () => {
  it('devuelve el texto completo cuando es corto', () => {
    const summary = summarizeText('Texto breve de prueba.');
    assert.equal(summary, 'Texto breve de prueba.');
  });

  it('devuelve undefined para texto vacio', () => {
    assert.equal(summarizeText('   \n  '), undefined);
  });

  it('no repite oraciones duplicadas', () => {
    const sentence =
      'La plataforma procesa documentos y genera metadatos tecnicos para los usuarios finales.';
    const repeated = Array.from({ length: 12 }, () => sentence).join(' ');
    const summary = summarizeText(repeated);
    assert.ok(summary !== undefined);
    const occurrences = summary!.split(sentence).length - 1;
    assert.equal(occurrences, 1);
  });

  it('prioriza terminos significativos con acentos', () => {
    const filler =
      'El sistema registra eventos y guarda informacion relevante en la base de datos.';
    const text = Array.from(
      { length: 8 },
      () => `La informacion del documento se analiza. ${filler}`,
    ).join(' ');
    const summary = summarizeText(text);
    assert.ok(summary !== undefined);
    assert.match(summary!, /informaci[oó]n/i);
  });

  it('corta en limite de palabra cuando no hay puntuacion', () => {
    const text = 'palabra '.repeat(200).trim();
    const summary = summarizeText(text, { maxChars: 100 });
    assert.ok(summary !== undefined);
    assert.ok(summary!.length <= 100);
    assert.ok(summary!.endsWith('…'));
    assert.ok(!summary!.endsWith('palabr…'));
  });

  it('respeta el limite sin cortar oraciones a la mitad', () => {
    const sentences = Array.from(
      { length: 12 },
      (_, index) =>
        `La oracion numero ${index + 1} describe un aspecto distinto del documento revisado.`,
    );
    const summary = summarizeText(sentences.join(' '), { maxChars: 600 });
    assert.ok(summary !== undefined);
    assert.ok(summary!.length <= 600);
    assert.ok(summary!.endsWith('.') || summary!.endsWith('…'));
  });

  it('respeta maxChars en textos largos con muchas oraciones', () => {
    const text = Array.from(
      { length: 40 },
      (_, index) => `Contenido de la seccion ${index} con detalles tecnicos relevantes del informe.`,
    ).join(' ');
    const summary = summarizeText(text, { maxChars: 300 });
    assert.ok(summary !== undefined);
    assert.ok(summary!.length <= 300);
  });
});

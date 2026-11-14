/**
 * Limpieza de texto extraido y resumen extractivo.
 *
 * El resumen que se muestra bajo la etiqueta "Resumen" del detalle se genera
 * aqui. El objetivo es producir texto legible: sin encabezados/pies repetidos,
 * sin numeros de pagina, sin oraciones cortadas y sin repetir la misma idea.
 */

/* ------------------------------------------------------------------ */
/* Palabras y normalizacion                                            */
/* ------------------------------------------------------------------ */

export function normalizeWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

export const STOPWORDS: Set<string> = new Set(
  [
    // Espanol
    'a', 'al', 'algo', 'algunas', 'algunos', 'ante', 'antes', 'como', 'con',
    'contra', 'cual', 'cuando', 'de', 'del', 'desde', 'donde', 'durante', 'e',
    'el', 'ella', 'ellas', 'ellos', 'en', 'entre', 'era', 'eran', 'es', 'esa',
    'ese', 'eso', 'esta', 'estaba', 'estan', 'este', 'esto', 'estos', 'fue',
    'fueron', 'ha', 'han', 'hasta', 'hay', 'la', 'las', 'le', 'les', 'lo',
    'los', 'mas', 'me', 'mi', 'muy', 'no', 'nos', 'o', 'otra', 'otro', 'para',
    'pero', 'poco', 'por', 'porque', 'que', 'quien', 'se', 'sea', 'ser', 'si',
    'sin', 'sobre', 'son', 'su', 'sus', 'te', 'tiene', 'todo', 'todos', 'tu',
    'un', 'una', 'unas', 'uno', 'unos', 'y', 'ya', 'tambien', 'asi', 'cada',
    // Ingles
    'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do',
    'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how',
    'if', 'in', 'into', 'is', 'it', 'its', 'may', 'more', 'most', 'not', 'of',
    'on', 'or', 'our', 'she', 'should', 'so', 'such', 'than', 'that', 'the',
    'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was',
    'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with', 'would',
    'you', 'your',
  ].map((word) => normalizeWord(word)),
);

export function textWords(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ */
/* Limpieza del texto extraido                                         */
/* ------------------------------------------------------------------ */

const JUNK_LINE_PATTERNS = [
  // "Pagina 3", "Pagina 3 de 10", "Pag. 3/10"
  /^p[áa]g(?:ina)?\.?\s*\d+(\s*(?:de|\/)\s*\d+)?$/i,
  /^(?:page|pág\.?|pag\.?)\s*\d+/i,
  /^\d+\s*\/\s*\d+$/,
  // Numero de pagina suelto.
  /^\d{1,4}$/,
  // Separadores y vinetas vacias.
  /^[-–—_=·•▪◦.\s]+$/,
];

function normalizeLine(line: string): string {
  return line.replace(/[ \t]+/g, ' ').trim();
}

function isJunkLine(line: string): boolean {
  if (line.length === 0) return true;
  return JUNK_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

/** Detecta encabezados/pies que se repiten en la mayoria de las paginas. */
function collectRepeatedEdgeLines(pages: string[]): Set<string> {
  const repeated = new Set<string>();
  if (pages.length < 3) return repeated;

  const counts = new Map<string, number>();
  for (const page of pages) {
    const lines = page
      .split(/\r\n?|\n/)
      .map(normalizeLine)
      .filter((line) => line.length > 0);
    const edges = new Set([...lines.slice(0, 2), ...lines.slice(-2)]);
    for (const line of edges) {
      if (line.length > 140) continue;
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }

  const threshold = Math.max(2, Math.ceil(pages.length * 0.6));
  for (const [line, count] of counts) {
    if (count >= threshold) repeated.add(line);
  }
  return repeated;
}

export interface CleanTextOptions {
  /** Paginas individuales (PDF) para detectar encabezados/pies repetidos. */
  pages?: string[];
}

/**
 * Normaliza el texto extraido: une palabras cortadas con guion, elimina
 * controles, encabezados/pies repetidos, numeros de pagina y lineas basura.
 */
export function cleanExtractedText(
  raw: string,
  options: CleanTextOptions = {},
): string {
  if (raw.length === 0) return '';

  let text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');

  // Une palabras cortadas al final de linea: "docu-\nmento" -> "documento".
  text = text.replace(/(\p{L})-\n\s*(\p{L})/gu, '$1$2');

  const repeated = collectRepeatedEdgeLines(options.pages ?? []);
  const kept: string[] = [];
  for (const line of text.split('\n').map(normalizeLine)) {
    if (line.length === 0) {
      if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    if (repeated.has(line)) continue;
    if (isJunkLine(line)) continue;
    kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------------ */
/* Segmentacion de oraciones                                           */
/* ------------------------------------------------------------------ */

const ABBREVIATIONS = [
  'dr', 'dra', 'sr', 'sra', 'sres', 'etc', 'art', 'arts', 'vs', 'inc', 'ltd',
  'no', 'núm', 'num', 'fig', 'figs', 'pág', 'pag', 'págs', 'cap', 'sec',
  'aprox', 'ej', 'p.ej', 'ee.uu', 'eeuu', 'tel', 'fax', 'dept', 'univ', 'av',
  'avda', 'ud', 'uds', 'dpto',
];

const ABBREVIATION_REGEX = new RegExp(
  `\\b(${ABBREVIATIONS.map(escapeRegExp).join('|')})\\.`,
  'gi',
);

/** Divide una oracion demasiado larga por ';' o ',' sin cortar palabras. */
function splitLongSentence(sentence: string, max = 300): string[] {
  if (sentence.length <= max) return [sentence];

  const semicolon = sentence.split(/;\s*/).filter((part) => part.trim().length > 0);
  if (semicolon.length > 1) return semicolon;

  const comma = sentence.split(/,\s*/).filter((part) => part.trim().length > 0);
  if (comma.length > 1) {
    const chunks: string[] = [];
    let current = '';
    for (const part of comma) {
      if (current.length === 0) {
        current = part;
      } else if (current.length + part.length + 2 > max) {
        chunks.push(current);
        current = part;
      } else {
        current = `${current}, ${part}`;
      }
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  return [sentence];
}

/**
 * Segmenta el texto en oraciones. Protege abreviaturas, decimales, iniciales
 * y URLs, y usa vinetas/saltos como fronteras.
 */
export function splitSentences(value: string): string[] {
  let text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return [];

  // Centinelas para los puntos que NO cierran una oracion.
  text = text.replace(/(\d)\.(\d)/g, '$1\u0000$2');
  text = text.replace(ABBREVIATION_REGEX, '$1\u0000');
  text = text.replace(/\b(\p{Lu})\.(?=\s|\p{Lu})/gu, '$1\u0000');
  text = text.replace(/\b(?:https?:\/\/|www\.)[^\s]+/gi, (match) =>
    match.replace(/\./g, '\u0000'),
  );

  // Vinetas y fronteras de parrafo cuentan como final de oracion.
  text = text.replace(/(?:^|\s)[•·▪◦*\-–—]\s+/g, ' \u0001 ');
  text = text.replace(/([.!?…]+)(\s+|$)/g, '$1\u0001');

  const parts = text
    .split('\u0001')
    .map((part) => part.replace(/\u0000/g, '.').replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0);

  const sentences: string[] = [];
  for (const part of parts) {
    for (const piece of splitLongSentence(part)) {
      const clean = piece.trim();
      if (clean.length === 0) continue;
      // Descarta fragmentos demasiado cortos para aportar significado.
      if (textWords(clean).length < 2 && clean.length < 12) continue;
      sentences.push(clean);
    }
  }
  return sentences;
}

/* ------------------------------------------------------------------ */
/* Resumen extractivo                                                  */
/* ------------------------------------------------------------------ */

export interface SummarizeOptions {
  maxChars?: number;
  maxSentences?: number;
  minSentences?: number;
}

const DEFAULT_MAX_CHARS = 600;
const DEFAULT_MAX_SENTENCES = 5;
const DEFAULT_MIN_SENTENCES = 3;

/** Penaliza oraciones que probablemente son encabezados, URLs o tablas. */
function sentencePenalty(sentence: string): number {
  let penalty = 1;

  const letters = sentence.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 6 && letters === letters.toUpperCase()) penalty *= 0.6;

  if (/https?:\/\/|www\./i.test(sentence)) penalty *= 0.5;

  const digits = (sentence.match(/\d/g) ?? []).length;
  if (digits / Math.max(sentence.length, 1) > 0.25) penalty *= 0.7;

  if (/^\s*(figura|tabla|table|figure|anexo|índice|indice)\b/i.test(sentence)) {
    penalty *= 0.5;
  }

  return penalty;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const word of left) {
    if (right.has(word)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Recorta en un limite de palabra y agrega "…" (nunca corta a media palabra). */
export function truncateAtWord(value: string, max: number): string {
  if (value.length <= max) return value;
  const slice = value.slice(0, Math.max(0, max - 1));
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace >= Math.floor(max * 0.6) ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * Resumen extractivo. Devuelve el texto completo cuando es corto; en caso
 * contrario elige entre 3 y 5 oraciones relevantes y no redundantes, en orden
 * original, sin superar `maxChars` y sin cortar oraciones a la mitad.
 */
export function summarizeText(
  value: string,
  options: SummarizeOptions = {},
): string | undefined {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxSentences = options.maxSentences ?? DEFAULT_MAX_SENTENCES;
  const minSentences = options.minSentences ?? DEFAULT_MIN_SENTENCES;

  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return undefined;
  if (clean.length <= maxChars) return clean;

  const sentences = splitSentences(clean);
  if (sentences.length <= 2) return truncateAtWord(clean, maxChars);

  const frequency = new Map<string, number>();
  for (const word of textWords(clean)) {
    const normalized = normalizeWord(word);
    if (normalized.length < 3 || STOPWORDS.has(normalized)) continue;
    frequency.set(normalized, (frequency.get(normalized) ?? 0) + 1);
  }

  const scored = sentences.map((sentence, index) => {
    const words = textWords(sentence)
      .map(normalizeWord)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
    const unique = new Set(words);
    let weight = 0;
    for (const word of unique) weight += frequency.get(word) ?? 0;
    const density = words.length > 0 ? weight / Math.sqrt(words.length) : 0;
    const positionBonus =
      index === 0 ? 1.25 : index < 3 ? 1.15 : index < 8 ? 1.06 : 1;
    return {
      sentence,
      index,
      words: unique,
      score: density * positionBonus * sentencePenalty(sentence),
    };
  });

  // Seleccion tipo MMR: premia relevancia y descarta ideas ya cubiertas.
  const selected: typeof scored = [];
  const remaining = scored.slice();
  while (remaining.length > 0 && selected.length < maxSentences) {
    let best: (typeof scored)[number] | undefined;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (const candidate of remaining) {
      let redundancy = 0;
      for (const chosen of selected) {
        redundancy = Math.max(redundancy, jaccard(candidate.words, chosen.words));
      }
      // Descarta practicamente duplicadas de algo ya elegido.
      if (redundancy >= 0.85) continue;
      const value = candidate.score * (1 - 0.7 * redundancy);
      if (value > bestValue) {
        bestValue = value;
        best = candidate;
      }
    }
    if (best === undefined) break;
    selected.push(best);
    remaining.splice(remaining.indexOf(best), 1);
  }

  let ordered = selected.slice().sort((left, right) => left.index - right.index);
  let joined = ordered.map((candidate) => candidate.sentence).join(' ');

  // Si excede el limite, quita las oraciones finales; nunca corta una oracion.
  while (joined.length > maxChars && ordered.length > 1) {
    ordered = ordered.slice(0, -1);
    joined = ordered.map((candidate) => candidate.sentence).join(' ');
  }

  if (ordered.length < minSentences && sentences.length > ordered.length) {
    // Intenta completar el minimo con las mejores oraciones descartadas,
    // evitando reintroducir ideas ya cubiertas.
    const used = new Set(ordered.map((candidate) => candidate.index));
    const extras = scored
      .filter((candidate) => !used.has(candidate.index))
      .filter((candidate) => {
        let redundancy = 0;
        for (const chosen of ordered) {
          redundancy = Math.max(redundancy, jaccard(candidate.words, chosen.words));
        }
        return redundancy < 0.8;
      })
      .sort((left, right) => right.score - left.score);
    for (const extra of extras) {
      if (ordered.length >= minSentences) break;
      const candidateText = [...ordered, extra]
        .sort((left, right) => left.index - right.index)
        .map((candidate) => candidate.sentence)
        .join(' ');
      if (candidateText.length <= maxChars) {
        ordered.push(extra);
        joined = candidateText;
      }
    }
  }

  return joined.length > maxChars ? truncateAtWord(joined, maxChars) : joined;
}

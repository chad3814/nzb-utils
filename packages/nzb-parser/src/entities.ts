import { NzbParseError } from './errors.ts';

const NAMED: ReadonlyMap<string, string> = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

/**
 * Expand XML entity references.
 *
 * Only the five predefined entities plus numeric character references are
 * recognized. NZBs come from untrusted indexers, so an unknown entity is an
 * error rather than something to pass through or guess at — and there is no
 * DTD-defined entity table to consult, which is also what keeps this immune to
 * entity-expansion attacks.
 *
 * @param offset Offset of `text` within the original document, so errors point
 *   at the real position rather than at an index into a fragment.
 */
export function decodeEntities(text: string, offset: number): string {
  if (!text.includes('&')) {
    return text;
  }

  let out = '';
  let index = 0;

  for (;;) {
    const start = text.indexOf('&', index);
    if (start < 0) {
      return out + text.slice(index);
    }

    out += text.slice(index, start);

    const end = text.indexOf(';', start);
    if (end < 0) {
      throw new NzbParseError('unterminated entity reference', offset + start);
    }

    const body = text.slice(start + 1, end);
    out += expand(body, offset + start);
    index = end + 1;
  }
}

function expand(body: string, offset: number): string {
  const named = NAMED.get(body);
  if (named !== undefined) {
    return named;
  }

  const code = characterReferenceValue(body);
  if (code !== null && code >= 0 && code <= 0x10ffff) {
    return String.fromCodePoint(code);
  }

  throw new NzbParseError(`unrecognized entity reference "&${body};"`, offset);
}

/** Value of a numeric character reference body (`#123` or `#x1f`), else null. */
function characterReferenceValue(body: string): number | null {
  if (body.startsWith('#x') || body.startsWith('#X')) {
    const digits = body.slice(2);
    return /^[0-9a-fA-F]+$/u.test(digits) ? Number.parseInt(digits, 16) : null;
  }

  if (body.startsWith('#')) {
    const digits = body.slice(1);
    return /^[0-9]+$/u.test(digits) ? Number(digits) : null;
  }

  return null;
}

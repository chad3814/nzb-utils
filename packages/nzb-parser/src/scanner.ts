import { decodeEntities } from './entities.ts';
import { NzbParseError } from './errors.ts';

/**
 * A minimal, allocation-conscious XML scanner covering the NZB 1.1 subset.
 *
 * Deliberately not a general XML parser. It understands exactly the constructs
 * that appear in NZB documents in the wild, and rejects everything else rather
 * than guessing — an NZB arrives from an untrusted indexer, and the failure mode
 * of a permissive parser is silently fetching the wrong articles.
 *
 * Not supported, on purpose: DTD internal subsets, entity declarations,
 * processing instructions with meaningful content, and namespace *semantics*
 * (prefixes are stripped, not resolved).
 */

export interface XmlStartTag {
  readonly kind: 'start';
  /** Local name with any namespace prefix stripped. */
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly selfClosing: boolean;
  readonly offset: number;
}

export interface XmlEndTag {
  readonly kind: 'end';
  readonly name: string;
  readonly offset: number;
}

export interface XmlText {
  readonly kind: 'text';
  /** Entity-decoded character data. */
  readonly value: string;
  readonly offset: number;
}

export type XmlEvent = XmlStartTag | XmlEndTag | XmlText;

const NAME_START = /[A-Za-z_:]/u;
const NAME_CHAR = /[-A-Za-z0-9._:]/u;
const WHITESPACE = /[\t\n\r ]/u;

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

/** One step of the scanner: an event to emit (or nothing) and where to resume. */
interface Step {
  readonly event: XmlEvent | null;
  readonly end: number;
}

export function* scanXml(source: string): Generator<XmlEvent, void, undefined> {
  let index = 0;

  while (index < source.length) {
    const next = source.indexOf('<', index);

    if (next < 0) {
      yield { kind: 'text', value: decodeEntities(source.slice(index), index), offset: index };
      return;
    }

    if (next > index) {
      yield {
        kind: 'text',
        value: decodeEntities(source.slice(index, next), index),
        offset: index,
      };
    }

    const step = readMarkup(source, next);
    if (step.event !== null) {
      yield step.event;
    }
    index = step.end;
  }
}

function readMarkup(source: string, from: number): Step {
  if (source.startsWith('<?', from)) {
    return { event: null, end: skipTo(source, from, '?>', 'unterminated processing instruction') };
  }

  if (source.startsWith('<!--', from)) {
    return { event: null, end: skipTo(source, from, '-->', 'unterminated comment') };
  }

  if (source.startsWith(CDATA_OPEN, from)) {
    const start = from + CDATA_OPEN.length;
    const end = source.indexOf(CDATA_CLOSE, start);
    if (end < 0) {
      throw new NzbParseError('unterminated CDATA section', from);
    }
    // CDATA is literal: entities inside it are data, not references.
    return {
      event: { kind: 'text', value: source.slice(start, end), offset: start },
      end: end + CDATA_CLOSE.length,
    };
  }

  if (source.startsWith('<!', from)) {
    return { event: null, end: skipDeclaration(source, from) };
  }

  return source.startsWith('</', from) ? readEndTag(source, from) : readStartTag(source, from);
}

function skipTo(source: string, from: number, terminator: string, message: string): number {
  const end = source.indexOf(terminator, from);
  if (end < 0) {
    throw new NzbParseError(message, from);
  }
  return end + terminator.length;
}

/**
 * Skip a `<!DOCTYPE ...>` declaration, including any internal subset.
 *
 * The subset is skipped rather than interpreted: honouring `<!ENTITY>`
 * declarations from an untrusted document is how billion-laughs and XXE work.
 * {@link decodeEntities} therefore only ever sees the five predefined entities.
 */
function skipDeclaration(source: string, from: number): number {
  let index = from + 2;

  while (index < source.length) {
    const char = source[index];

    if (char === '"' || char === "'") {
      const close = source.indexOf(char, index + 1);
      if (close < 0) {
        throw new NzbParseError('unterminated string in declaration', index);
      }
      index = close + 1;
      continue;
    }

    if (char === '[') {
      const close = source.indexOf(']', index + 1);
      if (close < 0) {
        throw new NzbParseError('unterminated internal subset in declaration', index);
      }
      index = close + 1;
      continue;
    }

    if (char === '>') {
      return index + 1;
    }

    index += 1;
  }

  throw new NzbParseError('unterminated declaration', from);
}

function readName(source: string, from: number): { name: string; end: number } {
  const first = source[from];
  if (first === undefined || !NAME_START.test(first)) {
    throw new NzbParseError('expected an element name', from);
  }

  let end = from + 1;
  while (end < source.length) {
    const char = source[end];
    if (char === undefined || !NAME_CHAR.test(char)) {
      break;
    }
    end += 1;
  }

  // Strip the namespace prefix: NZB documents are single-namespace, so a
  // prefixed `<nzb:file>` and a default-namespaced `<file>` mean the same thing.
  const raw = source.slice(from, end);
  const colon = raw.lastIndexOf(':');
  return { name: colon < 0 ? raw : raw.slice(colon + 1), end };
}

function skipWhitespace(source: string, from: number): number {
  let index = from;
  while (index < source.length) {
    const char = source[index];
    if (char === undefined || !WHITESPACE.test(char)) {
      break;
    }
    index += 1;
  }
  return index;
}

function readEndTag(source: string, from: number): { event: XmlEndTag; end: number } {
  const { name, end } = readName(source, from + 2);
  const close = skipWhitespace(source, end);
  if (source[close] !== '>') {
    throw new NzbParseError(`malformed closing tag for "${name}"`, from);
  }
  return { event: { kind: 'end', name, offset: from }, end: close + 1 };
}

function readStartTag(source: string, from: number): { event: XmlStartTag; end: number } {
  const { name, end } = readName(source, from + 1);
  const attributes = new Map<string, string>();
  let index = end;

  for (;;) {
    index = skipWhitespace(source, index);
    const char = source[index];

    if (char === undefined) {
      throw new NzbParseError(`unterminated tag "${name}"`, from);
    }

    if (char === '>') {
      return {
        event: { kind: 'start', name, attributes, selfClosing: false, offset: from },
        end: index + 1,
      };
    }

    if (char === '/') {
      if (source[index + 1] !== '>') {
        throw new NzbParseError(`malformed self-closing tag "${name}"`, from);
      }
      return {
        event: { kind: 'start', name, attributes, selfClosing: true, offset: from },
        end: index + 2,
      };
    }

    const attribute = readAttribute(source, index, name);
    // Duplicate attributes are ill-formed XML; last-one-wins would let a crafted
    // document hide a second `date` or `bytes` from a reader that shows the first.
    if (attributes.has(attribute.name)) {
      throw new NzbParseError(`duplicate attribute "${attribute.name}" on "${name}"`, index);
    }
    attributes.set(attribute.name, attribute.value);
    index = attribute.end;
  }
}

function readAttribute(
  source: string,
  from: number,
  element: string,
): { name: string; value: string; end: number } {
  const { name, end } = readName(source, from);
  const equals = skipWhitespace(source, end);
  if (source[equals] !== '=') {
    throw new NzbParseError(`attribute "${name}" on "${element}" has no value`, from);
  }

  const quoteAt = skipWhitespace(source, equals + 1);
  const quote = source[quoteAt];
  if (quote !== '"' && quote !== "'") {
    throw new NzbParseError(`attribute "${name}" on "${element}" is not quoted`, quoteAt);
  }

  const valueStart = quoteAt + 1;
  const valueEnd = source.indexOf(quote, valueStart);
  if (valueEnd < 0) {
    throw new NzbParseError(`unterminated value for attribute "${name}"`, quoteAt);
  }

  return {
    name,
    value: decodeEntities(source.slice(valueStart, valueEnd), valueStart),
    end: valueEnd + 1,
  };
}

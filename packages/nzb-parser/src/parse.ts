import { NzbParseError } from './errors.ts';
import type { Nzb, NzbFile, NzbMeta, NzbSegment } from './models.ts';
import { scanXml } from './scanner.ts';
import type { XmlEvent, XmlStartTag } from './scanner.ts';
import { parseSubject } from './subject.ts';

/** Elements whose character data is meaningful. Text anywhere else is ignored. */
const TEXT_ELEMENTS: ReadonlySet<string> = new Set(['meta', 'group', 'segment']);

interface FileAccumulator {
  readonly poster: string;
  readonly date: Date;
  readonly subject: string;
  readonly groups: string[];
  readonly segments: NzbSegment[];
}

interface SegmentAccumulator {
  readonly number: number;
  readonly bytes: number;
  readonly offset: number;
}

interface ParserState {
  readonly meta: NzbMeta[];
  readonly files: NzbFile[];
  readonly stack: string[];
  sawRoot: boolean;
  file: FileAccumulator | null;
  segment: SegmentAccumulator | null;
  metaType: string | null;
  text: string;
}

export function parseNzb(xml: string): Nzb {
  const state: ParserState = {
    meta: [],
    files: [],
    stack: [],
    sawRoot: false,
    file: null,
    segment: null,
    metaType: null,
    text: '',
  };

  for (const event of scanXml(xml)) {
    consume(state, event);
  }

  const unclosed = state.stack.at(-1);
  if (unclosed !== undefined) {
    throw new NzbParseError(`unclosed <${unclosed}> element`, xml.length);
  }
  if (!state.sawRoot) {
    throw new NzbParseError('no <nzb> root element', 0);
  }

  return { meta: state.meta, files: state.files, groups: unionGroups(state.files) };
}

function consume(state: ParserState, event: XmlEvent): void {
  switch (event.kind) {
    case 'text': {
      const parent = state.stack.at(-1);
      if (parent !== undefined && TEXT_ELEMENTS.has(parent)) {
        state.text += event.value;
      }
      return;
    }

    case 'start': {
      openElement(state, event);
      state.text = '';
      if (event.selfClosing) {
        closeElement(state, event.name, event.offset);
      } else {
        state.stack.push(event.name);
      }
      return;
    }

    case 'end': {
      const open = state.stack.pop();
      if (open !== event.name) {
        throw new NzbParseError(
          open === undefined
            ? `unexpected closing tag </${event.name}>`
            : `closing tag </${event.name}> does not match <${open}>`,
          event.offset,
        );
      }
      closeElement(state, event.name, event.offset);
      state.text = '';
    }
  }
}

function openElement(state: ParserState, tag: XmlStartTag): void {
  switch (tag.name) {
    case 'nzb':
      if (state.stack.length > 0) {
        throw new NzbParseError('nested <nzb> element', tag.offset);
      }
      state.sawRoot = true;
      break;

    case 'file':
      state.file = {
        poster: requiredAttribute(tag, 'poster'),
        date: new Date(requiredInteger(tag, 'date') * 1000),
        subject: requiredAttribute(tag, 'subject'),
        groups: [],
        segments: [],
      };
      break;

    case 'meta':
      state.metaType = requiredAttribute(tag, 'type');
      break;

    case 'segment':
      state.segment = {
        number: requiredInteger(tag, 'number'),
        bytes: requiredInteger(tag, 'bytes'),
        offset: tag.offset,
      };
      break;

    default:
      break;
  }
}

function closeElement(state: ParserState, name: string, offset: number): void {
  switch (name) {
    case 'file':
      state.files.push(finalizeFile(requireOpenFile(state, offset)));
      state.file = null;
      break;

    case 'meta': {
      if (state.metaType === null) {
        throw new NzbParseError('</meta> without a matching <meta>', offset);
      }
      state.meta.push({ type: state.metaType, value: state.text.trim() });
      state.metaType = null;
      break;
    }

    case 'group': {
      const group = state.text.trim();
      if (group.length === 0) {
        throw new NzbParseError('<group> is empty', offset);
      }
      requireOpenFile(state, offset).groups.push(group);
      break;
    }

    case 'segment':
      closeSegment(state, offset);
      break;

    default:
      break;
  }
}

function closeSegment(state: ParserState, offset: number): void {
  const segment = state.segment;
  if (segment === null) {
    throw new NzbParseError('</segment> without a matching <segment>', offset);
  }

  const messageId = state.text.trim();
  if (messageId.length === 0) {
    throw new NzbParseError('<segment> has no Message-ID', segment.offset);
  }

  requireOpenFile(state, offset).segments.push({
    number: segment.number,
    bytes: segment.bytes,
    // NZBs store Message-IDs without angle brackets. Some posters include them
    // anyway; normalize so the transport can add exactly one pair.
    messageId: stripAngleBrackets(messageId),
  });
  state.segment = null;
}

function requireOpenFile(state: ParserState, offset: number): FileAccumulator {
  if (state.file === null) {
    throw new NzbParseError('element appears outside of a <file>', offset);
  }
  return state.file;
}

function finalizeFile(accumulator: FileAccumulator): NzbFile {
  const segments = accumulator.segments.toSorted((a, b) => a.number - b.number);

  let totalEncodedBytes = 0;
  let contiguous = true;
  for (const [index, entry] of segments.entries()) {
    totalEncodedBytes += entry.bytes;
    if (entry.number !== index + 1) {
      contiguous = false;
    }
  }

  return {
    poster: accumulator.poster,
    date: accumulator.date,
    subject: accumulator.subject,
    groups: accumulator.groups,
    segments,
    subjectHints: parseSubject(accumulator.subject),
    totalEncodedBytes,
    contiguous,
  };
}

function unionGroups(files: readonly NzbFile[]): readonly string[] {
  const seen = new Set<string>();
  for (const file of files) {
    for (const group of file.groups) {
      seen.add(group);
    }
  }
  return [...seen];
}

function stripAngleBrackets(messageId: string): string {
  return messageId.startsWith('<') && messageId.endsWith('>') ? messageId.slice(1, -1) : messageId;
}

function requiredAttribute(tag: XmlStartTag, name: string): string {
  const value = tag.attributes.get(name);
  if (value === undefined) {
    throw new NzbParseError(`<${tag.name}> is missing the "${name}" attribute`, tag.offset);
  }
  return value;
}

function requiredInteger(tag: XmlStartTag, name: string): number {
  const raw = requiredAttribute(tag, name).trim();
  if (!/^-?\d+$/u.test(raw)) {
    throw new NzbParseError(
      `<${tag.name}> attribute "${name}" is not an integer: "${raw}"`,
      tag.offset,
    );
  }
  return Number(raw);
}

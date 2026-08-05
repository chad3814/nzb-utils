/** Thrown for any input that is not a well-formed NZB 1.1 document. */
export class NzbParseError extends Error {
  /** Byte offset into the source string at which the problem was detected. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (at offset ${offset})`);
    this.name = 'NzbParseError';
    this.offset = offset;
  }
}

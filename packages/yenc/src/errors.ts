function hex(value: number): string {
  return value.toString(16).padStart(8, '0');
}

/** Thrown for input that is not decodable yEnc. */
export class YencDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YencDecodeError';
  }
}

/**
 * Thrown when a decoded article does not match the checksum in its own trailer.
 *
 * Separate from {@link YencDecodeError} because the two mean different things
 * operationally: a decode error is a malformed article, while a checksum
 * mismatch is a well-formed article that arrived corrupt and is worth retrying
 * from another provider.
 */
export class YencChecksumError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`CRC32 mismatch: trailer declares ${hex(expected)}, decoded data is ${hex(actual)}`);
    this.name = 'YencChecksumError';
    this.expected = expected;
    this.actual = actual;
  }
}

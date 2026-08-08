/**
 * Thrown when a byte stream cannot be read as a PAR2 set.
 *
 * Deliberately rare. A PAR2 file is a bag of independently checksummed packets
 * that may be duplicated, reordered or damaged, so almost everything malformed
 * is *skipped* rather than fatal — that tolerance is the format's whole point.
 * This is for the case where what survived does not describe a set at all.
 */
export class Par2ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Par2ParseError';
  }
}

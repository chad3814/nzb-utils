/**
 * Thrown when an NZB's articles cannot be laid out as a file, or when an
 * article turns out not to be where the geometry predicted it would be.
 *
 * This is the error that makes predict-then-verify safe. Segment offsets are
 * predicted from segment 1 because the overwhelming majority of posts are
 * uniformly segmented, but the prediction is checked against each article's own
 * `=ypart` header before any of its bytes are used. On a post where the
 * prediction is wrong, this is thrown instead of bytes from the wrong offsets
 * being returned as if they were right.
 */
export class NzbGeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NzbGeometryError';
  }
}

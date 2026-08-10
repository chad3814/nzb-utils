export { NzbGeometryError } from './errors.ts';
export { fetchArticle } from './fetch.ts';
export type { FetchArticleOptions } from './fetch.ts';
export { probeGeometry, verifyPlacement } from './geometry.ts';
export type { FileHeader, FileProbe, ProbeOptions } from './geometry.ts';
export { openNzbFile } from './handle.ts';
export type { OpenNzbFileOptions } from './handle.ts';
export { mimeTypeFor } from './mime.ts';
export { normalizeSlice, resolveRange } from './range.ts';
export type {
  ArticleBody,
  ArticleFetchOptions,
  ArticleSource,
  ByteRange,
  ByteSink,
  NzbFileHandle,
  ResolvedRange,
  ResolvedSegment,
  SegmentGeometry,
  SegmentSlice,
} from './models.ts';

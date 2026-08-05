/**
 * Filename-to-MIME mapping for `NzbFileHandle.type`.
 *
 * Deliberately small: this covers what Usenet posts actually contain, and an
 * unknown extension yields `''`, which is what `Blob` and `File` do rather than
 * guessing `application/octet-stream`. The type is a convenience for callers
 * handing a handle to something content-type-aware; nothing in this package
 * behaves differently because of it.
 */
const TYPES = new Map<string, string>([
  ['mkv', 'video/x-matroska'],
  ['mp4', 'video/mp4'],
  ['m4v', 'video/x-m4v'],
  ['avi', 'video/x-msvideo'],
  ['mov', 'video/quicktime'],
  ['webm', 'video/webm'],
  ['wmv', 'video/x-ms-wmv'],
  ['mp3', 'audio/mpeg'],
  ['m4a', 'audio/mp4'],
  ['flac', 'audio/flac'],
  ['ogg', 'audio/ogg'],
  ['opus', 'audio/opus'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['pdf', 'application/pdf'],
  ['epub', 'application/epub+zip'],
  ['zip', 'application/zip'],
  ['rar', 'application/vnd.rar'],
  ['7z', 'application/x-7z-compressed'],
  ['gz', 'application/gzip'],
  ['tar', 'application/x-tar'],
  ['iso', 'application/x-iso9660-image'],
  ['xml', 'application/xml'],
  ['json', 'application/json'],
  ['nzb', 'application/x-nzb'],
  ['par2', 'application/x-par2'],
  ['srt', 'application/x-subrip'],
  ['txt', 'text/plain'],
  ['sfv', 'text/plain'],
  // .nfo is a DOS-codepage art file, not UTF-8 text, and calling it text/plain
  // makes browsers render the box-drawing characters as mojibake.
  ['nfo', 'text/x-nfo'],
]);

export function mimeTypeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) {
    return '';
  }
  return TYPES.get(name.slice(dot + 1).toLowerCase()) ?? '';
}

import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

/**
 * Writing fetched bytes to disk, at the offset they belong at.
 *
 * Two layouts, and the difference matters more than it looks:
 *
 * - **Contiguous** (default): the requested range is written from offset 0, so
 *   the output is exactly the bytes asked for and nothing else.
 * - **Sparse**: the file is created at the declared full length and each range
 *   is written where it actually belongs. The unwritten middle is a hole.
 *
 * Sparse is what makes a head+tail preview usable. An MP4's `moov` atom sits at
 * the front on a faststart encode and at the back on most CLI remuxes, and an
 * NZB cannot say which. Fetching segment 1 and segment 1868 into a sparse file
 * lets ffmpeg find `moov` wherever it is, seek back to zero, and decode —
 * layout-agnostic, for 0.1% of the bytes.
 *
 * Whether the hole costs disk is the filesystem's decision, not ours. APFS,
 * ext4, XFS and btrfs all leave it unallocated; this asks by extending the file
 * without writing to it, which is the portable way to ask.
 */
export interface Sink {
  /** Write a chunk that belongs at `offset` within the complete file. */
  write(offset: number, chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface SinkOptions {
  /** Lay the file out at its true full length, leaving unwritten regions as holes. */
  readonly sparse: boolean;
  /** Decoded length of the complete file, used as the sparse file's length. */
  readonly declaredSize: number;
  /** Absolute offset the requested range begins at. Subtracted when not sparse. */
  readonly rangeStart: number;
}

export async function openSink(path: string, options: SinkOptions): Promise<Sink> {
  await mkdir(dirname(path), { recursive: true });

  // 'w' rather than 'r+': a rerun should not leave stale bytes from a previous,
  // longer fetch sitting in the gaps of this one.
  const handle: FileHandle = await open(path, 'w');

  if (options.sparse) {
    // Extending without writing is what creates the hole. Do it up front so the
    // file has its true length even if only the first chunk ever arrives.
    await handle.truncate(options.declaredSize);
  }

  const shift = options.sparse ? 0 : options.rangeStart;

  return {
    write: async (offset: number, chunk: Uint8Array): Promise<void> => {
      await handle.write(chunk, 0, chunk.byteLength, offset - shift);
    },
    close: async (): Promise<void> => {
      await handle.close();
    },
  };
}

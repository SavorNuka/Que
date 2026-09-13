import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

/**
 * Quick hash for move detection (ARCHITECTURE §7).
 *
 * Hashing a 40 GB remux to notice it moved folders would make a rescan cost
 * more than the library is worth. Instead: file size plus the first and last
 * 64 KB. Two distinct media files sharing an exact size AND both ends is not a
 * realistic collision — and the consequence of one would be a mis-linked
 * history entry, not data loss.
 *
 * This is deliberately NOT a content identity: re-encoding a file changes it,
 * which is correct, because a re-encode is a different file.
 */

const CHUNK = 64 * 1024;

export async function quickHash(path: string, sizeBytes: number): Promise<string> {
  const hash = createHash('sha256');
  hash.update(String(sizeBytes));

  const handle = await open(path, 'r');
  try {
    const head = Buffer.allocUnsafe(Math.min(CHUNK, sizeBytes));
    const { bytesRead: headRead } = await handle.read(head, 0, head.length, 0);
    hash.update(head.subarray(0, headRead));

    // Only read a tail when the file is big enough for it not to overlap.
    if (sizeBytes > CHUNK * 2) {
      const tail = Buffer.allocUnsafe(CHUNK);
      const { bytesRead: tailRead } = await handle.read(tail, 0, CHUNK, sizeBytes - CHUNK);
      hash.update(tail.subarray(0, tailRead));
    }
  } finally {
    await handle.close();
  }

  return hash.digest('hex');
}

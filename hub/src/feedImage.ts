import { join } from 'node:path'

/**
 * Decompression-bomb guard (image-feed behavior). A low-RAM display device decoding a
 * modest-looking file at absurd pixel dimensions can OOM — so the hub caps both bytes on the
 * wire (checked by the route's content-type-parser bodyLimit) and PARSED HEADER dimensions
 * (checked here, against the actual pixel grid the decoder will allocate — never file size
 * alone, which a crafted file can misrepresent).
 *
 * ACCEPTED RISK, stated plainly (documentation only, no behavior
 * change): this dimension cap is ADVISORY. Every width/height below is read out of the file's own
 * declared header, and a crafted file can declare a small header while its compressed stream
 * decodes to something much larger — the sniffers deliberately do not decode pixels (that would
 * make the hub the bomb's first victim). The REAL decompression-bomb guard is on the device: the
 * two-pass `inJustDecodeBounds` / `sampleSize` decode (the retired Android `sampleSize` +
 * net/ImageFetcher), which measures the TRUE dimensions before allocating anything and downsamples
 * to the cell. This cap's job is to reject the overwhelmingly common honest-but-huge upload early
 * and with a clear error, not to be a security boundary against a hostile sender.
 */
export const MAX_IMAGE_BYTES = 524_288
export const MAX_IMAGE_DIM = 2048

export interface ImageInfo {
  format: 'png' | 'jpeg' | 'webp'
  width: number
  height: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** IHDR is always the first chunk right after the signature; width/height are BE u32 at 16/20. */
function sniffPng(buf: Buffer): ImageInfo | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * Walks JPEG marker segments looking for SOF0/1/2 (baseline/extended-sequential/progressive) —
 * the only markers whose payload carries the frame's pixel dimensions. Markers without a
 * length-prefixed payload (SOI/EOI/TEM/RSTn) are skipped by their 2-byte marker alone; every
 * other segment is skipped by its declared length so the scan can reach SOF even past APPn/COM/
 * quantization-table segments.
 */
function sniffJpeg(buf: Buffer): ImageInfo | null {
  let i = 2 // past the SOI we already matched in sniffImage
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (i + 4 > buf.length) return null
    const segLen = buf.readUInt16BE(i + 2)
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (i + 9 > buf.length) return null
      return { format: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + segLen
  }
  return null
}

/**
 * WebP is a RIFF container; the first sub-chunk fourCC decides the layout. VP8X (extended
 * format) carries 24-bit LE canvas dims (stored minus one) plus the animation flag — animated
 * WebP is rejected outright (image-feed behavior renderer compatibility contract: the two renderers never animate
 * and must never disagree). Simple lossy 'VP8 ' packs 14-bit dims LE right after its frame tag
 * and start code; lossless 'VP8L' packs both dims into one LE u32 after its signature byte.
 */
function sniffWebp(buf: Buffer): ImageInfo | null {
  if (buf.length < 20) return null
  const fourCc = buf.toString('ascii', 12, 16)
  if (fourCc === 'VP8X') {
    if (buf.length < 30) return null
    const animated = (buf[20] & 0x02) !== 0
    if (animated) return null
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
    return { format: 'webp', width, height }
  }
  if (fourCc === 'VP8 ') {
    if (buf.length < 30) return null
    return { format: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (fourCc === 'VP8L') {
    if (buf.length < 25) return null
    const bits = buf.readUInt32LE(21)
    return { format: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
  }
  return null
}

/**
 * Magic bytes decide the format — the content-type header is never trusted (a sender can lie
 * about it; the route layer compares this result against the declared header and 415s on
 * mismatch). Truncated/malformed/unrecognized input and animated WebP all return null; anything
 * over MAX_IMAGE_DIM is NOT null here — dims are still returned so the caller can 400 with a
 * specific "too big" message rather than the generic "bad image" one. A zero (or, were it
 * reachable through these unsigned reads, negative) width/height is the opposite problem — not
 * "too big" but not a decodable image at all — so it's folded into the same null/415 bucket as
 * truncated or garbage input, not the 400 "over-dimension" path.
 */
export function sniffImage(buf: Buffer): ImageInfo | null {
  try {
    if (buf.length < 4) return null
    let info: ImageInfo | null = null
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) info = sniffPng(buf)
    else if (buf[0] === 0xff && buf[1] === 0xd8) info = sniffJpeg(buf)
    else if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
      info = sniffWebp(buf)
    if (!info || info.width <= 0 || info.height <= 0) return null
    return info
  } catch {
    return null
  }
}

/**
 * Single current-version path per feed (storage) — no revision in the filename; the route
 * layer overwrites it atomically (tmp + rename) on every push and bumps feeds.image_rev in the
 * DB instead. This module stays fs-free; reads/writes belong to the route layer.
 */
export function imagePath(dataDir: string, feedId: string): string {
  return join(dataDir, 'feeds', feedId)
}

/**
 * Theme background storage (theming: background image). Deliberately a SIBLING of imagePath, not
 * a reuse of it — feeds and themes mint ids from separate namespaces (`feed_...` vs `thm_...`),
 * but nothing stops an operator or a future bug from colliding on the bare id string, so each gets
 * its own directory rather than sharing `feeds/`. Same single-current-version-per-id convention:
 * no revision in the filename, the route layer overwrites atomically and bumps themes.bg_rev.
 */
export function themeBgPath(dataDir: string, themeId: string): string {
  return join(dataDir, 'themes', themeId)
}

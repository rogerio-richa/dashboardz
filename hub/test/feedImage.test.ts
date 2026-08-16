import { describe, expect, it } from 'vitest'
import { sniffImage, imagePath, MAX_IMAGE_BYTES, MAX_IMAGE_DIM } from '../src/feedImage.js'

/**
 * Fixtures are hand-built minimal buffers (hex literals), not committed binary files. They cover
 * image-feed renderer compatibility. Byte offsets below are exactly what sniffImage documents:
 * PNG IHDR dims at 16/20 BE u32; JPEG SOF0 dims at marker+5/+7 BE u16; WebP VP8X 24-bit LE dims
 * (+1 each) at 24/27 with the animation bit at byte 20 bit 1.
 */

// 8-byte signature, 4-byte chunk length (13), 'IHDR', width=100 (BE u32), height=50 (BE u32)
const validPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x64, // width = 100
  0x00, 0x00, 0x00, 0x32, // height = 50
])

// SOI, SOF0 marker, segment length (11, unvalidated), precision, height=50, width=100
const validJpeg = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0,
  0x00, 0x0b,
  0x08,
  0x00, 0x32, // height = 50
  0x00, 0x64, // width = 100
])

// RIFF/WEBP container, VP8X chunk, flags byte (bit1 = animation), width-1=99, height-1=49
function webpVp8x(animated: boolean): Buffer {
  return Buffer.from([
    0x52, 0x49, 0x46, 0x46, // 'RIFF'
    0x16, 0x00, 0x00, 0x00, // RIFF size (unvalidated)
    0x57, 0x45, 0x42, 0x50, // 'WEBP'
    0x56, 0x50, 0x38, 0x58, // 'VP8X'
    0x0a, 0x00, 0x00, 0x00, // chunk size = 10
    animated ? 0x02 : 0x00, // flags: animation bit
    0x00, 0x00, 0x00, // reserved
    0x63, 0x00, 0x00, // width - 1 = 99  -> width 100
    0x31, 0x00, 0x00, // height - 1 = 49 -> height 50
  ])
}

describe('sniffImage', () => {
  it('parses a valid PNG (magic + IHDR dims)', () => {
    expect(sniffImage(validPng)).toEqual({ format: 'png', width: 100, height: 50 })
  })

  it('parses a valid JPEG (SOI + SOF0 dims)', () => {
    expect(sniffImage(validJpeg)).toEqual({ format: 'jpeg', width: 100, height: 50 })
  })

  it('parses a static WebP (VP8X, animation bit clear)', () => {
    expect(sniffImage(webpVp8x(false))).toEqual({ format: 'webp', width: 100, height: 50 })
  })

  it('rejects an animated WebP (VP8X animation bit set)', () => {
    expect(sniffImage(webpVp8x(true))).toBeNull()
  })

  it('rejects a truncated PNG (signature only, no IHDR)', () => {
    expect(sniffImage(validPng.subarray(0, 10))).toBeNull()
  })

  it('does not cap dimensions itself — the caller decides over-MAX_IMAGE_DIM handling', () => {
    const oversized = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x10, 0x00, // width = 4096
      0x00, 0x00, 0x00, 0x64, // height = 100
    ])
    expect(sniffImage(oversized)).toEqual({ format: 'png', width: 4096, height: 100 })
  })

  it('rejects a zero-width PNG as malformed, not as "over MAX_IMAGE_DIM"', () => {
    const zeroWidth = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x00, // width = 0
      0x00, 0x00, 0x00, 0x32, // height = 50
    ])
    expect(sniffImage(zeroWidth)).toBeNull()
  })

  it('rejects a zero-height JPEG as malformed', () => {
    const zeroHeight = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0,
      0x00, 0x0b,
      0x08,
      0x00, 0x00, // height = 0
      0x00, 0x64, // width = 100
    ])
    expect(sniffImage(zeroHeight)).toBeNull()
  })

  it('rejects garbage bytes with no recognizable magic', () => {
    expect(sniffImage(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]))).toBeNull()
  })

  it('rejects an empty buffer', () => {
    expect(sniffImage(Buffer.alloc(0))).toBeNull()
  })
})

describe('imagePath', () => {
  it('is <dataDir>/feeds/<feedId>, single current file (no rev in the path)', () => {
    expect(imagePath('/data', 'feed_abc123')).toBe('/data/feeds/feed_abc123')
  })
})

describe('caps', () => {
  it('MAX_IMAGE_BYTES is 512 KB and MAX_IMAGE_DIM is 2048', () => {
    expect(MAX_IMAGE_BYTES).toBe(524_288)
    expect(MAX_IMAGE_DIM).toBe(2048)
  })
})

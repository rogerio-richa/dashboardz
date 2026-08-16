/**
 * Why a push to a feed was refused, as a fixed code.
 *
 * The code is what the hub stores on the feed row (`feeds.rejected_reason`, v28) and what the
 * admin shows next to the feed; the push route turns it into the `{"error": "..."}` text the
 * sender reads. Storing a code rather than the message keeps client-controlled text out of the
 * database and lets the wording improve without a migration.
 *
 * Only rejections from an authenticated sender to an existing feed get a code: a bad token (401)
 * is already in the audit log, and an unknown feed (404) has no row to record it on.
 */
export type RejectReason =
  | 'empty_body'
  | 'invalid_json'
  | 'too_large'
  | 'unsupported_media_type'
  | 'wrong_mode'
  | 'bad_image'
  | 'image_too_large'
  | 'not_allowed'

export const REJECT_REASONS: readonly RejectReason[] = [
  'empty_body', 'invalid_json', 'too_large', 'unsupported_media_type', 'wrong_mode', 'bad_image',
  'image_too_large', 'not_allowed',
]

/** A short label for the admin. Kept next to the codes so the two cannot drift apart. */
export const REJECT_LABELS: Readonly<Record<RejectReason, string>> = {
  empty_body: 'No body',
  invalid_json: 'Not valid JSON',
  too_large: 'Too large',
  unsupported_media_type: 'Wrong content type',
  wrong_mode: 'Wrong kind of data for this feed',
  bad_image: 'Not a PNG, JPEG or static WebP',
  image_too_large: 'Image dimensions too large',
  not_allowed: 'Sender not allowed',
}

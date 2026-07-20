import { base64Decode, base64Encode } from "@novaclaw/core/util/encode"

/**
 * Decode a base64 route slug (directory or server-URL). Returns undefined unless the slug
 * ROUND-TRIPS through our own encoder: a bare word like "search" is valid base64 ALPHABET
 * decoding to garbage bytes, and raw-decoding it here used to fan doomed fetches (and, pre
 * server-guard, real instance boots) out of every params.dir consumer. Directory consumers
 * that need an absolute-path guarantee use decodeDirectory (directory-layout), which adds
 * the path-shape check on top — NOT here: server-URL slugs (`/server/<b64>` routes) are
 * legitimate non-path payloads of this util.
 */
export function decode64(value: string | undefined) {
  if (value === undefined) return
  try {
    const decoded = base64Decode(value)
    if (base64Encode(decoded) !== value) return
    return decoded
  } catch {
    return
  }
}

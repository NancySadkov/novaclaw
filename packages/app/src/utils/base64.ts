import { base64Decode, base64Encode } from "@novaclaw/core/util/encode"

/**
 * Decode a DIRECTORY route slug (every consumer of this util decodes directory slugs from
 * route params / hrefs). Returns undefined unless the slug round-trips through our own
 * encoder AND decodes to an absolute path shape: a bare word like "search" is valid base64
 * ALPHABET decoding to garbage bytes, and raw-decoding it here used to fan doomed fetches
 * (and, pre server-guard, real instance boots) out of every params.dir consumer.
 */
export function decode64(value: string | undefined) {
  if (value === undefined) return
  try {
    const decoded = base64Decode(value)
    if (base64Encode(decoded) !== value) return
    if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(decoded)) return
    return decoded
  } catch {
    return
  }
}

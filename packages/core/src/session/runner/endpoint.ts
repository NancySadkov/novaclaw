export * as Endpoint from "./endpoint"

/**
 * The endpoint identity a per-endpoint lesson is filed under.
 *
 * ⚠️ A trailing slash, host case or query string is not a different endpoint; the same server under
 * two spellings must share one lesson. A malformed URL has no identity, so nothing is remembered for
 * it and the caller keeps its compiled default — the safe direction.
 *
 * One definition for two learners (`RepetitionFloor`, `ProviderSession`): a second copy is how two
 * endpoint-keyed stores drift into disagreeing about which server a row names.
 */
export const endpointKey = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`
  } catch {
    return undefined
  }
}

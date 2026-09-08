export const AUTO_APPLY_COST_CEILING = 1
export const MIN_SIMILARITY = 0.66
export const MAX_SIMILARITY_CELLS = 8_000_000

export type Tier = 1 | 2 | 3 | 4

export type Candidate = {
  readonly start: number
  readonly end: number
  readonly text: string
  readonly tier: Tier
  readonly cost: 0 | 1 | 100 | 1000
  readonly similarity: number
}

export type Match =
  | { readonly matched: true; readonly candidates: readonly Candidate[] }
  | { readonly matched: false; readonly best?: Candidate }

const COST = { 1: 0, 2: 1, 3: 100, 4: 1000 } as const satisfies Record<Tier, 0 | 1 | 100 | 1000>

/** Canonical punctuation is one-code-unit to one-code-unit so match offsets still address the source. */
export const canonicalize = (text: string): string =>
  text.replace(
    /[\u00a0\u2000-\u200a\u202f\u205f\u3000\u2010-\u2015\u2212\u2018\u2019\u201a\u201b\u2032\u2035\u201c\u201d\u201e\u201f\u2033\u2036]/g,
    (char) => {
      if (/^[\u00a0\u2000-\u200a\u202f\u205f\u3000]$/.test(char)) return " "
      if (/^[\u2010-\u2015\u2212]$/.test(char)) return "-"
      if (/^[\u2018\u2019\u201a\u201b\u2032\u2035]$/.test(char)) return "'"
      return '"'
    },
  )

const occurrences = (content: string, search: string): number[] => {
  const result: number[] = []
  if (search.length === 0) return result
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    result.push(offset)
    offset += search.length
  }
  return result
}

type Line = { readonly start: number; readonly end: number; readonly endWithBreak: number }

const lines = (text: string): Line[] => {
  const result: Line[] = []
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf("\n", start)
    if (newline === -1) {
      result.push({ start, end: text.length, endWithBreak: text.length })
      return result
    }
    result.push({
      start,
      end: newline > start && text[newline - 1] === "\r" ? newline - 1 : newline,
      endWithBreak: newline + 1,
    })
    start = newline + 1
  }
  if (text.length === 0 || text.endsWith("\n")) result.push({ start, end: start, endWithBreak: start })
  return result
}

const normalizeLines = (text: string) => text.replaceAll("\r\n", "\n")
const trailing = (text: string) =>
  canonicalize(normalizeLines(text))
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
const stripped = (text: string) =>
  canonicalize(normalizeLines(text))
    .split("\n")
    .map((line) => line.trim())
    .join("\n")

const blocks = (content: string, search: string): Omit<Candidate, "tier" | "cost" | "similarity">[] => {
  const normalized = normalizeLines(search)
  const endsWithBreak = normalized.endsWith("\n")
  const body = endsWithBreak ? normalized.slice(0, -1) : normalized
  const count = body.split("\n").length
  const sourceLines = lines(content)
  if (count < 1 || count > sourceLines.length) return []
  const result: Omit<Candidate, "tier" | "cost" | "similarity">[] = []
  for (let index = 0; index + count <= sourceLines.length; index++) {
    const first = sourceLines[index]
    const last = sourceLines[index + count - 1]
    const end = endsWithBreak ? last.endWithBreak : last.end
    result.push({ start: first.start, end, text: content.slice(first.start, end) })
  }
  return result
}

const candidate = (value: Omit<Candidate, "tier" | "cost" | "similarity">, tier: Tier, similarity = 1): Candidate => ({
  ...value,
  tier,
  cost: COST[tier],
  similarity,
})

const levenshtein = (left: string, right: string): number => {
  if (left === right) return 0
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  let previous = Array.from({ length: shorter.length + 1 }, (_, index) => index)
  for (let row = 1; row <= longer.length; row++) {
    const current = [row]
    for (let column = 1; column <= shorter.length; column++) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (longer[row - 1] === shorter[column - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[shorter.length]
}

const similarity = (left: string, right: string): number => {
  const longest = Math.max(left.length, right.length)
  return longest === 0 ? 1 : 1 - levenshtein(left, right) / longest
}

const atTier = (
  source: readonly Omit<Candidate, "tier" | "cost" | "similarity">[],
  search: string,
  tier: 2 | 3,
  normalize: (text: string) => string,
): Candidate[] => {
  const needle = normalize(search)
  if (needle.length === 0) return []
  return source.filter((item) => normalize(item.text) === needle).map((item) => candidate(item, tier))
}

/** Pure, deterministic four-rung matcher. The first rung with any candidates wins. */
export const find = (content: string, search: string): Match => {
  if (search.length === 0) return { matched: false }

  const canonicalContent = canonicalize(content)
  const canonicalSearch = canonicalize(search)
  const exact = occurrences(canonicalContent, canonicalSearch).map((start) =>
    candidate({ start, end: start + search.length, text: content.slice(start, start + search.length) }, 1),
  )
  if (exact.length > 0) return { matched: true, candidates: exact }

  const sourceBlocks = blocks(content, search)
  const trimmed = atTier(sourceBlocks, search, 2, trailing)
  if (trimmed.length > 0) return { matched: true, candidates: trimmed }
  const edgeStripped = atTier(sourceBlocks, search, 3, stripped)
  if (edgeStripped.length > 0) return { matched: true, candidates: edgeStripped }

  // Quadratic similarity is a last resort, and bounded so a malformed giant anchor cannot turn an
  // edit failure into a CPU denial of service. Higher rungs still report normally above this guard.
  if (canonicalSearch.length > 8_000 || sourceBlocks.length > 2_000) return { matched: false }
  const needle = canonicalize(normalizeLines(search)).trim()
  const similarityWork = sourceBlocks.reduce(
    (total, item) => total + needle.length * canonicalize(normalizeLines(item.text)).trim().length,
    0,
  )
  if (similarityWork > MAX_SIMILARITY_CELLS) return { matched: false }
  let best: Candidate | undefined
  const tied: Candidate[] = []
  for (const item of sourceBlocks) {
    const haystack = canonicalize(normalizeLines(item.text)).trim()
    const lengthRatio = Math.min(needle.length, haystack.length) / Math.max(needle.length, haystack.length, 1)
    const score = lengthRatio < MIN_SIMILARITY ? lengthRatio : similarity(haystack, needle)
    const current = candidate(item, 4, score)
    if (best === undefined || score > best.similarity) {
      best = current
      tied.length = 0
      tied.push(current)
    } else if (score === best.similarity) {
      tied.push(current)
    }
  }
  if (best !== undefined && best.similarity >= MIN_SIMILARITY) return { matched: true, candidates: tied }
  return { matched: false, ...(best === undefined ? {} : { best }) }
}

export const replace = (
  content: string,
  candidates: readonly Candidate[],
  replacement: string,
): { readonly content: string; readonly replacements: number } => {
  let result = ""
  let offset = 0
  let replacements = 0
  for (const item of [...candidates].sort((left, right) => left.start - right.start)) {
    if (item.start < offset) continue
    result += content.slice(offset, item.start) + replacement
    offset = item.end
    replacements++
  }
  return { content: result + content.slice(offset), replacements }
}

// Repair imperfect tool calls from small / local models so the agent loop keeps
// going instead of dropping the turn. Mirrors the rules proven in the afpro proxy:
//   - resolve a tool name by exact -> case-insensitive -> fuzzy match, first
//     scrubbing harmony tokens (e.g. "write<|channel|>...") some models leak into
//     the name;
//   - salvage malformed argument JSON (strip stray tokens, recover the outermost
//     object/array span) into a valid JSON string.
// Pure and dependency-free so it can run inside the AI SDK
// `experimental_repairToolCall` callback and be unit-tested without a model.

// 0.85 mirrors afpro's difflib cutoff: high enough that we only remap on a near-
// certain typo, never a coincidental overlap.
const FUZZY_CUTOFF = 0.85

const BRACKETS = [
  ["{", "}"],
  ["[", "]"],
] as const

// Resolve a model-emitted tool name to a real one, or undefined if it looks
// hallucinated (caller should then route to the `invalid` breadcrumb sink).
export function resolveToolName(raw: string, names: ReadonlyArray<string>): string | undefined {
  const scrubbed = scrubName(raw)
  if (names.includes(scrubbed)) return scrubbed
  const insensitive = names.find((name) => name.toLowerCase() === scrubbed.toLowerCase())
  if (insensitive) return insensitive
  return closestName(scrubbed, names)
}

// Return a valid compact JSON string for tool arguments, or undefined if nothing
// usable can be recovered (caller decides whether to fall back to `invalid`).
export function repairToolArgs(input: unknown): string | undefined {
  if (input === undefined || input === null) return "{}"
  if (typeof input !== "string") return JSON.stringify(input)
  const cleaned = input
    .replace(/<\|[^|]*\|>/g, "")
    .replace(/<\/tool_call>/g, "")
    .trim()
  if (cleaned.length === 0) return "{}"
  const direct = parseJson(cleaned)
  if (direct !== undefined) return JSON.stringify(direct)
  for (const [open, close] of BRACKETS) {
    const start = cleaned.indexOf(open)
    const end = cleaned.lastIndexOf(close)
    if (start >= 0 && start < end) {
      const span = parseJson(cleaned.slice(start, end + 1))
      if (span !== undefined) return JSON.stringify(span)
    }
  }
  return undefined
}

// Cut at the first harmony channel token and drop any remaining angle-bracket tags,
// so a leaked "write<|channel|>commentary" still resolves to "write".
function scrubName(raw: string) {
  return raw.split("<|")[0].replace(/<[^>]*>/g, "").trim()
}

function closestName(name: string, names: ReadonlyArray<string>) {
  const lower = name.toLowerCase()
  const best = names
    .map((candidate) => ({ candidate, score: ratio(lower, candidate.toLowerCase()) }))
    .reduce<{ candidate: string | undefined; score: number }>(
      (winner, entry) => (entry.score > winner.score ? entry : winner),
      { candidate: undefined, score: 0 },
    )
  return best.score >= FUZZY_CUTOFF ? best.candidate : undefined
}

// Normalized edit-distance similarity in [0,1].
function ratio(a: string, b: string) {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length)
}

function levenshtein(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = current
    }
  }
  return row[b.length]
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

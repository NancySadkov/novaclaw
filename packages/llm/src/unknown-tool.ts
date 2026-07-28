/**
 * The unknown-tool horizon: the ONE message a model gets back when it calls a tool name that was never
 * advertised, for every dispatch seam in the product.
 *
 * A wrong tool name is a HORIZON failure, not a knowledge failure — the Juvenile Harness premise. A bare
 * `Unknown tool: X` tells the model only that it lost; it names nothing to correct toward, so the model
 * re-guesses (or gives up) and the turn is dead. Handing back the tools it actually has converts that into
 * a recoverable turn. Same move, and deliberately the same tone, as the textual-call steer in
 * `@novaclaw/core`'s session/runner/textual-call.ts: name the mistake, say plainly that nothing ran, give
 * the exact correction, and close the "write the call as text instead" escape hatch.
 *
 * ⚠️ **Why it lives in `@novaclaw/llm` rather than beside the registry that first grew it.** There are two
 * dispatch seams and a model's call can land on either: `ToolRuntime.dispatch` in this package, and
 * `ToolRegistry.materialize().settle` in `@novaclaw/core`. Two seams answering the same question two ways
 * is the shape ruling 6 forbids — one gate, not two synchronised call sites, because "duplication is the
 * mechanism that produced the COMSPEC divergence". The dependency edge then decides which end owns the
 * gate, and it only points one way: `@novaclaw/core` depends on `@novaclaw/llm` (package.json,
 * `"@novaclaw/llm": "workspace:*"`) and this package declares no dependency on core at all. So the shared
 * thing can only live at THIS end — putting it in core and importing it back would be an import cycle.
 * It shipped in core first (ported from github.com/NancySadkov/novaclaw PR #4, @DassaultFalconKing) and
 * moved down here 2026-07-28, when the llm seam was found still returning the bare string.
 *
 * This module is a LEAF — it imports nothing at all — so its position constrains no consumer. It crosses
 * the package boundary as part of the already-exported `ToolRuntime` namespace (see tool-runtime.ts).
 */

/**
 * Characters of tool names the message may spend before it truncates. The full built-in set is 28 short
 * names (~250 characters), so this never bites on a stock session — it exists only because MCP servers and
 * plugins register unboundedly many, and a 6 KB error would evict the very context the model needs. A
 * count cap would be the wrong unit: 12 of 28 names hides `read` from a model that just called `read_file`.
 */
export const UNKNOWN_TOOL_LIST_BUDGET = 800

/**
 * Case, separators and word breaks are the near-misses a model actually produces — and our own names mix
 * both separators (`read-hex`, `register-app` next to `apply_patch`, `tool_manual`), so `read_hex` is a
 * near-certain miss. Comparing on alphanumerics alone catches every one of those exactly.
 */
const canonical = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "")

/** Exact-after-normalization beats "the model added a suffix" beats "the model truncated"; inside a tier
 * the longer shared prefix is the more specific match. `0` means not close at all. */
const rank = (target: string, key: string) => {
  if (key === target) return 3_000 + key.length
  if (target.startsWith(key)) return 2_000 + key.length
  if (key.startsWith(target)) return 1_000 + target.length
  return 0
}

/**
 * The one tool the caller most plausibly meant, or `undefined` when nothing is close — or when two
 * candidates are equally close. Never guess on a tie: `web` between `webfetch` and `websearch` is a coin
 * flip, and a confidently wrong "did you mean" costs more than no hint at all.
 */
export const closestToolName = (name: string, available: Iterable<string>): string | undefined => {
  const target = canonical(name)
  if (target.length < 2) return undefined
  let best: string | undefined
  let score = 0
  let tied = false
  for (const candidate of available) {
    const key = canonical(candidate)
    if (key.length < 2) continue
    const current = rank(target, key)
    if (current === 0 || current < score) continue
    if (current === score) {
      if (candidate !== best) tied = true
      continue
    }
    score = current
    best = candidate
    tied = false
  }
  return tied ? undefined : best
}

/**
 * The tool-result error for a name that was never advertised. `available` is the advertised set, in
 * advertised order: the message re-states the very list the model was given rather than inventing a
 * second, differently sorted one (sorting would make the error and the tool list disagree for no gain).
 *
 * ⚠️ Both branches are load-bearing and both must survive at every seam that adopts this. The empty branch
 * exists because listing nothing is not a horizon — a dangling "Available tools: ." would be a fault
 * described falsely (ruling 2), so it says outright that there is nothing to call. The budget exists
 * because an unbounded list is its own denial-of-service on a small model's context.
 */
export const unknownToolMessage = (name: string, available: Iterable<string>): string => {
  const names = Array.from(available)
  if (names.length === 0)
    return (
      `Unknown tool: ${name}. Nothing ran — no tools are available in this turn. Do not invent a tool or ` +
      `write a call as text; answer in your reply instead.`
    )
  // The near-miss is carried in its own clause, never only inside the list, so truncation can never hide
  // the one name that would have fixed the call.
  const hint = closestToolName(name, names)
  const shown: Array<string> = []
  let budget = UNKNOWN_TOOL_LIST_BUDGET
  for (const candidate of names) {
    budget -= candidate.length + 2
    if (budget < 0 && shown.length > 0) break
    shown.push(candidate)
  }
  const listed =
    shown.length === names.length
      ? `Available tools: ${shown.join(", ")}.`
      : `Available tools (${shown.length} of ${names.length}): ${shown.join(", ")}, and ${names.length - shown.length} more.`
  return (
    `Unknown tool: ${name}. Nothing ran. ${hint ? `Did you mean "${hint}"? ` : ""}${listed} ` +
    `Use one of these exact advertised names — do not invent a tool or write a call as text.`
  )
}

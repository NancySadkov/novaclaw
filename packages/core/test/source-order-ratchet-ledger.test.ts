import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "./lib/source-scan"

/**
 * 🔴 **A SOURCE-ORDER RATCHET THAT READS COMMENTS IS A RATCHET THAT READS PROSE.**
 *
 * A recurring shape in this repository: a test reads a source file as text, takes `indexOf` positions
 * of two identifiers, and asserts which comes first. That is a good ratchet — it is the only way to
 * pin "X must be mounted before Y" — and it has one silent failure mode. A comment that MENTIONS
 * either identifier outranks the code in the string, so the answer inverts.
 *
 * ⚠️ **Measured, not hypothesised.** Caught on 2026-09-29 in
 * `novaclaw/test/server/cors-outcome-log-wiring.test.ts`, failing on its own subject: the comment
 * explaining why the order is load-bearing names `corsVaryFix` one line above the `corsOutcomeLog`
 * entry, so a correct layer list read as misordered. That file was the second instance; the first
 * was the ratchet itself being wrong rather than the code.
 *
 * It fails silently in the worst direction. A guard that has gone blind and a tree that is clean are
 * the same observation, and the ratchet that fails is the one you trusted.
 *
 * **The fix already exists and is already shared:** `stripComments` from `test/lib/source-scan.ts`,
 * exported as `@novaclaw/core/test/source-scan`, AST-based and offset-preserving. It is not optional
 * decoration — the same file records that the obvious two-regex strip DELETES real code when a
 * slash-star appears inside a line comment or a string: 19 files of `core/src` lost code that way and
 * `session.ts` lost 650 lines, silently, inside guards that assert an empty offender list.
 *
 * So this is a RATCHET, and it fails in BOTH directions. An unlisted offender fails outright. A
 * listed offender that no longer trips fails with "drop the ledger entry", so a fix forces the entry
 * out and the list can only shrink.
 *
 * ⚠️ **The detector under-counts, and that is written down rather than assumed away.** It is a
 * textual closure, so it recognises a position derived from a name bound to file text — not a
 * position whose text arrives as a FUNCTION PARAMETER. `core/src/agent-status/sampler.test.ts` is a
 * known miss and is deliberately absent from the list below rather than faked into it. A listed
 * entry is a thing this detector can see; an unlisted file is not thereby clean. Fixing an offender
 * removes it from the LIST, not from the risk.
 */
const ROOT = join(import.meta.dir, "..", "..", "..")
const SCAN_ROOTS = ["packages"] as const
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  "gen",
  ".git",
  ".ts-dist",
  ".turbo",
  ".vite",
  "playwright-report",
  "test-results",
])

/**
 * Every known raw source-order ratchet. The reason is the class above, stated once.
 *
 * ⚠️ The reason is deliberately NOT per-file. It was tempting to write a sentence per entry saying
 * what it pins, and every one of those sentences would have been a guess — the class is uniform, and
 * an invented per-file rationale is worse than a shared true one. Each entry's own `test(...)` titles
 * are the authority on what it pins; this list is only the debt.
 */
const KNOWN_RAW_SOURCE_ORDER_RATCHETS = [
  "packages/app/src/app-routes.test.ts",
  "packages/app/src/components/agent-pure-chat-boundary.test.ts",
  "packages/app/src/components/dialog-select-model.test.ts",
  "packages/app/src/components/session/session-activity-indicators.test.ts",
  "packages/app/src/components/settings-v2/dialog-new-model.test.ts",
  "packages/app/src/components/settings-v2/models-enablement.test.ts",
  "packages/app/src/components/settings-v2/settings-screen.test.ts",
  "packages/app/src/context/global-sync/instance-recovery.test.ts",
  "packages/app/src/context/server-sdk.test.ts",
  "packages/core/src/jh/store.test.ts",
  "packages/core/src/kb-graph/world-memory-does-not-spawn.test.ts",
  "packages/core/src/session/runner/todo-reminder.test.ts",
  "packages/core/src/tool/wait.test.ts",
  "packages/core/test/colleague-tool.test.ts",
  "packages/core/test/community-peers.test.ts",
  "packages/core/test/community-tool-ask.test.ts",
  "packages/core/test/community-tool-say.test.ts",
  "packages/core/test/runner-config-per-turn.test.ts",
  "packages/core/test/session-compaction.test.ts",
  "packages/core/test/session-extract.test.ts",
  "packages/core/test/session-provider-recovery-notice.test.ts",
  "packages/core/test/session-recovery-decision.test.ts",
  "packages/core/test/session-scheduler-concurrency.test.ts",
  "packages/core/test/world-memory-spawn-gate.test.ts",
  "packages/desktop/electron-builder.config.test.ts",
  "packages/novaclaw/src/session-worker/interaction-handler-deps.test.ts",
  "packages/novaclaw/test/cli/run/incomplete.test.ts",
  "packages/novaclaw/test/control-plane/workspace-layer-mirrors.test.ts",
  "packages/novaclaw/test/reassignment-wiring.test.ts",
  "packages/novaclaw/test/server/api-mount-parity.test.ts",
  "packages/novaclaw/test/server/community-ask.test.ts",
  "packages/novaclaw/test/worker-watch-wiring.test.ts",
]

/**
 * Tests that hand-roll their own comment strip instead of importing the shared AST one.
 *
 * ⚠️ A second door into the same defect, and the more dangerous one, because it looks handled. These
 * files DO blank comments before indexing, so the ordering check above cannot see them — a sweep for
 * "raw" ratchets alone would report the tree as clean while a reimplementation quietly drifts from
 * the behaviour of the helper the other ledgers depend on.
 *
 * The shape is recorded per file because here the difference is measured, not stylistic. Being
 * string-aware is better than nothing and strictly worse than the parser, which decides what a
 * comment is the same way the compiler does, so there is no residual case to argue:
 *
 *   · `zero-runtime-dependencies` — `/\*[\s\S]*?\*\//` then `//`. This is EXACTLY the two-pass strip
 *     `source-scan.ts` records as deleting real code when a slash-star appears in a line comment or a
 *     string: 19 files of `core/src` lost code, `session.ts` lost 650 lines, silently, in guards
 *     asserting an empty offender list. Highest-value entry on this list.
 *   · `plugin-capability-declaration` — one regex with string and template literals alternated ahead
 *     of the comment arms. Fixes the measured case; the house file names the residual hole, an
 *     unescaped slash-star inside a REGEX literal.
 *   · `settled-resource-ledger` — an explicit character state machine with code/line/block/single/
 *     double/template modes. The most careful of the six, and still a second opinion about
 *     lexing that the parser already owns.
 *   · `native-transcript-literals` — strips only comments that start a line, so a trailing comment
 *     survives. Safe for what it asserts, and wrong for anything else.
 *   · `workspace-layer-mirrors`, `context-key-uniqueness` — `blankComments`, self-described as
 *     string-aware. ⚠️ Their bodies were NOT read for this ledger; the entry records the duplication,
 *     which is the claim, and not a judgement about their correctness.
 */
const KNOWN_HAND_ROLLED_COMMENT_STRIPPERS = [
  "packages/app/src/utils/settled-resource-ledger.test.ts",
  "packages/core/test/plugin-capability-declaration.test.ts",
  "packages/novaclaw/test/control-plane/workspace-layer-mirrors.test.ts",
  "packages/protocol/test/context-key-uniqueness.test.ts",
  "packages/sdk/js/test/zero-runtime-dependencies.test.ts",
  "packages/session-ui/src/v2/components/native-transcript-literals.test.ts",
]

const testFiles = (): string[] => {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) found.push(full)
    }
  }
  for (const root of SCAN_ROOTS) walk(join(ROOT, root))
  return found
}

/** A binding that reaches file text, directly or through a local read helper. */
const READS_A_FILE = /readFileSync|Bun\.file\(/
/** How far past a binding's name to look for what its initializer mentions. */
const BINDING_WINDOW = 320

/**
 * Names holding file text, found by transitive closure.
 *
 * ⚠️ **Three blind spots were measured on the first version of this detector, and each hid a real
 * instance**, which is why the shape is what it is:
 *   · recognising only `const x = readFileSync(` missed `app-routes.test.ts`, whose helper is `src`;
 *   · requiring a `{` body missed `worker-watch-wiring.test.ts`, an expression-bodied arrow;
 *   · seeding positions only from a directly-read name missed `world-memory-spawn-gate.test.ts`,
 *     which takes its position from a `.slice()` of the text.
 * A fourth, still open, is a file that receives its source as a function PARAMETER.
 *
 * The window is measured from the NAME, not from the start of the match: `\s*` in the declaration
 * regex happily consumes a whole blanked comment, which put the window 600 characters upstream of
 * the code it was supposed to describe and hid four more instances for one round. Crude, and it errs
 * toward finding MORE, which is the safe direction for a hole that would otherwise hide debt. The
 * ordering check below is what stops the crudeness from inventing offenders.
 */
const sourceNames = (source: string): Set<string> => {
  const bindings: { name: string; text: string }[] = []
  const declare = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/g
  for (const match of source.matchAll(declare)) {
    const name = match[1]!
    const at = (match.index ?? 0) + match[0].lastIndexOf(name)
    bindings.push({ name, text: source.slice(at, at + BINDING_WINDOW) })
  }
  const names = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const { name, text } of bindings) {
      if (names.has(name)) continue
      const reachesFile =
        READS_A_FILE.test(text) || [...names].some((known) => new RegExp(`\\b${known}\\b`).test(text))
      if (reachesFile) {
        names.add(name)
        changed = true
      }
    }
  }
  return names
}

/**
 * Names bound to a position in SOURCE — the hop that excludes runtime strings.
 *
 * `community-tool.test.ts` also indexes strings and compares those positions, but they are the output
 * of a tool call rather than a source file, and a comment cannot reach them. Counting it would make
 * the ledger a list of things nobody should change.
 */
const positionNames = (source: string, sources: Set<string>): Set<string> => {
  const names = new Set<string>()
  const bind = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^;\n]*)\.indexOf\(/g
  for (const match of source.matchAll(bind)) {
    const [, name, receiver] = match
    if (name && receiver && [...sources].some((source) => receiver.includes(source))) names.add(name)
  }
  return names
}

const comparesPositions = (source: string, names: Set<string>) =>
  [...source.matchAll(/toBe(?:Less|Greater)Than\(\s*([^)]*?)\s*\)/g)].some((match) => {
    const argument = match[1] ?? ""
    return names.has(argument) || (names.size > 0 && /\.indexOf\(/.test(argument))
  })

const isRawSourceOrderRatchet = (contents: string) => {
  if (!/readFileSync|import\.meta\.dir/.test(contents)) return false
  if (/stripComments/.test(contents)) return false
  const sources = sourceNames(contents)
  if (sources.size === 0) return false
  const positions = positionNames(contents, sources)
  return positions.size > 0 && comparesPositions(contents, positions)
}

/** A locally defined comment stripper: the shape that looks handled and is not. */
const definesOwnCommentStripper = (contents: string) =>
  /(?:function|const)\s+blankComments\b/.test(contents) ||
  /(?:function|const)\s+(?:strip|remove|drop)Comments?\b/.test(contents)

describe("a source-order ratchet must not read comments", () => {
  // Comments are stripped BEFORE matching, so this file's own prose about `indexOf` and
  // `toBeLessThan` cannot make it an offender, and a doc comment inside an offender cannot hide one.
  // Dogfooding is the point: a ratchet that flagged its own explanation would be a ratchet nobody
  // trusted enough to extend — which is how the sibling ledgers in this directory already died once.
  const scanned = testFiles().map((path) => {
    const relativePath = relative(ROOT, path).replaceAll("\\", "/")
    return { path: relativePath, parsed: stripComments(readFileSync(path, "utf8"), relativePath) }
  })

  const rawOrderRatchets = scanned
    .filter((entry) => isRawSourceOrderRatchet(entry.parsed))
    .map((entry) => entry.path)
    .sort()

  const ownStrippers = scanned
    .filter((entry) => definesOwnCommentStripper(entry.parsed))
    .map((entry) => entry.path)
    .sort()

  test("no ratchet asserts an order by indexing raw, comment-bearing source", () => {
    const unlisted = rawOrderRatchets.filter((path) => !KNOWN_RAW_SOURCE_ORDER_RATCHETS.includes(path))
    expect(
      unlisted,
      unlisted.length
        ? "These assert an order in source text WITHOUT stripComments, so a comment can invert them.\n" +
            "  Fix: import { stripComments } from \"@novaclaw/core/test/source-scan\" and grep its output.\n" +
            "  Do NOT hand-roll a regex strip — test/lib/source-scan.ts records that deleting real code.\n" +
            `  Offenders:\n${unlisted.map((p) => `    ${p}`).join("\n")}`
        : "",
    ).toEqual([])
  })

  test("🔴 the raw ledger only shrinks — a fixed ratchet must leave the list", () => {
    // The other direction. Without it the list is a place to hide an exemption, and a fix becomes
    // invisible rather than rewarded.
    const fixed = KNOWN_RAW_SOURCE_ORDER_RATCHETS.filter((path) => !rawOrderRatchets.includes(path))
    expect(
      fixed,
      fixed.length
        ? `These no longer trip the detector, so the entry is stale — remove it:\n${fixed
            .map((p) => `    ${p}`)
            .join("\n")}`
        : "",
    ).toEqual([])
  })

  test("no test hand-rolls a comment stripper when the AST one is shared", () => {
    const unlisted = ownStrippers.filter((path) => !KNOWN_HAND_ROLLED_COMMENT_STRIPPERS.includes(path))
    expect(
      unlisted,
      unlisted.length
        ? "These define their own comment strip. A string-aware strip is better than none and strictly\n" +
            "  worse than the parser, which cannot disagree with the compiler about what a comment is.\n" +
            "  Fix: import { stripComments } from \"@novaclaw/core/test/source-scan\".\n" +
            `  Offenders:\n${unlisted.map((p) => `    ${p}`).join("\n")}`
        : "",
    ).toEqual([])
  })

  test("🔴 the hand-rolled ledger only shrinks", () => {
    const fixed = KNOWN_HAND_ROLLED_COMMENT_STRIPPERS.filter((path) => !ownStrippers.includes(path))
    expect(
      fixed,
      fixed.length
        ? `These no longer define their own strip, so the entry is stale — remove it:\n${fixed
            .map((p) => `    ${p}`)
            .join("\n")}`
        : "",
    ).toEqual([])
  })

  test("the detector still finds something — a guard that finds nothing is a guard that is off", () => {
    // The failure mode of a count-based ratchet is a broken detector reporting zero, after which
    // "no unlisted offenders" passes for entirely the wrong reason. Pin both populations, so a
    // silently-empty scan fails HERE instead of looking like a clean tree.
    expect(rawOrderRatchets.length, "the raw-order ledger must not be silently empty").toBeGreaterThan(0)
    expect(rawOrderRatchets.length, "ledger and detector disagree on the population").toBe(
      KNOWN_RAW_SOURCE_ORDER_RATCHETS.length,
    )
    expect(ownStrippers.length, "the hand-rolled-stripper ledger must not be silently empty").toBeGreaterThan(0)
    expect(ownStrippers.length, "ledger and detector disagree on the population").toBe(
      KNOWN_HAND_ROLLED_COMMENT_STRIPPERS.length,
    )
  })
})

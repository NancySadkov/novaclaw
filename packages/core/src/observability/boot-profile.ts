import { Effect, Layer } from "effect"

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The boot profile — a per-phase startup waterfall printed into the ordinary log.
//
// WHY IT LIVES HERE (`core/observability/`, next to `logging.ts` and `otlp.ts`): it is telemetry, and
// `@novaclaw/core` is the only package that BOTH entry points reach — the `novaclaw` CLI
// (`packages/novaclaw/src/index.ts` → `cli/cmd/serve.ts` → `server/server.ts`) and the Electron
// sidecar (`packages/desktop/src/main/sidecar.ts` → `virtual:novaclaw-server` →
// `packages/novaclaw/src/node.ts` → the SAME `server/server.ts`). One module, both boots.
//
// WHY NOT OTLP. `todo/startup.md` recorded the waterfall as blocked on standing up an OTLP collector
// to read the 763 existing `Effect.fn` spans. It is not: there is no collector on a user's laptop
// either, which is precisely where the number we ship lives. This is `todo/adoption.md` A10.1 — the
// log IS the telemetry channel. No exporter, no endpoint, no offline-policy interaction, and it works
// identically in the packaged desktop app.
//
// ⚠️ THIS MODULE MUST NOT CHANGE CONTROL FLOW. It records timestamps and prints. Every call site is
// an observation; none of them branch, reorder, or catch. Phase 2 of `todo/startup.md` (lazy edges,
// degraded capabilities) is the change, and it depends on these numbers rather than shipping with
// them.
//
// COST, and why the split below is where it is:
//   · `mark()` is ALWAYS-ON. It is one `performance.now()` plus an array push into a capped buffer.
//     MEASURED on this box (bun 1.3.14, 2026-07-31): 0.555 µs per call over 1000 calls, and the
//     always-on set is 12 marks — 27.2 µs total against a boot of 3–6.5 SECONDS, i.e. 0.0008%.
//     Making it conditional would buy nothing and would mean the numbers only exist for someone who
//     already knew to ask.
//   · PRINTING is flag-gated (`NOVACLAW_BOOT_PROFILE=1`). A waterfall on every boot is noise.
//   · PER-NODE layer instrumentation (`instrumentNodeTree`, used by `location-services.ts`) is
//     flag-gated too, and for a stronger reason: it wraps every layer in the graph, which is a
//     change to the layer OBJECT graph even though it preserves service identity. With the flag off
//     the caller uses the original node objects verbatim, so the default boot is byte-identical to
//     one with this module deleted.
//
// Output goes to STDERR, not stdout: `serve`'s stdout is a pass-through that health/log parsing
// depends on (`cli/cmd/serve.ts`'s supervisor comment), and the desktop pipes the sidecar's stderr
// into its own `server.log` (`sidecar.ts`), so stderr reaches both read-back paths without risking
// either parser.
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type Mark = {
  readonly name: string
  /** Milliseconds since process start (`performance.now()`'s origin IS process start). */
  readonly at: number
  /** How many times this name was marked inside its segment. See `instrumentNodeTree`. */
  readonly repeat: number
}

/** A bound, so a pathological graph cannot grow this without limit in a long-lived process. */
export const MAX_MARKS = 1024

const buffer: Mark[] = []
const firstIndex = new Map<string, number>()
let dropped = 0
/** Marks before this index have already been reported; a segment is what arrived since. */
let consumed = 0

/** ⚠️ Read LAZILY, never frozen at module import — AGENTS.md pitfall #0's generalisation (b). The
 *  desktop sidecar assigns `process.env` in `prepareSidecarEnv` AFTER its modules are loaded. */
export function enabled(): boolean {
  const value = process.env["NOVACLAW_BOOT_PROFILE"]?.toLowerCase()
  return value === "1" || value === "true"
}

/**
 * Record that a boot phase COMPLETED, now.
 *
 * A repeat of a name already seen in this segment does not overwrite it — the first timestamp is the
 * one that means something (a memoized Effect layer referenced twice re-runs its tap while the
 * service itself builds once), and the repeat count is carried into the report so a duplicate is
 * VISIBLE rather than silently collapsed.
 */
export function mark(name: string): void {
  const index = firstIndex.get(name)
  if (index !== undefined && index >= consumed) {
    const existing = buffer[index]!
    buffer[index] = { name: existing.name, at: existing.at, repeat: existing.repeat + 1 }
    return
  }
  if (buffer.length >= MAX_MARKS) {
    dropped++
    return
  }
  firstIndex.set(name, buffer.length)
  buffer.push({ name, at: performance.now(), repeat: 1 })
}

/** Every mark recorded so far, reported and unreported alike. */
export function marks(): readonly Mark[] {
  return buffer
}

/** How many marks were refused by the `MAX_MARKS` bound. Reported, never hidden (ruling 2). */
export function droppedMarks(): number {
  return dropped
}

/** Test seam. Production never calls this. */
export function reset(): void {
  buffer.length = 0
  firstIndex.clear()
  dropped = 0
  consumed = 0
}

// ── The phase catalogue ─────────────────────────────────────────────────────────────────────────
//
// ⚠️ Ruling 2, and it is the whole reason this catalogue exists as DATA rather than as whatever the
// marks happened to produce: a phase that was not measured must say `not measured`, never `0.0 ms`.
// A report driven only by the marks it received cannot tell "this phase costs nothing" from "nobody
// instrumented this phase" — and the second is the answer far more often.
//
// `test/boot-profile.test.ts` pins these against the actual `BootProfile.mark("…")` call sites in
// source, in both directions, so deleting a call site fails a test instead of quietly shortening the
// timeline.

export const PHASES = {
  /** `novaclaw serve` — the CLI entry point, from process start to a bound listener. */
  serve: [
    "cli:modules-loaded",
    "cli:command-loaded",
    "cli:args-parsed",
    "server:module-loaded",
    "server:listen-start",
    "server:http-bound",
    "server:services-built",
    "server:tcp-address",
    "server:mdns",
    "server:listening",
  ],
  /** The Electron sidecar — the same `Server.listen`, without the yargs CLI in front of it. */
  sidecar: [
    "server:module-loaded",
    "server:listen-start",
    "server:http-bound",
    "server:services-built",
    "server:tcp-address",
    "server:mdns",
    "server:listening",
  ],
  /** One location's service graph. The FIRST in a process is cold; every later one is warm. */
  location: ["location:boot-start", "location:globals-built", "location:booted"],
} as const

export type Segment = keyof typeof PHASES

/**
 * Which entry point this process turned out to be, decided by what was OBSERVED rather than by a
 * flag someone has to remember to set. The CLI marks `cli:*`; the sidecar imports `server/server.ts`
 * directly and never does.
 */
export function entryPoint(): Segment {
  return firstIndex.has("cli:modules-loaded") ? "serve" : "sidecar"
}

// ── The report ──────────────────────────────────────────────────────────────────────────────────

export type Row =
  | {
      readonly kind: "measured"
      readonly name: string
      readonly at: number
      readonly delta: number
      readonly repeat: number
    }
  | { readonly kind: "missing"; readonly name: string }

export type Timeline = {
  readonly label: string
  readonly origin: number
  readonly total: number
  readonly rows: readonly Row[]
  readonly dropped: number
}

/**
 * Fold a segment's marks plus its expected phase list into a timeline.
 *
 * Ordering is by measured time, so an unexpected mark (a `node:*` from `instrumentNodeTree`, say)
 * lands where it actually happened rather than being appended. Expected phases with no mark are
 * emitted as `missing` rows AFTER the measured ones — they have no time to be sorted by, and
 * inventing one is the falsehood ruling 2 forbids.
 */
export function timeline(input: {
  readonly label: string
  readonly marks: readonly Mark[]
  readonly expected: readonly string[]
  readonly origin: number
  readonly dropped?: number
}): Timeline {
  const measured = [...input.marks].sort((a, b) => a.at - b.at)
  const seen = new Set(measured.map((entry) => entry.name))
  const rows: Row[] = []
  let previous = input.origin
  for (const entry of measured) {
    rows.push({ kind: "measured", name: entry.name, at: entry.at, delta: entry.at - previous, repeat: entry.repeat })
    previous = entry.at
  }
  for (const name of input.expected) if (!seen.has(name)) rows.push({ kind: "missing", name })
  return {
    label: input.label,
    origin: input.origin,
    total: measured.length === 0 ? 0 : measured[measured.length - 1]!.at - input.origin,
    rows,
    dropped: input.dropped ?? 0,
  }
}

const BAR_WIDTH = 24

/** jcode's A10.1 shape: cumulative ms, delta ms, percent, bar — one line per phase. */
export function format(view: Timeline): string {
  const width = Math.max(24, ...view.rows.map((row) => row.name.length))
  const lines = [
    `[boot-profile] ${view.label} — ${view.total.toFixed(1)} ms` +
      (view.origin === 0 ? " since process start" : ` (from ${view.origin.toFixed(1)} ms)`),
  ]
  for (const row of view.rows) {
    if (row.kind === "missing") {
      lines.push(`  ${row.name.padEnd(width)}  ${"not measured".padStart(28)}`)
      continue
    }
    const share = view.total > 0 ? (row.delta / view.total) * 100 : 0
    const bar = "#".repeat(Math.min(BAR_WIDTH, Math.round((share / 100) * BAR_WIDTH)))
    lines.push(
      `  ${row.name.padEnd(width)}  ${row.at.toFixed(1).padStart(9)} ms  ` +
        `+${row.delta.toFixed(1).padStart(8)} ms  ${share.toFixed(1).padStart(5)}%  ${bar}` +
        (row.repeat > 1 ? ` x${row.repeat}` : ""),
    )
  }
  if (view.dropped > 0) lines.push(`  ⚠ ${view.dropped} mark(s) dropped at the ${MAX_MARKS}-mark cap`)
  return lines.join("\n")
}

/**
 * Close the current segment: fold every mark since the last report, print it when the flag is on,
 * and return the timeline so a caller (or a test) can assert on the STRUCTURE rather than on a
 * duration. Always consumes, flag or no flag, so segments never bleed into each other.
 */
export function report(
  label: string,
  expected: readonly string[],
  options?: { readonly origin?: "process" | "segment" },
): Timeline {
  const segment = buffer.slice(consumed)
  const previousEnd = consumed === 0 ? 0 : (buffer[consumed - 1]?.at ?? 0)
  // ⚠️ `"process"` is right when the previous segment's end really IS this phase's origin — the
  // `serve` boot starts at 0, which is process start. It is WRONG for a phase that begins after an
  // idle wait: a location boots when the first request arrives, so charging it the seconds the
  // server spent waiting would report a 951 ms location boot as 1467 ms. That is ruling 2 (a fault
  // is never described falsely) applied to a headline number, and the gap is still visible — it is
  // the delta on the segment's first row under `"process"`.
  const origin =
    options?.origin === "segment" && segment.length > 0
      ? segment.reduce((earliest, entry) => Math.min(earliest, entry.at), Infinity)
      : previousEnd
  const view = timeline({ label, marks: segment, expected, origin, dropped })
  consumed = buffer.length
  if (enabled()) process.stderr.write(format(view) + "\n")
  return view
}

// ── Per-node layer instrumentation ──────────────────────────────────────────────────────────────

type NodeLike = {
  readonly name: string
  readonly implementation?: unknown
  readonly dependencies: readonly NodeLike[]
}

/**
 * Rewrite a `LayerNode` tree so every node's layer marks `node:<name>` when it finishes building.
 *
 * ⚠️ Read AGENTS.md → Known pitfalls, item −1 before touching this. Two properties it must not break,
 * both of which it preserves for the SAME reason — `Layer.tap` is `fromBuild(… self.build(memoMap,
 * scope) …)`, i.e. it delegates to the INNER layer's own build, and a `Layer.effect` node's build IS
 * `memoMap.getOrElseMemoize(self, …)` keyed on that inner object:
 *   1. `Database`, `Global`, `MemoryClient` and `SessionScheduler` stay ONE instance per process. The
 *      tap wrapper is not itself memoized, so the tap effect can fire more than once for a node
 *      reached from two parents — the SERVICE still builds once. That is why `mark()` keeps the
 *      first timestamp and counts repeats instead of overwriting: the second timestamp is the cost of
 *      a cache hit, and reporting it as the build cost would be a false description of a real fault.
 *   2. Replacements keep working. `hoist`/`compile` resolve replacements BY NAME, and the rewrite
 *      preserves `name` and `tag`, so `Location.boundNode(ref)`, `ExternalToolSource` and
 *      `ExternalCommandSource` substitute into the rewritten tree exactly as into the original.
 *
 * ⚠️ The cache is PROCESS-WIDE and deliberately so, which is the correction a first version needed.
 * `hoist` rejects two different node OBJECTS carrying one hoisted name (`Tag global has conflicting
 * implementations for …`), and a replacement node reaches the same graph carrying ORIGINAL
 * dependencies — `Location.boundNode(ref)` declares `deps: [Project.node]`, built fresh per location
 * boot. Rewriting the tree with a per-call cache therefore put the original `ProjectV2` next to its
 * own clone and the first location boot died. One cache shared by the tree rewrite AND by
 * `instrumentReplacement` is what makes "the same service is the same object" survive the rewrite.
 *
 * ⚠️ It returns a DIFFERENT object graph, so nothing may compare a rewritten node by identity against
 * the module-level original (`LayerNode.hasUnbound` does exactly that). The only caller applies it
 * inside `buildLocationServiceMap`, where the tree is consumed immediately by `hoist`/`compile`; the
 * exported `locationServices` object every test reaches for is untouched.
 */
const nodeCache = new Map<NodeLike, NodeLike>()

export function instrumentNodeTree<N>(root: N): N {
  const cache = nodeCache
  const recur = (node: NodeLike): NodeLike => {
    const cached = cache.get(node)
    if (cached !== undefined) return cached
    const dependencies = node.dependencies.map(recur)
    const rewritten: NodeLike =
      node.implementation === undefined
        ? { ...node, dependencies }
        : {
            ...node,
            dependencies,
            implementation: Layer.tap(node.implementation as Layer.Layer<unknown, unknown, unknown>, () =>
              Effect.sync(() => mark(`node:${node.name}`)),
            ),
          }
    cache.set(node, rewritten)
    return rewritten
  }
  return recur(root as NodeLike) as N
}

/**
 * The replacement half of the same job. A `LayerNode.Replacement`'s second element is either a node
 * or a bare `Layer`; only the node form carries dependencies that could collide, and it must go
 * through the SAME cache as the tree (see the ⚠️ above). Mirrors `layer-node.ts`'s own `isNode`.
 */
export function instrumentReplacement<R>(replacement: R): R {
  const candidate = replacement as { kind?: unknown; dependencies?: unknown } | null | undefined
  if (typeof candidate?.kind !== "string" || !Array.isArray(candidate.dependencies)) return replacement
  return instrumentNodeTree(replacement)
}

export * as BootProfile from "./boot-profile"

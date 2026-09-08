import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { KbAbsorb } from "@novaclaw/core/kb-graph/absorb"
import { KbAbsorbEval } from "../script/absorb-eval"
import { KbChunk } from "@novaclaw/core/kb-graph/chunk"
import { SessionExtract } from "@novaclaw/core/session/runner/extract"

/**
 * ABSORPTION VARIANCE, and A/B-ing a prompt clause against it.
 *
 * 🔴 Three prompt changes in this program were judged on ONE run each. Measured 2026-08-12, three
 * identical runs at `temperature: 0` move by **±11 names and ±6.3 concrete points** — which is the
 * size of every delta those verdicts rested on. A single sample cannot separate "the clause helped"
 * from "the model felt different", so an arm here is a MEAN OVER REPEATS and a delta only counts when
 * it clears the pooled spread.
 *
 * Runs OUTSIDE the gate (`.smoke.ts`) against a live endpoint: a measurement, not a regression test,
 * costing one model call per passage per repeat per arm.
 *
 * ⛔ Calls the model directly rather than through `ingest`. What varies between runs is the model, and
 * a server boot per repeat costs ~34 s to measure nothing. The prompt and parser are the REAL ones —
 * `KbAbsorb.SYSTEM` and `SessionExtract.parseExtraction` — so a prompt edit is what this sees.
 *
 * Run it, from `packages/core`:
 *
 * ```
 * NOVACLAW_EVAL_CORPUS=<a record-style document> bun test ./test/kb-absorb-variance.smoke.ts
 * ```
 *
 * ⚠️ The leading `./` is load-bearing. `bun test test/…smoke.ts` treats the argument as a name FILTER,
 * matches nothing (no `.test.` in the filename), and **exits 0** — a green run that measured nothing.
 */
const ENDPOINT = process.env["NOVACLAW_EVAL_ENDPOINT"] ?? "http://192.168.178.40:8040/v1/chat/completions"
const MODEL = process.env["NOVACLAW_EVAL_MODEL"] ?? "qwen3.6-35b"
const CORPUS = process.env["NOVACLAW_EVAL_CORPUS"] ?? ""
const REPEATS = Number(process.env["NOVACLAW_EVAL_REPEATS"] ?? 3)
/**
 * ⚠️ Thinking ON is the SHIPPED configuration and therefore the default here.
 *
 * The first version of this file disabled thinking while its own comment claimed the opposite, so the
 * floor it published was measured in a configuration the product does not run. That matters more than
 * a normal comment drift: the recorded finding for this subsystem is that ENABLING thinking is what
 * turned section headings into real entity names, so a prompt measured with it off is being measured
 * on the failure mode. Kept as a knob only because the two modes' floors are worth comparing.
 */
const THINKING = process.env["NOVACLAW_EVAL_THINKING"] !== "off"

/**
 * The clause under test, and its arms.
 *
 * ⚠️ Each variant asserts that its surgery on the shipped prompt CHANGED something. An arm that
 * silently fails to differ from `shipped` reports a real-looking zero delta, which is the same
 * vacuous-pass trap that has cost this program four separate false readings — so a stale marker fails
 * the run instead.
 */
const LABEL_CLAUSE_MARKER = "⚠️ A table or stat block's LABELS are not things."
const BASE_FORM_CLAUSE =
  " Name each thing in its BASE form, singular and without an article, exactly once — never both a " +
  "singular and a plural of the same thing."

interface Arm {
  readonly name: string
  readonly system: string
}

const withoutLabelClause = (): string => {
  const at = KbAbsorb.SYSTEM.indexOf(LABEL_CLAUSE_MARKER)
  if (at < 0) throw new Error(`the label clause marker is stale: ${LABEL_CLAUSE_MARKER}`)
  return KbAbsorb.SYSTEM.slice(0, at).trimEnd()
}

const ARMS: ReadonlyArray<Arm> = [
  { name: "shipped", system: KbAbsorb.SYSTEM },
  // Re-judges the label fix: shipped MINUS the clause is the pre-fix prompt.
  { name: "no-label-clause", system: withoutLabelClause() },
  // Re-judges the reverted variant clause: shipped PLUS the clause is what was tried and rolled back.
  { name: "plus-base-form", system: KbAbsorb.SYSTEM + BASE_FORM_CLAUSE },
]

/** How many passages needed the no-thinking fallback — a number worth reading on its own. */
let fallbacks = 0
/**
 * Reasoning tokens each thinking-on call spent, so the fallback rate can be explained rather than
 * guessed at.
 *
 * ⚠️ This exists because the fallback count alone tempts a wrong conclusion. This harness re-issues
 * only on an EMPTY completion, while the product's `ReasoningBudget` nudges at 0.7·budget, again at
 * budget, and only disables thinking past `budget × HARD_RATIO` — so it produces answers in cases
 * this harness scores as a total loss, and its fallback rate is NOT this one. What transfers between
 * the two is the reasoning LENGTH: compare it against 512 (the shipped budget) and 1024 (the hard
 * stop) and you know which phase the product would be in, without claiming to have measured it.
 */
const reasoningTokens: number[] = []

const call = async (system: string, text: string, thinking: boolean): Promise<string> => {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: text }],
      // The shipped request's `maxTokens`. With thinking on, reasoning is spent from this same
      // envelope — which is exactly why the product needs a hard stop, and why this needs one too.
      max_tokens: 2048,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: thinking },
    }),
  })
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>
    usage?: { completion_tokens?: number }
  }
  const message = body.choices?.[0]?.message
  if (thinking) {
    // Prefer the reasoning field's own length; fall back to total completion tokens minus the answer,
    // because a server that folds reasoning into `content` reports no separate field.
    const reasoning = message?.reasoning_content ?? ""
    const answer = message?.content ?? ""
    reasoningTokens.push(
      reasoning !== ""
        ? Math.round(reasoning.length / 4)
        : Math.max(0, (body.usage?.completion_tokens ?? 0) - Math.round(answer.length / 4)),
    )
  }
  return message?.content ?? ""
}

/**
 * One passage, through the shipped SHAPE: thinking on, and on an empty completion re-issued with
 * thinking structurally disabled.
 *
 * 🔴 That second call is not a nicety. The first version of this harness sent one thinking-on request
 * and scored `names 0` on the very first passage — reasoning consumed the whole 2048-token envelope
 * and the content came back empty, the recorded failure mode for a thinking model on a small budget.
 * The product does not sit in that state: `ReasoningBudget` counts reasoning live and its mechanical
 * hard stop re-issues the turn without thinking, which is the owner's ruling for this pass. A harness
 * that omits the recovery measures a configuration the product never lands in — and would have
 * reported every arm as a tie at zero.
 *
 * ⚠️ An EMULATION of that recovery, not the thing itself: it triggers on an empty completion rather
 * than on a live reasoning-token count, so it cannot see a nudge that worked. Good enough to compare
 * two prompts under the same rule; not a substitute for exercising `ReasoningBudget`.
 */
const extract = async (system: string, text: string): Promise<string[]> => {
  let raw = await call(system, text, THINKING)
  if (THINKING && raw.trim() === "") {
    fallbacks++
    raw = await call(system, text, false)
  }
  // ⚠️ The REAL parser, not a regex of my own. A bespoke parser here would measure my parser's
  // tolerance rather than the prompt's output, and the two drift the moment either changes.
  return SessionExtract.parseExtraction(raw, 20)
    .map((fact) => fact.name)
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
}

const mean = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
const spread = (xs: ReadonlyArray<number>) => Math.max(...xs) - Math.min(...xs)

interface ArmResult {
  readonly name: string
  readonly names: ReadonlyArray<number>
  readonly pcts: ReadonlyArray<number>
}

describe.skipIf(CORPUS === "")("absorption variance across repeats", () => {
  test(
    "each arm N times — does any prompt delta clear the noise floor?",
    async () => {
      const document = readFileSync(CORPUS, "utf8")
      const slice = document.slice(45966, 55000)
      const passages = KbChunk.chunk(KbChunk.stripGutenberg(slice))
      const scaffolding = KbAbsorbEval.deriveScaffolding(document)
      console.log(
        `${passages.length} passages × ${REPEATS} repeats × ${ARMS.length} arms, thinking ${THINKING ? "ON" : "off"}`,
      )
      const results: ArmResult[] = []
      for (const arm of ARMS) {
        const names: number[] = []
        const pcts: number[] = []
        for (let i = 0; i < REPEATS; i++) {
          const before = fallbacks
          const extracted: string[] = []
          for (const passage of passages) extracted.push(...(await extract(arm.system, passage)))
          const scored = KbAbsorbEval.score(extracted, scaffolding)
          const pct = (100 * scored.concrete.length) / Math.max(1, scored.total)
          names.push(scored.total)
          pcts.push(pct)
          console.log(
            `${arm.name} run ${i + 1}: names ${scored.total}  concrete ${scored.concrete.length} ` +
              `(${pct.toFixed(0)}%)  scaffolding ${scored.scaffolding.length}  surplusIds ${scored.surplusIds}  ` +
              `no-thinking fallbacks ${fallbacks - before}/${passages.length}`,
          )
          // A run that scored NOTHING is a broken measurement, not a result — and averaging it in
          // would drag an arm's mean toward zero and read as "this prompt is worse".
          if (scored.total === 0) throw new Error(`${arm.name} run ${i + 1} extracted nothing — the harness is broken`)
        }
        results.push({ name: arm.name, names, pcts })
      }
      // The floor is pooled across arms: the widest within-arm spread any arm showed. Using only the
      // control's spread would understate it whenever the control happened to be the steady one.
      //
      // ⚠️ **This floor is NOT comparable across runs with different `REPEATS`, and that is a property
      // of the estimator rather than of the data.** A range (max − min) can only grow as samples are
      // added, so it is biased DOWNWARD at small n: measured on the same corpus, 3 repeats gave names
      // ±29 and 2 repeats gave ±15 — the second is not a quieter model, it is a shorter ruler. Read a
      // verdict here only against the floor printed beside it, and prefer the PAIRED section below,
      // whose standard error has no such dependence.
      // What the product's controller would have been doing, stated as a distribution rather than as
      // a fallback rate this harness cannot measure.
      const sorted = [...reasoningTokens].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0
      const over = (n: number) => sorted.filter((t) => t > n).length
      console.log(
        `\nreasoning tokens over ${sorted.length} thinking-on calls — median ${median}, max ${sorted.at(-1) ?? 0}; ` +
          `over the 512 budget: ${over(512)}, over the 1024 hard stop: ${over(1024)}`,
      )
      const floorNames = Math.max(...results.map((r) => spread(r.names)))
      const floorPct = Math.max(...results.map((r) => spread(r.pcts)))
      console.log(`\nNOISE FLOOR (widest within-arm spread) — names ±${floorNames}, concrete% ±${floorPct.toFixed(1)}`)
      const control = results.find((r) => r.name === "shipped")!
      for (const arm of results) {
        const dNames = mean(arm.names) - mean(control.names)
        const dPct = mean(arm.pcts) - mean(control.pcts)
        const verdict =
          arm.name === "shipped"
            ? "control"
            : Math.abs(dPct) > floorPct || Math.abs(dNames) > floorNames
              ? "CLEARS the floor"
              : "within noise — not evidence"
        console.log(
          `${arm.name}: names ${dNames >= 0 ? "+" : ""}${dNames.toFixed(1)}, concrete% ${dPct >= 0 ? "+" : ""}${dPct.toFixed(1)} → ${verdict}`,
        )
      }
      // ── PAIRED comparison, which is the instrument the unpaired one above showed we need ──────
      //
      // 🔴 Measured 2026-08-12: run-total `names` moved by ±29 within a single arm, on a mean of ~110
      // — **26% noise**. At that width no clause smaller than a redesign can ever clear the floor, and
      // more repeats only shrink it as 1/√n, so the honest reading is that RUN TOTALS ARE THE WRONG
      // UNIT. Most of that variance is between-passage: a stat block and a prose page yield wildly
      // different counts, and a run total re-rolls that mixture every time.
      //
      // Pairing cancels the item effect: the same passage under every arm, differenced within itself.
      //
      // 🔴 …and MEASURED 2026-08-12, it did NOT tighten this question — paired stderr came out at 7.2
      // and 5.2 points, WIDER than the ±3.2 unpaired floor it was meant to beat. The design is fine;
      // the METRIC is wrong to pair on. `concrete%` per passage is a ratio with a tiny denominator —
      // one passage yields a handful of names, so a single label moves it ten or twenty points — and
      // differencing two such percentages compounds that. **A mean of per-item ratios is not the ratio
      // of sums, and for small per-item denominators it is far noisier.**
      //
      // ⚠️ The fix, when this is next run for a verdict: pair on per-passage COUNTS (they add across
      // passages, so their paired difference is well behaved), or pool numerator and denominator and
      // compare ratios of sums. Left as-is because its own output is now the evidence for that, and
      // deleting it would delete the finding.
      // ⚠️ Progress, per passage, because this loop is ~84 model calls and its FIRST version printed
      // nothing until all of them finished. Measured: 50 minutes of silence on a network-bound loop,
      // which is indistinguishable from a hang — I checked CPU (9 s over 81 min, meaningless while
      // blocked on HTTP) and an established keep-alive socket before concluding it was merely quiet.
      // A long run must say it is alive, or its next reader kills it.
      const byPassage = new Map<string, Map<string, number[]>>()
      for (const [index, passage] of passages.entries()) {
        const key = `p${index}`
        const perArm = new Map<string, number[]>()
        console.log(`paired: passage ${index + 1}/${passages.length}`)
        for (const arm of ARMS) {
          const counts: number[] = []
          for (let i = 0; i < REPEATS; i++) {
            const scored = KbAbsorbEval.score(await extract(arm.system, passage), scaffolding)
            counts.push(scored.total === 0 ? 0 : (100 * scored.concrete.length) / scored.total)
          }
          perArm.set(arm.name, counts)
        }
        byPassage.set(key, perArm)
      }
      console.log(`
PAIRED — concrete%, differenced within each passage against \`shipped\`:`)
      for (const arm of ARMS) {
        if (arm.name === "shipped") continue
        const deltas: number[] = []
        for (const perArm of byPassage.values()) {
          const base = mean(perArm.get("shipped") ?? [0])
          deltas.push(mean(perArm.get(arm.name) ?? [0]) - base)
        }
        const m = mean(deltas)
        // The paired spread is the honest floor for a paired claim; quoting the unpaired one here
        // would be borrowing a wider number to make a delta look bigger than its own evidence.
        const sd = Math.sqrt(mean(deltas.map((d) => (d - m) ** 2)))
        const stderr = sd / Math.sqrt(Math.max(1, deltas.length))
        console.log(
          `${arm.name}: mean ${m >= 0 ? "+" : ""}${m.toFixed(1)} points/passage, sd ${sd.toFixed(1)}, ` +
            `stderr ${stderr.toFixed(1)} over ${deltas.length} passages → ` +
            (Math.abs(m) > 2 * stderr ? "CLEARS 2 stderr" : "within 2 stderr — not evidence"),
        )
      }
      expect(results).toHaveLength(ARMS.length)
    },
    { timeout: 120 * 60_000 },
  )
})

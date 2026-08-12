import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { KbAbsorb } from "@novaclaw/core/kb-graph/absorb"
import { KbAbsorbEval } from "@novaclaw/core/kb-graph/absorb-eval"
import { KbChunk } from "@novaclaw/core/kb-graph/chunk"
import { SessionExtract } from "@novaclaw/core/session/runner/extract"

/**
 * ABSORPTION VARIANCE — the measurement every prompt verdict in this program has been missing.
 *
 * ⚠️ Three prompt changes were judged on ONE run each. A single sample cannot separate "the clause
 * helped" from "the model felt different", and an 18-lost/7-gained swing between two runs is exactly
 * the size that decides a verdict. This establishes the noise floor so a future delta can be compared
 * against it instead of against zero.
 *
 * Runs OUTSIDE the gate (`.smoke.ts`) and against a live endpoint: it is a measurement, not a
 * regression test, and it costs one model call per passage per repeat.
 *
 * ⛔ Calls the model directly rather than through `ingest`. What varies between runs is the model, and
 * a server boot per repeat costs ~34 s to measure nothing. The prompt and parser are the REAL ones —
 * `KbAbsorb.SYSTEM` and `SessionExtract.parseExtraction` via `KbAbsorb` — so a prompt edit is what
 * this sees.
 */
const ENDPOINT = process.env["NOVACLAW_EVAL_ENDPOINT"] ?? "http://192.168.178.40:8040/v1/chat/completions"
const MODEL = process.env["NOVACLAW_EVAL_MODEL"] ?? "qwen3.6-35b"
const CORPUS = process.env["NOVACLAW_EVAL_CORPUS"] ?? ""
const REPEATS = Number(process.env["NOVACLAW_EVAL_REPEATS"] ?? 3)

/** One passage, one call, the real prompt. Thinking left ON — the shipped path budgets it. */
const extract = async (text: string): Promise<string[]> => {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: KbAbsorb.SYSTEM }, { role: "user", content: text }],
      max_tokens: 2048,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    }),
  })
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> }
  const raw = body.choices?.[0]?.message?.content ?? ""
  // ⚠️ The REAL parser, not a regex of my own. A bespoke parser here would measure my parser's
  // tolerance rather than the prompt's output, and the two drift the moment either changes.
  return SessionExtract.parseExtraction(raw, 20)
    .map((fact) => fact.name)
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
}

describe.skipIf(CORPUS === "")("absorption variance across repeats", () => {
  test(
    "the same prompt on the same passages, N times — how much does the verdict move?",
    async () => {
      const document = readFileSync(CORPUS, "utf8")
      const slice = document.slice(45966, 55000)
      const passages = KbChunk.chunk(KbChunk.stripGutenberg(slice))
      const scaffolding = KbAbsorbEval.deriveScaffolding(document)
      const runs: KbAbsorbEval.Score[] = []
      for (let i = 0; i < REPEATS; i++) {
        const names: string[] = []
        for (const passage of passages) names.push(...(await extract(passage)))
        const scored = KbAbsorbEval.score(names, scaffolding)
        runs.push(scored)
        const pct = (100 * scored.concrete.length) / Math.max(1, scored.total)
        console.log(
          `run ${i + 1}: names ${scored.total}  concrete ${scored.concrete.length} (${pct.toFixed(0)}%)  ` +
            `scaffolding ${scored.scaffolding.length}  surplusIds ${scored.surplusIds}`,
        )
      }
      const totals = runs.map((r) => r.total)
      const pcts = runs.map((r) => (100 * r.concrete.length) / Math.max(1, r.total))
      const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs)
      console.log(
        `\nNOISE FLOOR over ${REPEATS} runs — names ±${spread(totals)}, concrete% ±${spread(pcts).toFixed(1)}`,
      )
      console.log("⚠️ A prompt delta smaller than this spread is not evidence.")
      expect(runs).toHaveLength(REPEATS)
    },
    { timeout: 30 * 60_000 },
  )
})

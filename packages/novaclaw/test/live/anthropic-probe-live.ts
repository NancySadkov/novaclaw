/**
 * LIVE exercise of the capability probe's `anthropic-messages` arm.
 *
 * The arm shipped assembly-verified only — covered against recorded shapes, never against a server.
 * That gap existed because api.anthropic.com is unreachable here (no paid APIs) and nothing local was
 * thought to speak the envelope. `llama-server` does: it serves `/v1/messages` alongside
 * `/v1/chat/completions`, so the arm can be driven end to end over real HTTP against a real model.
 *
 * ⚠️ This is NOT a substitute for one verdict from api.anthropic.com. It proves the probe builds a
 * request that a real Anthropic-envelope server accepts and reads a real response correctly. It does
 * not prove Anthropic's own server answers the way this one does.
 *
 * Deliberately not a `.test.ts`: it needs a running sidecar, so the gate must not collect it.
 *
 * Start the sidecar the way the app does, then run from `novaclaw/`:
 *   llama-server --model <gguf> --alias qwen3.5-4b-q4-k-m --host 127.0.0.1 --port 11343 \
 *     --ctx-size 8192 --parallel 1 --gpu-layers all --jinja --no-webui
 *   bun packages/novaclaw/test/live/anthropic-probe-live.ts
 */

import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { probeCapabilities, probeCompletion } from "../../src/server/routes/instance/httpapi/handlers/provider"

const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:11343/v1"
const MODEL = process.env.PROBE_MODEL ?? "qwen3.5-4b-q4-k-m"

const main = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const input = { baseURL: BASE, modelID: MODEL, authStyle: "anthropic" as const, headers: {} }

  // The chat rung first, exactly as the handler orders it — the capability rungs are not asked
  // unless a plain completion already came back.
  const completion = yield* probeCompletion(client, input)
  console.log(`chat rung: ${completion.kind}${completion.kind === "failed" ? ` — ${completion.detail}` : ""}`)
  if (completion.kind !== "ok") {
    console.log("⛔ no completion, so the rungs are not asked. Is the sidecar running on", BASE, "?")
    return
  }

  const report = yield* probeCapabilities(client, { ...input, chat: { kind: "supported" } })
  for (const [rung, outcome] of Object.entries(report.outcomes)) {
    const detail = "detail" in outcome && outcome.detail ? ` — ${outcome.detail}` : ""
    const fault = "fault" in outcome && outcome.fault ? `/${outcome.fault}` : ""
    console.log(`  ${rung.padEnd(13)} ${outcome.kind}${fault}${detail}`)
  }
  console.log(`\nchoice: ${report.choice}  (${report.rationale ?? "no rationale"})`)
  console.log(`servedBy: ${report.servedBy ?? "(none reported — expected on this wire)"}`)
}).pipe(Effect.provide(FetchHttpClient.layer))

await Effect.runPromise(main)

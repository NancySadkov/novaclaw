import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * THE REFUSAL SURVIVES THE WORKER BOUNDARY — the join, not the halves.
 *
 * 🔴 The loop bound is computed HOST-side (`core/session/colleague-handoff.ts`) and read by a model
 * running INSIDE a worker. Between them sit four hops, and the reason has to survive all of them:
 *
 *   1. `worker-protocol.ts`  — the `refused` outcome and its `reason` field must exist on the wire
 *   2. `interaction-bridge.ts` — the host must map `Delivery.refused` onto that outcome
 *   3. `services.ts`         — the worker must rebuild it into a `Delivery` rather than DIE
 *   4. `tool/colleague.ts`   — the tool must surface the reason instead of its no-chat sentence
 *
 * Break any one and the bound still fires, still logs nothing wrong, and the sender is told a
 * different, false story: "that colleague has no open chat". It would go on trying to reach somebody
 * it was just stopped from reaching, and every unit test would stay green — this program's
 * both-halves-right-feature-dead shape, which it has now hit three times.
 *
 * ⚠️ Comments are STRIPPED before matching. Every one of these files documents the mechanism at
 * length, so a regex over raw source would pass on the prose describing the code that was deleted.
 */

const read = (...segments: string[]): string => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const raw = readFileSync(path.join(here, "..", "..", "..", ...segments), "utf8")
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

describe("a refused hand-off keeps its reason across the worker boundary", () => {
  test("1. the wire carries a `refused` outcome and a `reason`", () => {
    const source = read("core", "src", "session", "execution", "worker-protocol.ts")
    expect(source).toContain('"refused"')
    expect(source).toMatch(/reason:\s*Schema\.String/)
  })

  test("2. the host maps Delivery.refused onto it", () => {
    const source = read("novaclaw", "src", "session-worker", "interaction-bridge.ts")
    expect(source).toMatch(/refused\s*!==\s*undefined/)
    expect(source).toMatch(/outcome:\s*"refused"/)
  })

  test("3. the worker rebuilds a Delivery instead of dying on it", () => {
    const source = read("novaclaw", "src", "session-worker", "services.ts")
    expect(source).toMatch(/outcome\s*===\s*"refused"/)
    // The arm must SUCCEED. A `die` here costs the sender its whole turn rather than telling it why.
    const arm = source.slice(source.indexOf('outcome === "refused"'))
    expect(arm.slice(0, 240)).toContain("Effect.succeed")
  })

  test("4. the tool raises the reason as a tool FAILURE, not an ok:false result", () => {
    // 🔴 Measured live on holo3.1 2026-08-22. As an `ok: false` result carrying the reason verbatim —
    // the whole chain working — the model read it and told the user *"The message was successfully
    // delivered."* A structured `ok: false` beside a paragraph of prose is a distinction a floor model
    // does not reliably make. Re-driven as a `ToolFailure`, the same model on the same prompt said
    // *"The message was not sent to Theron."*
    const source = read("core", "src", "tool", "colleague.ts")
    expect(source).toMatch(/outcome\.refused\s*!==\s*undefined/)
    const arm = source.slice(source.indexOf("outcome.refused !== undefined"))
    expect(arm.slice(0, 160)).toContain("ToolFailure")
  })
})

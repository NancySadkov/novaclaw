import { expect, test } from "bun:test"
import { Effect } from "effect"
import { runPass, type PassDeps } from "./pass"
import { REFRESH_INTERVAL_MS, type Candidate } from "./refresh"

const HOUR = 60 * 60 * 1000
const now = 1_000 * HOUR
const stale = (agent: string, latest = now - HOUR): Candidate => ({
  agent,
  latest,
  current: { observed: now - REFRESH_INTERVAL_MS - HOUR },
})

function harness(over: Partial<PassDeps> = {}) {
  const written: { agent: string; task: string; observed: number }[] = []
  const asked: string[] = []
  const deps: PassDeps = {
    candidates: () => Effect.succeed([stale("theron")]),
    recent: (agent) => {
      asked.push(agent)
      return Effect.succeed(`user: look at it\nassistant: working on ${agent}`)
    },
    label: (agent) => Effect.succeed(`reviewing ${agent}'s handshake`),
    write: (info) => Effect.sync(() => void written.push(info)),
    now: () => now,
    ...over,
  }
  return { deps, written, asked, run: () => Effect.runSync(runPass(deps)) }
}

test("a due colleague gets a fresh line, keyed on the activity it covers", () => {
  const h = harness()
  expect(h.run()).toEqual({ refreshed: 1, noText: 0, unusable: 0, failed: 0 })
  // ⚠️ `observed` is the ACTIVITY's timestamp, not the clock. Keyed on `now`, a colleague that
  // stopped working would look freshly summarised forever and never settle.
  expect(h.written).toEqual([{ agent: "theron", task: "reviewing theron's handshake", observed: now - HOUR }])
})

test("🔴 a colleague with no text is skipped, not written", () => {
  // Its activity is real — that is why it is due — but it carries no text: tool-only work, say.
  // Asking the model to summarise nothing is how an invented label gets written.
  const h = harness({ recent: () => Effect.succeed(undefined) })
  expect(h.run()).toEqual({ refreshed: 0, noText: 1, unusable: 0, failed: 0 })
  expect(h.written).toEqual([])
})

test("🔴 a model that returns nothing usable leaves the PREVIOUS line standing", () => {
  // `label` already cleans; `undefined` means nothing survived. Writing an empty or placeholder line
  // here is how a colleague ends up described by a failure rather than by their work.
  const h = harness({ label: () => Effect.succeed(undefined) })
  expect(h.run()).toEqual({ refreshed: 0, noText: 0, unusable: 1, failed: 0 })
  expect(h.written).toEqual([])
})

test("🔴 one colleague's failure does not cost the others their update", () => {
  /**
   * A sweep that aborted on the first error would leave the whole roster stale because of one
   * misconfigured agent — and since the order is stalest-first, it would be the same one every time,
   * so the roster would never recover on its own.
   *
   * A/B: drop the per-colleague `catchCause` and this throws instead of returning.
   */
  const h = harness({
    candidates: () => Effect.succeed([stale("broken", now - 3 * HOUR), stale("fine", now - HOUR)]),
    label: (agent) =>
      agent === "broken" ? Effect.die(new Error("model unreachable")) : Effect.succeed("still working"),
  })
  expect(h.run()).toEqual({ refreshed: 1, noText: 0, unusable: 0, failed: 1 })
  expect(h.written.map((w) => w.agent)).toEqual(["fine"])
})

test("nothing due means nothing asked — no model calls at all", () => {
  // The interval is the cost control. A pass that fetched text for every colleague before deciding
  // would do the expensive half of the work it was about to skip.
  const settled: Candidate = { agent: "quiet", latest: now - 50 * HOUR, current: { observed: now - 50 * HOUR } }
  const h = harness({ candidates: () => Effect.succeed([settled]) })
  expect(h.run()).toEqual({ refreshed: 0, noText: 0, unusable: 0, failed: 0 })
  expect(h.asked).toEqual([])
  expect(h.written).toEqual([])
})

test("the stalest colleague is asked first", () => {
  // Order carries through from `due()`: a pass that runs out of budget leaves the freshest lines
  // unrefreshed rather than a random subset.
  const h = harness({
    candidates: () =>
      Effect.succeed([
        { agent: "newer", latest: now - HOUR, current: { observed: now - REFRESH_INTERVAL_MS - HOUR } },
        { agent: "older", latest: now - HOUR, current: { observed: now - REFRESH_INTERVAL_MS - 50 * HOUR } },
      ]),
  })
  h.run()
  expect(h.asked).toEqual(["older", "newer"])
})

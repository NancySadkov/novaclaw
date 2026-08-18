import { afterEach, describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { FAST_CRASH_GIVEUP, LIVENESS_FAILURE_LIMIT, type SuperviseStatus } from "@novaclaw/script/supervise"

/**
 * ── FAULT INJECTION FOR THE SIDECAR SUPERVISOR ───────────────────────────────────────────────────
 *
 * Three stops, and the whole point is that the supervisor CLASSIFIES them differently:
 *
 *   | fault                                   | classification | restarts? | terminal state |
 *   |-----------------------------------------|----------------|-----------|----------------|
 *   | abrupt exit after ready                 | crash          | yes       | —              |
 *   | health probes stop answering            | unresponsive   | yes       | —              |
 *   | `listener.stop()` (quit/relaunch/update)| INTENTIONAL    | **no**    | `stopped`      |
 *   | five fast crashes                       | crash          | bounded   | `gave-up`      |
 *
 * 🔴 **Why an exit code cannot carry this.** Our sidecar exits **0** when the parent asks it to stop,
 * and a buggy build can exit 0 on a real fault; a hung child that gets `kill()`ed reports a NON-zero
 * code for a stop we chose deliberately. So the supervisor latches the intent (`stopping`) at the
 * moment it decides, and rewrites the code before the policy ever sees it. The assertions below are
 * written against that latch rather than against exit codes, because a test that pinned exit codes
 * would pass a rewrite that reintroduced exactly the confusion this design exists to prevent.
 *
 * ⚠️ **The electron mock is a `globalThis` slot, not a closure**, and that is load-bearing. Bun
 * module mocks are process-global and `bun test src` runs `server.test.ts` — which mocks `electron`
 * for its own reasons — in the SAME process. Whichever registration lands last wins, so both files
 * install an equivalent stub that defers to this slot; the winner is then irrelevant. A closure
 * would make the outcome depend on test-file ordering, which changes the day someone adds a file.
 */

const FORK_SLOT = Symbol.for("novaclaw.desktop.test.sidecar-fork")
type ForkHook = () => FakeChild
const slot = globalThis as unknown as Record<symbol, ForkHook | undefined>

void mock.module("electron", () => ({
  default: {},
  app: { on: () => {}, off: () => {}, isPackaged: false },
  utilityProcess: {
    fork: () => {
      const hook = slot[FORK_SLOT]
      if (!hook) throw new Error("no sidecar fork hook installed for this test")
      return hook()
    },
  },
}))
void mock.module("./logging", () => ({ getLogger: () => ({ log: () => {} }) }))
void mock.module("./store", () => ({ getStore: () => ({ get: () => null, set: () => {}, delete: () => {} }) }))

const { superviseLocalServer } = await import("./server")

/** What the sidecar does when the parent says `start`. One knob, set per scenario. */
type Behaviour = "ready" | "ready-then-die"

class FakeChild extends EventEmitter {
  readonly stdout = null
  readonly stderr = null
  killed = false
  constructor(private readonly behaviour: Behaviour) {
    super()
  }
  postMessage(message: { type: string }) {
    if (message.type === "start")
      queueMicrotask(() => {
        this.emit("message", { type: "ready" })
        // A child that dies moments after announcing readiness is the "fast crash" the giveup
        // ladder is counted in — the real shape of a sidecar that boots into a broken dependency.
        if (this.behaviour === "ready-then-die") setTimeout(() => this.emit("exit", 9), 20)
      })
    // The REAL sidecar answers a stop request by exiting 0 — the exit code that must NOT be read as
    // an intent, in either direction.
    if (message.type === "stop") queueMicrotask(() => this.emit("exit", 0))
  }
  kill() {
    this.killed = true
    queueMicrotask(() => this.emit("exit", 1))
  }
}

const PORT = 41391
let healthAnswers = true
const health = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: (request: Request) =>
    new URL(request.url).pathname === "/global/health" && healthAnswers
      ? Response.json({ healthy: true })
      : new Response("down", { status: 503 }),
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function harness(behaviour: Behaviour) {
  const forks: FakeChild[] = []
  const states: SuperviseStatus[] = []
  slot[FORK_SLOT] = () => {
    const child = new FakeChild(behaviour)
    forks.push(child)
    return child
  }
  return {
    forks,
    states,
    setBehaviour: (next: Behaviour) => {
      slot[FORK_SLOT] = () => {
        const child = new FakeChild(next)
        forks.push(child)
        return child
      }
    },
    start: () => superviseLocalServer("127.0.0.1", PORT, "", { onState: (state) => states.push(state) }),
    /** Poll rather than sleep a fixed span: the ladder's own delays are the thing under test. */
    until: async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline && !predicate()) await sleep(50)
      return predicate()
    },
  }
}

afterEach(() => {
  slot[FORK_SLOT] = undefined
  healthAnswers = true
})

describe("sidecar supervisor fault classification", () => {
  test("an abrupt post-ready exit is a CRASH: it restarts, on a bounded delay it reports", async () => {
    const h = harness("ready")
    const supervised = await h.start()
    await supervised.health.wait
    expect(h.forks.length).toBe(1)
    expect(h.states).toEqual([{ phase: "running" }])

    h.forks[0]!.emit("exit", 3)

    expect(await h.until(() => h.forks.length === 2, 8_000)).toBe(true)
    const restarting = h.states.find((state) => state.phase === "restarting")
    expect(restarting).toEqual({ phase: "restarting", reason: "crash", attempt: 1, nextAttemptInMs: 1_000 })
    // …and it comes back, which is the half a user actually experiences.
    expect(await h.until(() => h.states.filter((s) => s.phase === "running").length === 2, 8_000)).toBe(true)
    await supervised.listener.stop()
  }, 30_000)

  test("an INTENTIONAL stop is not a crash: no restart, no fault reason, a `stopped` terminal state", async () => {
    const h = harness("ready")
    const supervised = await h.start()
    await supervised.health.wait
    expect(h.forks.length).toBe(1)
    h.states.length = 0

    await supervised.listener.stop()
    // Generously past the 1s first rung — a restart, if the intent were being inferred from the
    // child's exit code (0), would have happened well inside this window.
    await sleep(2_500)

    expect(h.forks.length).toBe(1)
    expect(h.states).toContainEqual({ phase: "stopped" })
    expect(h.states.some((state) => state.phase === "restarting")).toBe(false)
    expect(h.states.some((state) => state.phase === "gave-up")).toBe(false)
  }, 30_000)

  test("repeated fast crashes are BOUNDED and end in a reported terminal state", async () => {
    const h = harness("ready")
    const supervised = await h.start()
    await supervised.health.wait
    h.setBehaviour("ready-then-die")
    h.forks[0]!.emit("exit", 9)

    expect(await h.until(() => h.states.some((state) => state.phase === "gave-up"), 40_000)).toBe(true)
    expect(h.states.at(-1)).toEqual({ phase: "gave-up", reason: "crash", attempts: FAST_CRASH_GIVEUP - 1 })
    expect(h.forks.length).toBe(FAST_CRASH_GIVEUP)

    // TERMINAL means terminal. The longest rung is 30s, so a ladder that were merely slow rather
    // than stopped would take another child inside this window.
    const settled = h.forks.length
    await sleep(6_000)
    expect(h.forks.length).toBe(settled)
    await supervised.listener.stop()
  }, 90_000)

  test("a hung child is UNRESPONSIVE, a distinct reason from a crash", async () => {
    const h = harness("ready")
    const supervised = await h.start()
    await supervised.health.wait
    // The process stays alive and keeps its handles; only its answers stop. Nothing exits, so an
    // exit-code reading of this fault sees nothing at all until the supervisor forces the issue.
    healthAnswers = false

    expect(
      await h.until(() => h.states.some((state) => state.phase === "restarting"), (LIVENESS_FAILURE_LIMIT + 3) * 3_000),
    ).toBe(true)
    const restarting = h.states.find((state) => state.phase === "restarting")
    expect(restarting).toMatchObject({ phase: "restarting", reason: "unresponsive" })
    expect(h.forks[0]!.killed).toBe(true)
    await supervised.listener.stop()
  }, 60_000)
})

process.on("beforeExit", () => void health.stop(true))

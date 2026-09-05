import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EventV2 } from "@novaclaw/core/event"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import {
  HARNESS_SESSION,
  completeTurn,
  drive,
  makeLatch,
  makeRunnerHarness,
  type RunnerHarness,
} from "./fixture/runner-harness"

/**
 * S2's ADMISSION TEST. Not a ported claim — the thing that must be true before any claim can be
 * ported, and the thing that was false for nine hypotheses: **can this harness drive the real drain to
 * a written assistant message, on win32, without hanging?**
 *
 * The failure it replaces was specific and worth keeping in view: a re-derived graph called the
 * provider, got a canonical complete turn back, wrote **no assistant message**, retried the identical
 * request three times (each carrying `msgs = 1`, so no progress between attempts) and then settled
 * reporting `Exit { _tag: "Success" }`. If this file goes red in that shape again, the harness is the
 * suspect, not the claim under test.
 */

describe("the harness drives the real drain", () => {
  test("🔴 S2 admission — one scripted turn writes one assistant message", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("text-1", "Hello from the drain.")] })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Say hello" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "S2 admission — scripted turn",
    )

    // ① The assistant message EXISTS. This is the assertion the re-derived graph could never satisfy.
    expect(context).toMatchObject([
      { type: "user", text: "Say hello" },
      { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-1", text: "Hello from the drain." }] },
    ])
    // ② And exactly ONE INTERACTIVE provider request. The old symptom was identical retries reported as
    // a successful drain, so a passing ① with a request count above 1 would still be the bug.
    //
    // 🔴 This doubles as the OUT_OF_BAND exhaustiveness ratchet. A plain scripted turn triggers the
    // post-drain passes too; if a new one is added to the runner and not classified in the harness, it
    // lands here as an interactive request and this line goes red **naming the file to fix** — instead
    // of silently skewing every count assertion in the suite and consuming the next test's scripted
    // turn, which is exactly how the old fixture rotted (memory extraction, added after it was
    // written, is why the Linux run reported `toHaveLength(1)` receiving 2).
    expect(harness.requests, "a completed turn must not be retried").toHaveLength(1)
    // The maintenance pass DID run — so the assertion above is passing because it was classified, not
    // because it never happened. Without this, deleting the classification would look like a fix.
    expect(harness.maintenanceRequests, "post-drain maintenance must be classified, not absent").toHaveLength(1)
  })

  test("🔴 the session goes idle BEFORE post-drain maintenance, not after it", async () => {
    /**
     * The user's answer is finished when the drain's turn loop ends. What runs after it —
     * the changes summary, the auto-title, memory extraction — is OUR housekeeping, and two of the
     * three are model calls, so on a local endpoint it takes tens of seconds. While the session
     * stayed `busy` through them, the transcript kept showing "Working…" over a phase list from a
     * turn that had already ended: a spinner for work the user never asked for and cannot see.
     *
     * The claim is an ORDERING one, so the timeline records each status against how many
     * maintenance requests had been issued when it was published. `idle@0` is the whole point —
     * idle reached the client before the first maintenance model call went out.
     */
    const harness = makeRunnerHarness({
      turns: [completeTurn("text-1", "Answer.")],
      maintenanceTurns: [[]],
    })
    const timeline: string[] = []

    await drive(
      harness,
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        // `startsWith`, because a payload's `type` carries the schema VERSION suffix.
        yield* events.listen((event) =>
          Effect.sync(() => {
            if (!event.type.startsWith("session.status")) return
            const status = (event.data as { status?: { type?: string } } | undefined)?.status
            if (status?.type) timeline.push(`${status.type}@${harness.maintenanceRequests.length}`)
          }),
        )
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Say hello" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
      }),
      "idle before post-drain maintenance",
    )

    // The maintenance pass ran — otherwise the ordering claim below would be vacuously true.
    expect(harness.maintenanceRequests, "post-drain maintenance must actually run").toHaveLength(1)
    // Joined, so a failure prints the whole ordering instead of "array did not contain".
    expect(timeline.join(" → ")).toContain("idle@0")
    // And nothing re-opened the session afterwards: no busy is published once maintenance is under way.
    expect(timeline.filter((entry) => entry.startsWith("busy@1")).join(" → ")).toBe("")
  })

  test("two harnesses in one file do not share a drain", async () => {
    // The per-test-state property, asserted through the real graph rather than on the arrays alone:
    // each harness gets its own database, its own session row and its own request log.
    const first = makeRunnerHarness({ turns: [completeTurn("text-a", "First.")] })
    const second = makeRunnerHarness({ turns: [completeTurn("text-b", "Second.")] })

    const run = (harness: RunnerHarness, text: string, label: string) =>
      drive(
        harness,
        Effect.gen(function* () {
          const session = yield* SessionV2.Service
          yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text }), resume: false })
          yield* session.resume(HARNESS_SESSION)
          return yield* session.context(HARNESS_SESSION)
        }),
        label,
      )

    const a = await run(first, "Ask first", "isolation — first")
    const b = await run(second, "Ask second", "isolation — second")

    expect(a).toMatchObject([{ type: "user", text: "Ask first" }, { content: [{ text: "First." }] }])
    expect(b).toMatchObject([{ type: "user", text: "Ask second" }, { content: [{ text: "Second." }] }])
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
  })
})

/**
 * ``'s Fast Chat gate ends *"hidden startup work is timed and user-interruptible"*.
 * Timed it plainly is — the receipt renders every stage. INTERRUPTIBLE was assumed: the stages run
 * inside the drain fiber, and an interrupt kills that fiber, so it follows. Nothing tested it, and
 * the one live observation was an interrupt AFTER `provider-prefill`, which is past the startup work
 * the clause is about.
 *
 * `systemLoadHook` runs inside the system-context load — a pre-provider stage — so holding it open is
 * exactly the window a user would be waiting through when they press stop.
 */
describe("hidden startup work is interruptible", () => {
  test("an interrupt DURING system-context load stops the turn before the provider is called", async () => {
    const reached = makeLatch()
    const release = makeLatch()
    const harness = makeRunnerHarness({ turns: [completeTurn("text-1", "should never be produced")] })
    harness.controls.systemLoadHook = Effect.promise(async () => {
      reached.open()
      await release.promise
    })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Say hello" }),
          resume: false,
        })
        // `Effect.race` INTERRUPTS the loser, which is exactly the mechanism under test: the turn
        // runs until the hook parks it inside the load, the racer then wins, and the runner's fiber
        // takes a real interrupt at that point.
        yield* Effect.race(
          session.resume(HARNESS_SESSION),
          Effect.promise(() => reached.promise),
        )
        // Let the parked hook go so nothing leaks past the test.
        release.open()
      }),
      "startup interruptibility",
    )

    // ⚠️ THE assertion, and the reason this test is worth its length: the provider was never called.
    // A turn that is "interruptible" only after prefill would still make a user who pressed stop
    // during startup pay for a whole request — which is the cost the gate is about.
    expect(harness.requests, "interrupting during startup must not reach the provider").toHaveLength(0)
  })
})

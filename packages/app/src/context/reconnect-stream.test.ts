import { describe, expect, test } from "bun:test"
import type { NovaclawClient, SessionMessage } from "@novaclaw/sdk/v2/client"
import { reconnectingPromptAttempt } from "@/components/prompt-input/connection-state"
import { createNativeMessageStore } from "./global-sync/message-v2-store"
import { createSdkForServer } from "@/utils/server"
import { runReconnectingStream, waitForStreamRetry, type ReconnectStreamState } from "./reconnect-stream"

async function* oneEvent<T>(event: T, after?: () => void): AsyncGenerator<T> {
  yield event
  after?.()
}

async function* noEvents<T>(): AsyncGenerator<T> {}

/**
 * A `wait` that records the delay it was asked for, and separately every delay the start window CUT.
 *
 * ⚠️ The one-tick fallback is load-bearing: a wait that is never cut must still resolve, or a missing
 * release shows up as a hung suite instead of as a wrong number. Measuring a release by a flag is only
 * trustworthy when not being released is cheap to observe.
 */
function measuredWait(delays: number[], cut: number[]): (ms: number, signal?: AbortSignal) => Promise<void> {
  return (ms, signal) => {
    delays.push(ms)
    if (signal?.aborted) {
      cut.push(ms)
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}

test("page suspension cancels a backed-off retry so its replacement can start immediately", async () => {
  const controller = new AbortController()
  const pending = waitForStreamRetry(30_000, controller.signal)
  controller.abort()
  await pending
  await waitForStreamRetry(30_000, controller.signal)
}, 100)

describe("runReconnectingStream", () => {
  test("a finished start abandons the sleep in progress AND discards the failures it was repeating", async () => {
    // 🔴 This is the 29 seconds measured 2026-09-28. The client burned attempts against a port that
    // was not bound, backed off, and stayed asleep through the moment the server came up. Two things
    // have to be true for that to stop, and this case pins both: the sleep in progress is RELEASED,
    // and the count it was repeating is DISCARDED — because a delay has no memory, and the memory is
    // the count. Asserting only the release would leave the first genuine outage after a slow boot
    // starting from a 30-second backoff it never earned.
    let active = true
    let opens = 0
    const startWindow = new AbortController()
    const delays: number[] = []
    const cut: number[] = []

    await runReconnectingStream({
      active: () => active,
      open: async () => {
        opens += 1
        // The shell reports the instance up on the fourth attempt, and only then does it answer.
        if (opens === 4) startWindow.abort()
        if (opens <= 5) throw new Error("sidecar not listening")
        return oneEvent("sync")
      },
      recover: async () => {},
      accept: () => {
        active = false
      },
      wait: measuredWait(delays, cut),
      delay: (failure) => failure * 1000,
      state: () => {},
      retryNow: () => startWindow.signal,
    })

    // The 3000ms sleep was cut rather than served...
    expect(delays).toEqual([0, 1000, 2000, 3000, 0])
    expect(cut).toEqual([3000])
    // ...and the attempt after it starts from zero, not from the count that was thrown away.
    expect(opens).toBe(6)
  })

  test("a spent start window is not honoured twice, so a finished start cannot become a spin", async () => {
    // The same window stays aborted for the rest of the page's life. Consulting it on every wait would
    // cut every wait short and retry flat out — the four-hertz storm `reconnect-schedule` was written
    // to prevent. It is honoured once, and a LATER start is a different signal and is honoured too.
    let active = true
    let opens = 0
    const first = new AbortController()
    const second = new AbortController()
    const delays: number[] = []
    const cut: number[] = []

    await runReconnectingStream({
      active: () => active,
      open: async () => {
        opens += 1
        if (opens === 2) first.abort()
        // A crash and a restart: the shell opens a NEW window for the new start.
        if (opens === 4) second.abort()
        if (opens <= 5) throw new Error("sidecar not listening")
        return oneEvent("sync")
      },
      recover: async () => {},
      accept: () => {
        active = false
      },
      wait: measuredWait(delays, cut),
      delay: (failure) => failure * 1000,
      state: () => {},
      retryNow: () => (opens <= 3 ? first : second).signal,
    })

    // Exactly one release per window, and NONE on the waits in between — the counts restart at 0 and
    // the spent window stops being consulted, which is what keeps this from becoming a spin.
    expect(delays).toEqual([0, 1000, 0, 1000, 0])
    expect(cut).toEqual([1000, 1000])
    expect(opens).toBe(6)
  })

  test("no supervisor means no window, so a down instance keeps every bit of its backoff", async () => {
    // The protection this change must not cost. An instance that is simply down never passes through
    // `starting`, so no window is ever opened and the ladder keeps its full restraint.
    let active = true
    let opens = 0
    const failures: number[] = []

    await runReconnectingStream({
      active: () => active,
      open: async () => {
        opens += 1
        if (opens <= 4) throw new Error("connection refused")
        return oneEvent("sync")
      },
      recover: async () => {},
      accept: () => {
        active = false
      },
      wait: async () => {},
      delay: (failure) => {
        failures.push(failure)
        return 0
      },
      state: () => {},
      retryNow: () => undefined,
    })

    expect(failures).toEqual([0, 1, 2, 3])
    expect(opens).toBe(5)
  })

  test("an attempt aborted during recovery retries while its owner is still active", async () => {
    let active = true
    let opens = 0
    let controller!: AbortController
    const states: Array<[ReconnectStreamState, number]> = []
    const accepted: string[] = []

    await runReconnectingStream({
      active: () => active,
      open: async () => oneEvent(`attempt-${++opens}`),
      recover: async () => {
        if (opens === 1) controller.abort()
      },
      accept: (event) => {
        accepted.push(event)
        active = false
      },
      wait: async () => {},
      delay: () => 0,
      state: (status, attempt) => states.push([status, attempt]),
      attemptStarted: (value) => (controller = value),
    })

    expect(opens).toBe(2)
    expect(accepted).toEqual(["attempt-2"])
    expect(states).toEqual([
      ["reconnecting", 1],
      ["connected", 0],
    ])
  })

  test("stopping an active stream discards events already buffered by the transport", async () => {
    let active = true
    const accepted: string[] = []

    await runReconnectingStream({
      active: () => active,
      open: async () =>
        (async function* () {
          yield "current"
          yield "stale"
        })(),
      recover: async () => {},
      accept: (event) => {
        accepted.push(event)
        active = false
      },
      wait: async () => {},
      delay: () => 0,
      state: () => {},
    })

    expect(accepted).toEqual(["current"])
  })

  test("keeps retrying, publishes every one-based attempt, and resets only after recovery", async () => {
    let active = true
    let opens = 0
    let recoveries = 0
    const states: Array<[ReconnectStreamState, number]> = []

    await runReconnectingStream({
      active: () => active,
      open: async () => {
        opens += 1
        if (opens <= 6) throw new Error("sidecar unavailable")
        if (opens <= 12) return noEvents<string>()
        return oneEvent("sync")
      },
      recover: async () => {
        recoveries += 1
      },
      accept: () => {
        active = false
      },
      wait: async () => {},
      delay: (failure) => failure,
      state: (status, attempt) => states.push([status, attempt]),
    })

    expect(opens).toBe(13)
    expect(recoveries).toBe(1)
    expect(states).toEqual([
      ...Array.from({ length: 12 }, (_, index): [ReconnectStreamState, number] => ["reconnecting", index + 1]),
      ["connected", 0],
    ])
  })

  test("a successful connection that closes quickly does not reset retry backoff", async () => {
    let active = true
    let opens = 0
    const delays: number[] = []
    const states: Array<[ReconnectStreamState, number]> = []

    await runReconnectingStream({
      active: () => active,
      open: async () => oneEvent(++opens),
      recover: async () => {},
      accept: () => {},
      wait: async () => {},
      delay: (failure) => {
        delays.push(failure)
        return 0
      },
      state: (status, attempt) => {
        states.push([status, attempt])
        if (status === "reconnecting" && attempt === 3) active = false
      },
    })

    expect(opens).toBe(3)
    expect(delays).toEqual([0, 1, 2])
    expect(states).toEqual([
      ["connected", 0],
      ["reconnecting", 1],
      ["connected", 0],
      ["reconnecting", 2],
      ["connected", 0],
      ["reconnecting", 3],
    ])
  })

  test("retry backoff resets after a stream remains stable for thirty seconds", async () => {
    let active = true
    let opens = 0
    let clock = 0
    const delays: number[] = []

    await runReconnectingStream({
      active: () => active,
      open: async () => oneEvent(++opens),
      recover: async () => {},
      accept: () => {
        if (opens === 1) clock += 1
        else if (opens === 2) clock += 30_000
        else clock += 1
      },
      wait: async () => {},
      delay: (failure) => {
        delays.push(failure)
        return 0
      },
      state: (status, attempt) => {
        if (status === "reconnecting" && attempt === 2) active = false
      },
      now: () => clock,
    })

    expect(opens).toBe(3)
    expect(delays).toEqual([0, 0, 1])
  })

  test("a hanging open is retried, not parked, once the attempt deadline aborts it", async () => {
    // A HALF-OPEN connection: `open()` never settles on its own. `runReconnectingStream` awaits it
    // with no timeout, so only an abort from `attemptStarted` can hand control back to the loop.
    // `server-sdk.tsx` arms its 15s heartbeat there for exactly that reason. Without it the loop parks
    // forever, and nothing reports it: `state("reconnecting")` is published only AFTER `open()`
    // settles, so the reconnect banner never appears and no retry is ever attempted.
    //
    // Measured 2026-09-12 in log/novaclaw.log: the global event stream for run=655af8cd went
    // `disconnected` at 08:06:49.885Z and the next subscription did not arrive until 11:00:37.777Z —
    // 2h53m48s dead, with no retry in between.
    let active = true
    let opens = 0
    const states: Array<[ReconnectStreamState, number]> = []

    await runReconnectingStream<string>({
      active: () => active,
      open: (signal) =>
        new Promise<AsyncIterable<string>>((_resolve, reject) => {
          opens += 1
          signal.addEventListener("abort", () => reject(new Error("aborted")))
        }),
      recover: async () => {},
      accept: () => {},
      wait: async () => {},
      delay: () => 0,
      state: (status, attempt) => {
        states.push([status, attempt])
        if (attempt >= 2) active = false
      },
      attemptStarted: (controller) => {
        setTimeout(() => controller.abort(), 0)
      },
    })

    expect(opens).toBe(2)
    expect(states).toEqual([
      ["reconnecting", 1],
      ["reconnecting", 2],
    ])
  })

  test("does not expose connected or consume an event until recovery has settled", async () => {
    let active = true
    let release!: () => void
    let entered!: () => void
    const recoveryEntered = new Promise<void>((resolve) => (entered = resolve))
    const recoveryPending = new Promise<void>((resolve) => (release = resolve))
    const states: Array<[ReconnectStreamState, number]> = []
    const accepted: string[] = []

    const running = runReconnectingStream({
      active: () => active,
      open: async () => oneEvent("sync"),
      recover: async () => {
        entered()
        await recoveryPending
      },
      accept: (event) => {
        accepted.push(event)
        active = false
      },
      wait: async () => {},
      delay: () => 0,
      state: (status, attempt) => states.push([status, attempt]),
    })

    await recoveryEntered
    expect(states).toEqual([])
    expect(accepted).toEqual([])
    release()
    await running
    expect(states).toEqual([["connected", 0]])
    expect(accepted).toEqual(["sync"])
  })

  test("a failed recovery becomes another retry and cannot publish connected", async () => {
    let active = true
    let recoveries = 0
    const states: Array<[ReconnectStreamState, number]> = []

    await runReconnectingStream({
      active: () => active,
      open: async () => oneEvent("sync"),
      recover: async () => {
        recoveries += 1
        if (recoveries === 1) throw new Error("transcript still unavailable")
      },
      accept: () => {
        active = false
      },
      wait: async () => {},
      delay: () => 0,
      state: (status, attempt) => states.push([status, attempt]),
    })

    expect(recoveries).toBe(2)
    expect(states).toEqual([
      ["reconnecting", 1],
      ["connected", 0],
    ])
  })

  test("stopping during recovery cannot resurrect a stale connected state", async () => {
    let active = true
    let release!: () => void
    let entered!: () => void
    let controller: AbortController | undefined
    const recoveryEntered = new Promise<void>((resolve) => (entered = resolve))
    const recoveryPending = new Promise<void>((resolve) => (release = resolve))
    const states: Array<[ReconnectStreamState, number]> = []
    const accepted: string[] = []

    const running = runReconnectingStream({
      active: () => active,
      open: async () => oneEvent("sync"),
      recover: async () => {
        entered()
        await recoveryPending
      },
      accept: (event) => {
        accepted.push(event)
      },
      wait: async () => {},
      delay: () => 0,
      state: (status, attempt) => states.push([status, attempt]),
      attemptStarted: (value) => (controller = value),
    })

    await recoveryEntered
    active = false
    controller?.abort()
    release()
    await running

    expect(states).toEqual([])
    expect(accepted).toEqual([])
  })

  test("a simulated stream loss restores the authoritative transcript before restoring the prompt", async () => {
    const before = [{ id: "msg_1", type: "user", text: "before", time: { created: 1 } }] as SessionMessage[]
    const after = [...before, { id: "msg_2", type: "assistant", content: [], time: { created: 2 } }] as SessionMessage[]
    let serverMessages = before
    const client = {
      v2: {
        session: {
          async messages() {
            return { data: { data: serverMessages } }
          },
        },
      },
    } as unknown as NovaclawClient
    const messages = createNativeMessageStore(client)
    await messages.load("ses_chat")

    let active = true
    let opens = 0
    const presentation: Array<number | undefined> = []
    const visibleTranscripts: string[][] = []

    await runReconnectingStream({
      active: () => active,
      open: async () => {
        opens += 1
        if (opens === 1) return oneEvent("sync", () => (serverMessages = after))
        return oneEvent("sync")
      },
      recover: () => messages.reconcileAll(),
      accept: () => {
        visibleTranscripts.push(messages.messages("ses_chat")!.map((message) => message.id))
        if (opens === 2) active = false
      },
      wait: async () => {},
      delay: () => 0,
      state: (status, attempt) => presentation.push(reconnectingPromptAttempt(status, attempt)),
    })

    expect(opens).toBe(2)
    expect(presentation).toEqual([undefined, 1, undefined])
    expect(visibleTranscripts).toEqual([["msg_1"], ["msg_1", "msg_2"]])
  })

  test("a stalled transcript read is cancelled with its attempt and cannot overwrite the recovery", async () => {
    const before = [{ id: "msg_1", type: "user", text: "before", time: { created: 1 } }] as SessionMessage[]
    const after = [...before, { id: "msg_2", type: "user", text: "after", time: { created: 2 } }] as SessionMessage[]
    let calls = 0
    let controller!: AbortController
    let stale!: (value: unknown) => void
    let requestSignal: AbortSignal | undefined
    const client = {
      v2: {
        session: {
          messages: (_input: unknown, options: { signal: AbortSignal }) => {
            calls++
            if (calls === 2) {
              requestSignal = options.signal
              queueMicrotask(() => controller.abort())
              // Model a desktop bridge that ignores its fetch signal.
              return new Promise((resolve) => (stale = resolve))
            }
            return Promise.resolve({ data: { data: calls === 1 ? before : after } })
          },
        },
      },
    } as unknown as NovaclawClient
    const messages = createNativeMessageStore(client)
    await messages.load("s")
    let active = true
    let opens = 0

    await runReconnectingStream({
      active: () => active,
      open: async () => oneEvent(++opens),
      recover: (signal) => messages.reconcileAll(signal),
      accept: () => {
        active = false
      },
      wait: async () => {},
      delay: () => 0,
      state: () => {},
      attemptStarted: (value) => (controller = value),
    })

    expect(opens).toBe(2)
    expect(requestSignal?.aborted).toBe(true)
    expect(messages.messages("s")?.map((row) => row.id)).toEqual(["msg_1", "msg_2"])
    stale({ data: { data: before } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(messages.messages("s")?.map((row) => row.id)).toEqual(["msg_1", "msg_2"])
  })

  test("an actual SDK stream failure returns retry ownership and runs recovery before new events", async () => {
    const encoder = new TextEncoder()
    let socket!: ReadableStreamDefaultController<Uint8Array>
    let connections = 0
    const sdk = createSdkForServer({
      server: { url: "http://instance.test" },
      fetch: (async () => {
        connections++
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              socket = controller
              controller.enqueue(encoder.encode('data: {"payload":{"type":"sync"}}\n\n'))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }) as unknown as typeof fetch,
    })
    let active = true
    let recoveries = 0
    const states: Array<[ReconnectStreamState, number]> = []

    await runReconnectingStream({
      active: () => active,
      open: async (signal) =>
        (
          await sdk.global.event({
            signal,
            sseMaxRetryAttempts: 1,
          })
        ).stream,
      recover: async () => {
        recoveries++
      },
      accept: () => {
        if (connections === 1) socket.error(new Error("socket lost"))
        else {
          active = false
          socket.close()
        }
      },
      wait: async () => {},
      delay: () => 0,
      state: (status, attempt) => states.push([status, attempt]),
    })

    expect(connections).toBe(2)
    expect(recoveries).toBe(2)
    expect(states).toEqual([
      ["connected", 0],
      ["reconnecting", 1],
      ["connected", 0],
    ])
  })
})

import { describe, expect, test } from "bun:test"
import type { NovaclawClient, SessionMessage } from "@novaclaw/sdk/v2/client"
import { reconnectingPromptAttempt } from "@/components/prompt-input/connection-state"
import { createNativeMessageStore } from "./global-sync/message-v2-store"
import { runReconnectingStream, type ReconnectStreamState } from "./reconnect-stream"

async function* oneEvent<T>(event: T, after?: () => void): AsyncGenerator<T> {
  yield event
  after?.()
}

async function* noEvents<T>(): AsyncGenerator<T> {}

describe("runReconnectingStream", () => {
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
})

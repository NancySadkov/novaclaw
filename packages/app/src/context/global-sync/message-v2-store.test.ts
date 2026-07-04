import { describe, expect, test } from "bun:test"
import type { NovaclawClient, SessionMessage, V2Event } from "@novaclaw/sdk/v2/client"
import { createNativeMessageStore } from "./message-v2-store"

function ev(type: string, data: Record<string, unknown>): V2Event {
  return { id: `evt_${type}`, type, data } as unknown as V2Event
}
function clientReturning(messages: SessionMessage[]): NovaclawClient {
  return {
    v2: { session: { async messages() { return { data: { data: messages } } } } },
  } as unknown as NovaclawClient
}
const noClient = {} as NovaclawClient
const MODEL = { providerID: "spark", id: "qwen3.6-35b" }
const prompted = (sessionID: string, messageID: string, text = "hi") =>
  ev("session.next.prompted", { timestamp: 1, sessionID, messageID, prompt: { text, files: [], agents: [] } })
const stepStarted = (sessionID: string, assistantMessageID: string, ts = 2) =>
  ev("session.next.step.started", { timestamp: ts, sessionID, assistantMessageID, agent: "build", model: MODEL })

describe("createNativeMessageStore", () => {
  test("apply folds a session.next.* sequence into per-session messages", () => {
    const store = createNativeMessageStore(noClient)
    store.apply(prompted("s", "msg_u"))
    store.apply(stepStarted("s", "msg_a"))
    store.apply(ev("session.next.text.started", { timestamp: 3, sessionID: "s", assistantMessageID: "msg_a", textID: "t1" }))
    store.apply(ev("session.next.text.delta", { timestamp: 4, sessionID: "s", assistantMessageID: "msg_a", textID: "t1", delta: "hey" }))

    const messages = store.messages("s")!
    expect(messages.map((m) => m.id)).toEqual(["msg_u", "msg_a"])
    const a = messages[1]!
    if (a.type === "assistant" && a.content[0]?.type === "text") expect(a.content[0].text).toBe("hey")
  })

  test("apply routes by sessionID and ignores non-session.next events", () => {
    const store = createNativeMessageStore(noClient)
    store.apply(prompted("s1", "m1", "a"))
    store.apply(prompted("s2", "m2", "b"))
    store.apply(ev("session.status", { sessionID: "s1", status: { type: "idle" } }))
    expect(store.messages("s1")!.map((m) => m.id)).toEqual(["m1"])
    expect(store.messages("s2")!.map((m) => m.id)).toEqual(["m2"])
  })

  test("load bootstraps from the native fetch, then live apply extends it", async () => {
    const fetched = [{ id: "msg_1", type: "user", text: "hi", time: { created: 1 } }] as SessionMessage[]
    const store = createNativeMessageStore(clientReturning(fetched))
    await store.load("s")
    expect(store.messages("s")!.map((m) => m.id)).toEqual(["msg_1"])
    store.apply(stepStarted("s", "msg_a"))
    expect(store.messages("s")!.map((m) => m.id)).toEqual(["msg_1", "msg_a"])
  })

  test("evict drops a session's messages", () => {
    const store = createNativeMessageStore(noClient)
    store.apply(prompted("s", "m1"))
    store.evict("s")
    expect(store.messages("s")).toBeUndefined()
  })
})

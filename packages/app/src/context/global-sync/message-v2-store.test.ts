import { describe, expect, test } from "bun:test"
import type { NovaclawClient, SessionMessage, V2Event } from "@novaclaw/sdk/v2/client"
import { createNativeMessageStore } from "./message-v2-store"

function ev(type: string, data: Record<string, unknown>): V2Event {
  return { id: `evt_${type}`, type, data } as unknown as V2Event
}
function clientReturning(messages: SessionMessage[]): NovaclawClient {
  return {
    v2: {
      session: {
        async messages() {
          return { data: { data: messages } }
        },
      },
    },
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
    store.apply(
      ev("session.next.text.started", { timestamp: 3, sessionID: "s", assistantMessageID: "msg_a", textID: "t1" }),
    )
    store.apply(
      ev("session.next.text.delta", {
        timestamp: 4,
        sessionID: "s",
        assistantMessageID: "msg_a",
        textID: "t1",
        delta: "hey",
      }),
    )

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

describe("optimistic user messages", () => {
  const optimisticUser = (id: string, text: string, created = Date.now()): SessionMessage =>
    ({ id, type: "user", text, time: { created } }) as unknown as SessionMessage

  test("a sent prompt is on screen before the server has echoed anything", () => {
    // The defect this exists for: sendFollowupDraft awaits the worktree (five minutes, budgeted),
    // possibly a switchModel and a switchAgent, and only then POSTs — so the user's own words were
    // nowhere until the echo came back, which reads as "it disappeared".
    const store = createNativeMessageStore(noClient)
    store.optimistic("s", optimisticUser("msg_u", "deploy the thing"))
    expect(store.messages("s")?.map((m) => m.id)).toEqual(["msg_u"])
    expect(store.messages("s")?.[0]).toMatchObject({ type: "user", text: "deploy the thing" })
  })

  test("the server's echo lands on the SAME row instead of beside it", () => {
    // The id is the one the client already sends as prompt({id}), so the echo is the same message.
    // A second row here would be the bug wearing the opposite coat: the user sees it twice.
    const store = createNativeMessageStore(noClient)
    store.optimistic("s", optimisticUser("msg_u", "deploy the thing"))
    store.apply(prompted("s", "msg_u", "deploy the thing"))
    expect(store.messages("s")?.length).toBe(1)
  })

  test("a failed send takes the row back", () => {
    // Otherwise the fix trades a MISSING message for a LYING one, which is worse — the user believes
    // it landed, and the composer has already restored the text for a retry.
    const store = createNativeMessageStore(noClient)
    store.optimistic("s", optimisticUser("msg_u", "deploy the thing"))
    store.forget("s", "msg_u")
    expect(store.messages("s")).toEqual([])
  })

  test("forgetting an id that is not there, or a session that is not there, is a no-op", () => {
    const store = createNativeMessageStore(noClient)
    store.forget("never-seen", "msg_u")
    store.optimistic("s", optimisticUser("msg_u", "one"))
    store.forget("s", "msg_other")
    expect(store.messages("s")?.map((m) => m.id)).toEqual(["msg_u"])
  })

  test("🔴 the row SURVIVES an authoritative reconcile — this is the constraint that fails silently", async () => {
    // mergeNativeMessages drops a local row only when it is both withinPage AND predatesFetch, and a
    // MISSING time.created makes predatesFetch true. So an optimistic row without a real timestamp
    // appears and then blinks out on the next reconcile — strictly worse than the bug being fixed,
    // and invisible to every other test here. This pins the timestamp as load-bearing.
    const store = createNativeMessageStore(clientReturning([]))
    store.optimistic("s", optimisticUser("msg_u", "deploy the thing", Date.now() + 60_000))
    await store.load("s")
    expect(store.messages("s")?.map((m) => m.id), "an in-flight prompt must survive a reconcile").toEqual([
      "msg_u",
    ])
  })
})

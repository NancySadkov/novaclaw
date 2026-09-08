import { describe, expect, test } from "bun:test"
import type { NovaclawClient, SessionMessage, V2Event } from "@novaclaw/sdk/v2/client"
import { createNativeMessageStore } from "./message-v2-store"
import { isOptimistic } from "@novaclaw/session-ui/v2/message-fold"

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

  test("🔴 a deleted chat's transcript leaves the store on the event, with no caller in between", () => {
    const store = createNativeMessageStore(noClient)
    store.apply(prompted("s", "m1"))
    store.apply(prompted("kept", "m2"))
    store.apply(ev("session.deleted", { info: { id: "s" } }))
    expect(store.messages("s")).toBeUndefined()
    expect(store.messages("kept")!.map((m) => m.id)).toEqual(["m2"])
  })

  test("archiving drops it too; an ordinary update does not", () => {
    const store = createNativeMessageStore(noClient)
    store.apply(prompted("s", "m1"))
    store.apply(ev("session.updated", { info: { id: "s", time: { created: 1 } } }))
    expect(store.messages("s")!.map((m) => m.id)).toEqual(["m1"])
    store.apply(ev("session.updated", { info: { id: "s", time: { created: 1, archived: 2 } } }))
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
    expect(
      store.messages("s")?.map((m) => m.id),
      "an in-flight prompt must survive a reconcile",
    ).toEqual(["msg_u"])
  })
})

describe("the optimistic row settles when the server confirms it", () => {
  const optimisticUser = (id: string, text: string): SessionMessage =>
    ({
      id,
      type: "user",
      text,
      time: { created: Date.now() },
      metadata: { novaclawOptimistic: true },
    }) as unknown as SessionMessage

  test("the echo REPLACES the pending row rather than being ignored by it", () => {
    // appendMessage skips an id it already holds — which is what stops the echo duplicating the row,
    // and would ALSO have left it marked pending forever, with the client's text and timestamp
    // standing in for the server's. "Sending" has to become "sent" on the event that proves it.
    const store = createNativeMessageStore(noClient)
    store.optimistic("s", optimisticUser("msg_u", "deploy the thing"))
    expect(store.messages("s")?.[0]).toMatchObject({ metadata: { novaclawOptimistic: true } })

    store.apply(prompted("s", "msg_u", "deploy the thing"))

    const rows = store.messages("s") ?? []
    expect(rows.length, "still exactly one row").toBe(1)
    expect(isOptimistic(rows[0]), "the pending mark must be gone once the server has it").toBe(false)
  })

  test("an echo for a message we never showed optimistically is folded normally", () => {
    // The replace path must not eat ordinary prompts — e.g. one sent from another device.
    const store = createNativeMessageStore(noClient)
    store.apply(prompted("s", "msg_elsewhere", "from my phone"))
    expect(store.messages("s")?.map((m) => m.id)).toEqual(["msg_elsewhere"])
  })

  test("a NON-optimistic row with the same id is left alone", () => {
    // Only rows we marked may be replaced; anything else keeps appendMessage's dedupe semantics.
    const store = createNativeMessageStore(noClient)
    store.apply(prompted("s", "msg_u", "first"))
    store.apply(prompted("s", "msg_u", "second"))
    expect(store.messages("s")?.length).toBe(1)
    expect(store.messages("s")?.[0]).toMatchObject({ text: "first" })
  })
})

/**
 * WHAT RECOVERS A TRANSCRIPT WHOSE STREAM DIED.
 *
 * 🔴 Reproduced end to end on 2026-09-03 against the owner's own 121-message chat: stop the server,
 * let two messages land while the stream is down, start it again. The client reconnects and every
 * TanStack query under the server's scope is invalidated — but this store is not a query, so the two
 * messages stayed invisible until the page was reloaded by hand. The owner's report is the symptom
 * exactly: *"its response message is cut from the chat … both these prompts and model's answer to
 * them didn't appeared in chat"*, with the transcript frozen at the moment the stream broke.
 *
 * ⚠️ The reconcile that already existed could not fire: `native-timeline` reloads on a busy → idle
 * transition it learns FROM THE STREAM. While the stream is down there are no events, so there is no
 * transition, and by the time it returns the turn has settled and the edge never comes. A recovery
 * whose trigger rides the channel it recovers from is not a recovery.
 */
describe("recovering a transcript after the stream dropped", () => {
  const message = (id: string, text: string): SessionMessage =>
    ({ id, type: "user", text, time: { created: 1 } }) as unknown as SessionMessage

  /** A client whose history answer can change between calls, like a server that kept working. */
  function growingClient(pages: SessionMessage[][]): { client: NovaclawClient; calls: () => number } {
    let call = 0
    const client = {
      v2: {
        session: {
          async messages() {
            const page = pages[Math.min(call, pages.length - 1)]!
            call += 1
            return { data: { data: page } }
          },
        },
      },
    } as unknown as NovaclawClient
    return { client, calls: () => call }
  }

  test("🔴 reconcileAll picks up what arrived while the client was disconnected", async () => {
    const before = [message("msg_1", "hello")]
    const after = [...before, message("msg_2", "MISSED-WHILE-DISCONNECTED-ONE"), message("msg_3", "and-two")]
    const { client } = growingClient([before, after])
    const store = createNativeMessageStore(client)

    await store.load("s")
    expect(store.messages("s")!.map((m) => m.id)).toEqual(["msg_1"])

    // …the stream drops, two messages land server-side, the stream comes back.
    await store.reconcileAll()

    expect(store.messages("s")!.map((m) => m.id)).toEqual(["msg_1", "msg_2", "msg_3"])
  })

  test("reconnect retries a transcript whose first load failed before it created a store row", async () => {
    let call = 0
    const client = {
      v2: {
        session: {
          async messages() {
            call += 1
            if (call === 1) throw new Error("offline at mount")
            return { data: { data: [message("msg_recovered", "caught up")] } }
          },
        },
      },
    } as unknown as NovaclawClient
    const store = createNativeMessageStore(client)

    await expect(store.load("s")).rejects.toThrow("offline at mount")
    expect(store.messages("s")).toBeUndefined()
    await store.reconcileAll()

    expect(store.messages("s")?.map((item) => item.id)).toEqual(["msg_recovered"])
  })

  test("it re-reads every chat the client is holding, not just one", async () => {
    const { client } = growingClient([[message("msg_x", "seed")]])
    const store = createNativeMessageStore(client)
    store.apply(prompted("s1", "msg_a"))
    store.apply(prompted("s2", "msg_b"))

    await store.reconcileAll()

    // Both transcripts were re-read: each now carries the server's row alongside its own.
    expect(store.messages("s1")!.some((m) => m.id === "msg_x")).toBe(true)
    expect(store.messages("s2")!.some((m) => m.id === "msg_x")).toBe(true)
  })

  test("a chat that cannot be re-read recovers the others but keeps the barrier closed", async () => {
    let call = 0
    const client = {
      v2: {
        session: {
          async messages() {
            call += 1
            if (call === 1) throw new Error("network is still flapping")
            return { data: { data: [message("msg_ok", "recovered")] } }
          },
        },
      },
    } as unknown as NovaclawClient
    const store = createNativeMessageStore(client)
    store.apply(prompted("s1", "msg_a"))
    store.apply(prompted("s2", "msg_b"))

    await expect(store.reconcileAll()).rejects.toThrow("transcript reconciliation failed")

    // One of the two threw; the other still reconciled, but the caller learns the client is not yet
    // wholly synchronized and therefore must not expose a stale prompt as connected.
    const recovered = ["s1", "s2"].filter((id) => store.messages(id)!.some((m) => m.id === "msg_ok"))
    expect(recovered.length).toBe(1)
  })

  test("an older full load cannot commit after a newer full load", async () => {
    const incomplete = {
      id: "msg_a",
      type: "assistant",
      content: [{ type: "text", text: "partial" }],
      time: { created: 1 },
    } as unknown as SessionMessage
    const complete = {
      id: "msg_a",
      type: "assistant",
      content: [{ type: "text", text: "final" }],
      time: { created: 1, completed: 2 },
    } as unknown as SessionMessage
    let call = 0
    const barriers: Array<{ resolve: (value: unknown) => void }> = []
    const client = {
      v2: {
        session: {
          messages() {
            call += 1
            return new Promise((resolve) => barriers.push({ resolve }))
          },
        },
      },
    } as unknown as NovaclawClient
    const store = createNativeMessageStore(client)

    const older = store.load("s")
    const newer = store.load("s")
    expect(call).toBe(2)
    barriers[1]!.resolve({ data: { data: [complete] } })
    await newer
    barriers[0]!.resolve({ data: { data: [incomplete] } })
    await older

    const row = store.messages("s")?.[0]
    expect(row?.type).toBe("assistant")
    if (row?.type === "assistant") {
      expect(row.time?.completed).toBe(2)
      if (row.content[0]?.type === "text") expect(row.content[0].text).toBe("final")
    }
  })
})

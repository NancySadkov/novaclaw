import { describe, expect, test } from "bun:test"
import { ServerConnection } from "./server"
import { forgetGoneSession, revalidateSessionTabs } from "./session-gone"

/**
 * The ONE policy for a chat the server no longer has.
 *
 * It exists because the copies were retired separately and only one of them was: the route closed
 * the tab when its cache was empty, the message store evicted its transcript, and the send path did
 * nothing. The cached RECORD is the one that mattered — the route trusts it, so a session left in
 * `data.info` kept rendering until the app restarted.
 */
describe("forgetGoneSession", () => {
  const server = ServerConnection.Key.make("http://sidecar.test")

  test("drops the cached record and closes the tab WITH stay", () => {
    const calls: string[] = []
    const session = {
      forget: (id: string) => calls.push(`forget:${id}`),
    }
    const tabs = {
      removeSessionTab: (tab: { server: string; sessionId: string }) =>
        calls.push(`close:${tab.server}/${tab.sessionId}`),
    }

    forgetGoneSession({ session, tabs, server, sessionID: "ses_gone" })

    // Both halves, in one call: closing the tab alone leaves the cache the route reads.
    expect(calls).toEqual([`forget:ses_gone`, `close:${server}/ses_gone`])
  })

  test("names the tab by the server it was opened on, not the one that failed", () => {
    const closed: Array<{ server: string; sessionId: string }> = []
    const other = ServerConnection.Key.make("http://elsewhere.test")
    forgetGoneSession({
      session: { forget: () => {} },
      tabs: { removeSessionTab: (tab) => closed.push(tab) },
      server: other,
      sessionID: "ses_gone",
    })
    expect(closed).toEqual([{ server: other, sessionId: "ses_gone" }])
  })
})

/**
 * The reconnect half: a deletion by ANOTHER client while this renderer was disconnected never
 * arrives as an event, so the strip re-asks. Bounded by the tabs, and it must never reject — it
 * runs on the connection barrier, where a rejection keeps the whole client offline.
 */
describe("revalidateSessionTabs", () => {
  const server = ServerConnection.Key.make("http://sidecar.test")
  const other = ServerConnection.Key.make("http://elsewhere.test")

  const tabs = (store: Array<{ type: string; server: ServerConnection.Key; sessionId: string }>, ready = true) => {
    const closed: Array<{ server: string; sessionId: string }> = []
    return {
      closed,
      ready: () => ready,
      store,
      removeSessionTab: (tab: { server: string; sessionId: string }) => closed.push(tab),
    }
  }

  test("asks only this server's session tabs, and retires the ones the server no longer has", async () => {
    const store = tabs([
      { type: "session", server, sessionId: "live" },
      { type: "session", server, sessionId: "deleted" },
      { type: "session", server: other, sessionId: "elsewhere" },
      { type: "draft", server, sessionId: "" },
    ])
    const asked: Array<readonly string[]> = []
    const forgotten: string[] = []

    const gone = await revalidateSessionTabs({
      session: {
        revalidate: async (ids) => {
          asked.push(ids)
          return ["deleted"]
        },
        forget: (id) => forgotten.push(id),
      },
      tabs: store,
      server,
    })

    // One read per OPEN TAB on this server — a draft and another server's tab are not asked about.
    expect(asked).toEqual([["live", "deleted"]])
    expect(gone).toEqual(["deleted"])
    expect(forgotten).toEqual(["deleted"])
    expect(store.closed).toEqual([{ server, sessionId: "deleted" }])
  })

  test("an un-hydrated strip validates nothing", async () => {
    let asked = 0
    const gone = await revalidateSessionTabs({
      session: {
        revalidate: async () => {
          asked++
          return []
        },
        forget: () => {},
      },
      tabs: tabs([{ type: "session", server, sessionId: "live" }], false),
      server,
    })
    expect(gone).toEqual([])
    expect(asked).toBe(0)
  })

  test("a revalidation that rejects retires nothing and does not reject the barrier", async () => {
    const store = tabs([{ type: "session", server, sessionId: "live" }])
    const gone = await revalidateSessionTabs({
      session: {
        revalidate: async () => {
          throw new Error("reconnect recovery failed")
        },
        forget: () => {},
      },
      tabs: store,
      server,
    })
    expect(gone).toEqual([])
    expect(store.closed).toEqual([])
  })
})

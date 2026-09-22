import { describe, expect, test } from "bun:test"
import { ServerConnection } from "./server"
import { forgetGoneSession } from "./session-gone"

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

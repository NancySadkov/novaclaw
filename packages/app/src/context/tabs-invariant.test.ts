import { describe, expect, test } from "bun:test"
import { findAgentTab } from "./tab-agent"
import type { Tab } from "./tabs"
import type { ServerConnection } from "./server"

/**
 * ONE TAB PER COLLEAGUE (owner, 2026-08-28: *"under no circumstances there can be two or more tabs
 * from the same agent"*).
 *
 * ⚠️ These hold the DECISION still, not the bookkeeping around it — the context that calls it needs
 * a router and a live server, so a test of the context would mostly be a test of the harness.
 *
 * ⚠️ What a green run does NOT prove is that every door calls the rule, which is the half that
 * actually broke. That was verified by exercising the app against a strip that had four "Nova" tabs
 * in it, not here.
 *
 * A/B: delete `tab.agent === agent` from the predicate and "finds the colleague's open tab" fails;
 * delete the `agent === undefined` early return and "an anonymous chat opts out" fails.
 */
const SERVER = "http://localhost:4096" as ServerConnection.Key
const OTHER = "http://localhost:5000" as ServerConnection.Key

const chat = (sessionId: string, agent?: string, server: ServerConnection.Key = SERVER): Tab => ({
  type: "session",
  server,
  sessionId,
  agent,
})

describe("one tab per colleague", () => {
  test("finds the colleague's open tab even though the session differs", () => {
    // The reported shape exactly: the same colleague, a second session, a second tab.
    const tabs = [chat("ses_a", "nova"), chat("ses_b", "umbris")]
    expect(findAgentTab(tabs, SERVER, "nova")).toBe(0)
    expect(findAgentTab(tabs, SERVER, "umbris")).toBe(1)
    expect(findAgentTab(tabs, SERVER, "daedalus")).toBe(-1)
  })

  test("an anonymous chat opts out instead of colliding with every other one", () => {
    const tabs = [chat("ses_a"), chat("ses_b")]
    // Two tabs, both agent-less. If `undefined` matched, the second would be folded into the first
    // and a directory-based chat could never have a tab of its own.
    expect(findAgentTab(tabs, SERVER, undefined)).toBe(-1)
  })

  test("a tab does not count as its own duplicate", () => {
    const tabs = [chat("ses_a", "nova")]
    // The backfill asks "does anyone ELSE hold this colleague" while stamping ses_a itself.
    expect(findAgentTab(tabs, SERVER, "nova", "ses_a")).toBe(-1)
    expect(findAgentTab([...tabs, chat("ses_b", "nova")], SERVER, "nova", "ses_b")).toBe(0)
  })

  test("scoped to one server — the same colleague on two machines is two colleagues", () => {
    const tabs = [chat("ses_a", "nova", OTHER)]
    expect(findAgentTab(tabs, SERVER, "nova")).toBe(-1)
    expect(findAgentTab(tabs, OTHER, "nova")).toBe(0)
  })

  test("ignores drafts, which have no colleague to be duplicated", () => {
    const draft: Tab = { type: "draft", draftID: "d1", server: SERVER, directory: "/tmp" }
    expect(findAgentTab([draft, chat("ses_a", "nova")], SERVER, "nova")).toBe(1)
  })
})

import { describe, expect, test } from "bun:test"
import { findAgentTab, officerTabAgent } from "./tab-agent"
import { tabHref, tabKey, type SessionTab, type Tab } from "./tabs"
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

const chat = (sessionId: string, agent?: string, server: ServerConnection.Key = SERVER): SessionTab => ({
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

  test("a temporary worker never occupies its prototype officer's tab", () => {
    const worker = { ...chat("ses_worker", "umbris"), worker: true } satisfies Tab
    expect(findAgentTab([worker], SERVER, "umbris")).toBe(-1)
    expect(findAgentTab([chat("ses_umbris", "umbris"), worker], SERVER, "umbris")).toBe(0)
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

/**
 * WHICH colleague owns a route's session — the key that lets a gone transcript id recover instead of
 * rendering "This chat was deleted or has expired" (owner, 2026-09-26).
 *
 * A/B: make `officerTabAgent` return `tab.agent` for a worker and "a worker is not its officer's
 * route" fails; drop the `worker === true` guard and that same case flips the other way.
 */
describe("officerTabAgent — the colleague behind a route's session", () => {
  test("names the colleague that owns the session", () => {
    const tabs = [chat("ses_nova", "nova"), chat("ses_daedalus", "daedalus")]
    expect(officerTabAgent(tabs, SERVER, "ses_daedalus")).toBe("daedalus")
  })

  test("a session no tab holds has no colleague to follow", () => {
    expect(officerTabAgent([chat("ses_nova", "nova")], SERVER, "ses_other")).toBeUndefined()
  })

  test("an anonymous chat follows nobody — it is genuinely gone when deleted", () => {
    expect(officerTabAgent([chat("ses_a")], SERVER, "ses_a")).toBeUndefined()
  })

  test("a worker is not its officer's route", () => {
    const worker = { ...chat("ses_worker", "umbris"), worker: true } satisfies Tab
    expect(officerTabAgent([worker], SERVER, "ses_worker")).toBeUndefined()
  })

  test("scoped to one server", () => {
    expect(officerTabAgent([chat("ses_a", "nova", OTHER)], SERVER, "ses_a")).toBeUndefined()
  })
})

/**
 * 🔴 A COLLEAGUE'S TAB IS THE AGENT (AGENTS.md; owner, 2026-09-26).
 *
 * The failure this replaces: Clear Chat hands the colleague a NEW session, the tab's key changed, and
 * the strip re-sorted and re-opened at the end while a context inspector stayed on the old id. With
 * the agent as the identity none of that can move — the session is a component reached through it.
 */
describe("a colleague's tab is addressed by the AGENT", () => {
  test("its href names the agent, never a session id", () => {
    const tab = { type: "agent", server: SERVER, agent: "daedalus" } as const
    expect(tabHref(tab)).toContain("/agent/daedalus")
    expect(tabHref(tab)).not.toContain("/session/")
  })

  test("the key is stable across session changes, and a session tab still keys on its session", () => {
    const colleague = { type: "agent", server: SERVER, agent: "nova" } as const
    // Same colleague, same key — whatever session it is running right now.
    expect(tabKey(colleague)).toBe(tabKey({ ...colleague }))
    // Anonymous/worker chats genuinely ARE their session, so those keys still differ.
    expect(tabKey(chat("ses_a"))).not.toBe(tabKey(chat("ses_b")))
  })

  test("its identity does not collide with a same-named session id", () => {
    expect(tabKey({ type: "agent", server: SERVER, agent: "nova" })).not.toBe(tabKey(chat("nova", "nova")))
  })
})

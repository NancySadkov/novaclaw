import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import {
  readSessionAgentChatsDetail,
  readSessionTabsRemovedDetail,
  SESSION_AGENT_CHATS_EVENT,
  SESSION_TABS_REMOVED_EVENT,
} from "./titlebar-session-events"

const remote = "remote" as ServerConnection.Key

describe("titlebar session events", () => {
  test("reads valid removed session tab details", () => {
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { server: "remote", directory: "/tmp/project", sessionIDs: ["ses_1", "ses_2", 1] },
        }),
      ),
    ).toEqual({
      server: remote,
      directory: "/tmp/project",
      sessionIDs: ["ses_1", "ses_2"],
    })
  })

  test("ignores invalid removed session tab details", () => {
    expect(readSessionTabsRemovedDetail(new Event(SESSION_TABS_REMOVED_EVENT))).toBeUndefined()
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { directory: "/tmp/project", sessionIDs: [] },
        }),
      ),
    ).toBeUndefined()
  })

  // A colleague's tab follows its colleague, and the notice that carries the decision is read the
  // same defensive way the removal notice is: a window CustomEvent is anybody's to dispatch.
  test("reads the agent-chat rows a follow decides from", () => {
    const detail = readSessionAgentChatsDetail(
      new CustomEvent(SESSION_AGENT_CHATS_EVENT, {
        // ⚠️ The junk row is CAST in, and that is the test: a window CustomEvent is anybody's to
        // dispatch, so the reader is what must reject it — the type here binds nothing at runtime.
        detail: {
          server: "remote",
          rows: [
            { id: "ses_old", agent: "daedalus", archived: true },
            { id: "ses_new", agent: "daedalus", archived: false },
            "not a row",
          ] as unknown[],
        },
      }),
    )
    expect(detail?.server).toBe(remote)
    expect(detail?.rows.map((row) => row.id)).toEqual(["ses_old", "ses_new"])
  })

  test("ignores an agent-chats notice with nothing readable in it", () => {
    expect(readSessionAgentChatsDetail(new Event(SESSION_AGENT_CHATS_EVENT))).toBeUndefined()
    expect(
      readSessionAgentChatsDetail(new CustomEvent(SESSION_AGENT_CHATS_EVENT, { detail: { rows: [] } })),
    ).toBeUndefined()
    expect(
      readSessionAgentChatsDetail(new CustomEvent(SESSION_AGENT_CHATS_EVENT, { detail: { rows: ["x"] } })),
    ).toBeUndefined()
  })
})

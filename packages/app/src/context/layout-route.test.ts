import { describe, expect, test } from "bun:test"
import { base64Encode } from "@novaclaw/core/util/encode"
import { currentRoute } from "./layout"

/**
 * 🔴 THE ROUTE PARSER MUST KNOW THE AGENT ADDRESS (owner, 2026-09-26).
 *
 * The strip highlights a tab by asking `layout.route()` which tab matches. It only understood
 * `home`/`draft`/`session`, so a colleague page parsed as `home` — no tab matched, and the current
 * officer's tab showed NO highlight. The same parser is what opens a tab for a restored window.
 */
const server = base64Encode("http://127.0.0.1:4096")

describe("route parsing knows the agent address", () => {
  test("a colleague page parses to an AGENT route", () => {
    expect(currentRoute(`/server/${server}/agent/daedalus`, "")).toEqual({
      type: "agent",
      agentID: "daedalus",
      server: expect.any(String),
    })
  })

  test("a session page still parses to a SESSION route", () => {
    expect(currentRoute(`/server/${server}/session/ses_x`, "")).toEqual({
      type: "session",
      sessionId: "ses_x",
      server: expect.any(String),
    })
  })

  test("an agent id with a space survives the round trip", () => {
    const route = currentRoute(`/server/${server}/agent/Chief%20Architect`, "")
    expect(route).toMatchObject({ type: "agent", agentID: "Chief Architect" })
  })

  test("an unknown server page is still home", () => {
    expect(currentRoute("/nonsense", "")).toEqual({ type: "home" })
  })
})

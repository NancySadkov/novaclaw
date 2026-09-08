import { describe, expect, test } from "bun:test"
import {
  isLocalWorkspaceRoute,
  getWorkspaceRouteSessionID,
  workspaceProxyURL,
} from "../../src/server/shared/workspace-routing"
import { SessionID } from "../../src/session/schema"

describe("isLocalWorkspaceRoute", () => {
  test("GET /session is local", () => {
    expect(isLocalWorkspaceRoute("GET", "/session")).toBe(true)
  })

  test("GET /session/ses_abc is local (prefix match)", () => {
    expect(isLocalWorkspaceRoute("GET", "/session/ses_abc")).toBe(true)
  })

  test("POST /session is not local (method mismatch)", () => {
    expect(isLocalWorkspaceRoute("POST", "/session")).toBe(false)
  })

  test("/session/status is forwarded regardless of method", () => {
    expect(isLocalWorkspaceRoute("GET", "/session/status")).toBe(false)
    expect(isLocalWorkspaceRoute("POST", "/session/status")).toBe(false)
  })

  test("unrecognized paths are not local", () => {
    expect(isLocalWorkspaceRoute("GET", "/config")).toBe(false)
    expect(isLocalWorkspaceRoute("POST", "/session/ses_abc/message")).toBe(false)
  })
})

describe("getWorkspaceRouteSessionID", () => {
  test("extracts session ID from path", () => {
    const url = new URL("http://localhost/session/ses_abc123/message")
    expect(getWorkspaceRouteSessionID(url)).toBe(SessionID.make("ses_abc123"))
  })

  test("extracts session ID without trailing path", () => {
    const url = new URL("http://localhost/session/ses_xyz")
    expect(getWorkspaceRouteSessionID(url)).toBe(SessionID.make("ses_xyz"))
  })

  // 🔴 The NATIVE routes. Until 2026-08-07 this function knew only the V1 `/session/:id` shape — which
  // the V1 nuke DELETED — so it answered `null` for every live session route, and the middleware that
  // asks it concluded "not session-scoped" and served the request locally.
  test("extracts session ID from a native /api/session path", () => {
    const url = new URL("http://localhost/api/session/ses_abc123/prompt")
    expect(getWorkspaceRouteSessionID(url)).toBe(SessionID.make("ses_abc123"))
  })

  test("extracts session ID from a native path with no trailing segment", () => {
    const url = new URL("http://localhost/api/session/ses_xyz")
    expect(getWorkspaceRouteSessionID(url)).toBe(SessionID.make("ses_xyz"))
  })

  // ⚠️ `/api/session/active` and `/api/session/execution` are LITERAL routes. A greedy `[^/]+` segment
  // match would read "active" as a session id and send the middleware looking for its workspace, so the
  // pattern requires the `ses` prefix (`SessionID` is `isStartsWith("ses")`).
  test("does not mistake the literal /api/session routes for session IDs", () => {
    expect(getWorkspaceRouteSessionID(new URL("http://localhost/api/session/active"))).toBeNull()
    expect(getWorkspaceRouteSessionID(new URL("http://localhost/api/session/execution"))).toBeNull()
    expect(getWorkspaceRouteSessionID(new URL("http://localhost/api/session"))).toBeNull()
  })

  test("extracts session ID from experimental background path", () => {
    const url = new URL("http://localhost/experimental/session/ses_bg/background")
    expect(getWorkspaceRouteSessionID(url)).toBe(SessionID.make("ses_bg"))
  })

  test("returns null for /session/status", () => {
    const url = new URL("http://localhost/session/status")
    expect(getWorkspaceRouteSessionID(url)).toBeNull()
  })

  test("returns null for non-session paths", () => {
    const url = new URL("http://localhost/config")
    expect(getWorkspaceRouteSessionID(url)).toBeNull()
  })

  test("returns null for bare /session path", () => {
    const url = new URL("http://localhost/session")
    expect(getWorkspaceRouteSessionID(url)).toBeNull()
  })
})

describe("workspaceProxyURL", () => {
  test("appends request path to target", () => {
    const result = workspaceProxyURL("http://remote:8080/base", new URL("http://localhost/config"))
    expect(result.toString()).toBe("http://remote:8080/base/config")
  })

  test("strips trailing slash on target before appending", () => {
    const result = workspaceProxyURL("http://remote:8080/base/", new URL("http://localhost/session/abc"))
    expect(result.pathname).toBe("/base/session/abc")
  })

  test("preserves query params from request but removes workspace", () => {
    const url = new URL("http://localhost/config?workspace=ws_123&keep=yes")
    const result = workspaceProxyURL("http://remote:8080/base", url)
    expect(result.searchParams.get("workspace")).toBeNull()
    expect(result.searchParams.get("keep")).toBe("yes")
  })

  test("preserves hash from request", () => {
    const url = new URL("http://localhost/page#section")
    const result = workspaceProxyURL("http://remote:8080", url)
    expect(result.hash).toBe("#section")
  })

  test("works with URL object as target", () => {
    const target = new URL("http://remote:3000/api")
    const result = workspaceProxyURL(target, new URL("http://localhost/users"))
    expect(result.toString()).toBe("http://remote:3000/api/users")
  })

  test("🔴 does not forward this instance's credential to the target", () => {
    const token = Buffer.from("novaclaw:secret").toString("base64")
    const url = new URL(`http://localhost/session/abc?auth_token=${encodeURIComponent(token)}&keep=1`)
    const result = workspaceProxyURL("http://remote:8080/base", url)
    expect(result.searchParams.has("auth_token")).toBe(false)
    // Asserted on the whole URL too: a value that survived re-encoding would still be a leak.
    expect(result.toString()).not.toContain(token)
    // Control: ordinary query the target DOES need still rides along.
    expect(result.searchParams.get("keep")).toBe("1")
  })
})

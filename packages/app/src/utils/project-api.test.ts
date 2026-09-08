import { afterAll, describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import { InstanceFetchError } from "@/utils/instance-fetch"
import { projectState, projectWrite } from "@/utils/project-api"

/**
 * **The client half of `GET`/`POST /api/project`.**
 *
 * 🔴 **The one thing that can only fail HERE: a refusal arriving as a thrown Error.** The route
 * answers a broken `novaclaw.json` with **200** and `{ok:false}` deliberately — `GET /api/project`
 * already answers 200 `{kind:"invalid"}` for the same file, because "your project file is broken" is
 * a state the UI renders calmly, with the path and the detail the user needs to fix it. But
 * `instanceFetch` turns every non-2xx into a thrown `InstanceFetchError`, and a throw inside a
 * `createResource` read reaches the ROOT ErrorBoundary and replaces the whole application (review
 * 1.15). So the calm explanation and the red "request failed" toast are one status code apart, and
 * nothing in the server's own tests can see which side of that line the client lands on.
 *
 * ⚠️ **The transport is stubbed and the reason is named rather than hidden.** This package's tests
 * preload happy-dom (`bunfig.toml`), whose `fetch` cannot complete a request against a local
 * `Bun.serve` — measured: `HPE_UNEXPECTED_CONTENT_LENGTH` on every call. So `globalThis.fetch` is
 * replaced with a handler that returns real `Response` objects. What that still exercises is the
 * whole client stack — the URL join, the auth/`content-type` headers, the directory CHANNEL, the
 * JSON body, and the status→throw decision — which is everything this module owns. What it does not
 * exercise is the socket, and the ROUTE producing these bodies is proven separately over real HTTP
 * in `packages/novaclaw/test/server/httpapi-project-write.test.ts`. The two halves meet at the
 * bodies below, which are copied from what that test asserts the route returns.
 *
 * ⚠️ **A/B, run by hand:** answer the refusal with `status: 422` instead of 200 and the first case
 * below goes red with a thrown `InstanceFetchError` — which is exactly the regression the 200 exists
 * to prevent.
 */

/** Bodies copied from what the real route produces; the server test pins that they are these. */
const REFUSAL = {
  ok: false,
  file: "C:/work/app/novaclaw.json",
  reason: "unreadable",
  detail: "JSON Parse error: Unexpected identifier \"not\"",
}
const RECEIPT = {
  ok: true,
  file: "C:/work/app/novaclaw.json",
  created: false,
  sections: ["permissions"],
  cleared: [],
  refusedTune: [],
  refusedPermissions: [{ action: "read", resource: "*", effect: "allow" }],
}

interface Seen {
  method: string
  path: string
  directory: string | null
  body: unknown
}

const seen: Seen[] = []
let answer: { status: number; body: unknown } = { status: 200, body: REFUSAL }

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input))
  const headers = new Headers(init?.headers as HeadersInit)
  seen.push({
    method: init?.method ?? "GET",
    path: url.pathname,
    directory: headers.get("x-novaclaw-directory"),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  })
  if (url.pathname === "/api/project" && (init?.method ?? "GET") === "GET")
    return Response.json({
      kind: "project",
      root: "C:/work/app",
      file: "C:/work/app/novaclaw.json",
      permissionRules: 1,
      permissions: [{ action: "bash", resource: "*", effect: "deny" }],
      exclude: ["secrets/**"],
      gitignore: { file: "C:/work/app/.gitignore", add: ["dist"], already: [], dropped: [], reincludes: [] },
    })
  return Response.json(answer.body, { status: answer.status })
}) as unknown as typeof globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

const server = (): ServerConnection.HttpBase => ({ url: "http://instance.test:4096" })
const DIRECTORY = "C:/work/app"

describe("the project client, end to end through instanceFetch", () => {
  test("🔴 a refusal is RETURNED, never thrown — a broken file is a state, not a request failure", async () => {
    answer = { status: 200, body: REFUSAL }
    const result = await projectWrite(server(), DIRECTORY, { permissions: [] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    // The two fields the surface needs to say something useful instead of "request failed".
    expect(result.reason).toBe("unreadable")
    expect(result.file).toBe(REFUSAL.file)
    expect(result.detail.length).toBeGreaterThan(0)
  })

  test("a receipt carries what the server dropped, so the surface can say so out loud", async () => {
    answer = { status: 200, body: RECEIPT }
    const result = await projectWrite(server(), DIRECTORY, {
      permissions: [{ action: "read", resource: "*", effect: "allow" }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sections).toEqual(["permissions"])
    expect(result.cleared).toEqual([])
    expect(result.refusedPermissions).toEqual([{ action: "read", resource: "*", effect: "allow" }])
  })

  test("a REAL failure still throws — a 500 must not be mistaken for a refusal", async () => {
    answer = { status: 500, body: { message: "the instance fell over" } }
    // The other half of the same rule: turning a genuine fault into a quiet `{ok:false}` would be
    // ruling 2 broken in the opposite direction.
    await expect(projectWrite(server(), DIRECTORY, { name: "x" })).rejects.toBeInstanceOf(InstanceFetchError)
  })

  test("the directory travels in the HEADER, which is the channel the route reads", async () => {
    answer = { status: 200, body: RECEIPT }
    seen.length = 0
    await projectWrite(server(), DIRECTORY, { clear: ["permissions"] })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.method).toBe("POST")
    expect(seen[0]!.path).toBe("/api/project")
    // Percent-encoded on the way out (`instance-fetch.ts` does that so a non-ASCII path survives a
    // header), so the assertion decodes rather than pinning the encoding — what matters is that the
    // server can recover the directory, not which escape form it travelled in.
    expect(decodeURIComponent(seen[0]!.directory!)).toBe(DIRECTORY)
    // The `clear` sentinel reaches the wire as itself — the whole reason it exists rather than an
    // `undefined` that JSON cannot carry.
    expect(seen[0]!.body).toEqual({ clear: ["permissions"] })
  })

  test("the read carries the RULES and the .gitignore proposal, not just a count", async () => {
    const state = await projectState(server(), DIRECTORY)
    expect(state.kind).toBe("project")
    if (state.kind !== "project") return
    expect(state.permissions).toEqual([{ action: "bash", resource: "*", effect: "deny" }])
    expect(state.gitignore?.add).toEqual(["dist"])
  })
})

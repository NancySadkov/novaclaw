import { describe, expect, test } from "bun:test"
import { HttpApi, HttpApiMiddleware } from "effect/unstable/httpapi"
import { makeDefaultApi } from "../src/api"
import { InvalidRequestError, SessionNotFoundError } from "../src/errors"

/**
 * 🔴 **Every route naming a `:sessionID` must carry the workspace-routing middleware.**
 *
 * A session can be owned by a REMOTE workspace. Without this middleware the request is served on
 * whichever machine received it — the wrong one — against the wrong working tree, and it answers
 * `200`, which is indistinguishable from a correctly proxied call.
 *
 * ⚠️ **This test exists because the gap RECURRED.** The native session group had no workspace routing
 * at all until 2026-08-07; the fix declared it there, and `message`, `permission` and `question`
 * — all equally session-scoped — were missed in the same pass. The reply routes are the sharpest
 * case: a remote session asks for permission, the user answers, the reply is handled locally, and the
 * session that is waiting hangs on an ask that was answered.
 *
 * ⭐ A per-group declaration is invisible from any one place, so "did we cover them all?" cannot be
 * answered by reading — which is precisely what a mechanical check is for (ruling 1). The next
 * session-scoped group added will fail here rather than shipping the same hole a third time.
 */

class TestLocationMiddleware extends HttpApiMiddleware.Service<TestLocationMiddleware>()(
  "@novaclaw/protocol/test/session-routing/LocationMiddleware",
) {}
class TestSessionLocationMiddleware extends HttpApiMiddleware.Service<TestSessionLocationMiddleware>()(
  "@novaclaw/protocol/test/session-routing/SessionLocationMiddleware",
  { error: [InvalidRequestError, SessionNotFoundError] },
) {}
class TestWorkspaceRoutingMiddleware extends HttpApiMiddleware.Service<TestWorkspaceRoutingMiddleware>()(
  "@novaclaw/protocol/test/session-routing/WorkspaceRoutingMiddleware",
) {}

const Api = makeDefaultApi({
  locationMiddleware: TestLocationMiddleware,
  sessionLocationMiddleware: TestSessionLocationMiddleware,
  workspaceRoutingMiddleware: TestWorkspaceRoutingMiddleware,
})

type Route = { group: string; name: string; path: string; routed: boolean }

const routes: Route[] = []
HttpApi.reflect(Api, {
  onGroup() {},
  onEndpoint({ endpoint, group }) {
    routes.push({
      group: group.identifier,
      name: endpoint.name,
      path: endpoint.path,
      // `middlewares` is recorded per ENDPOINT, not per group: `HttpApiGroup.middleware()` stamps the
      // endpoints present when it is called, and the effect docs warn that endpoints added AFTER it
      // do not get it. Reading the endpoint is therefore the only honest check — a group that
      // declares the middleware before its last `.add()` would still leave routes unrouted.
      routed: [...endpoint.middlewares].some((key) => key === (TestWorkspaceRoutingMiddleware as never)),
    })
  },
})

const sessionScoped = routes.filter((route) => route.path.includes(":sessionID"))

describe("session-scoped routes are workspace-routed", () => {
  test("the sweep found session-scoped routes at all", () => {
    // Without this a path-shape change empties the filter and turns the assertion below into a
    // tautology — the failure mode every ledger in this repo guards against first.
    expect(sessionScoped.length).toBeGreaterThan(8)
  })

  test("🔴 every route naming a :sessionID carries workspace routing", () => {
    expect(
      sessionScoped
        .filter((route) => !route.routed)
        .map((route) => `${route.group} > ${route.name} (${route.path}) is not workspace-routed`),
    ).toEqual([])
  })

  test("the check can fail (negative control)", () => {
    // A route with no `:sessionID` is not expected to be routed, so if THIS were also reported as
    // routed the predicate would be matching everything and the test above would prove nothing.
    const unscoped = routes.filter((route) => !route.path.includes(":sessionID"))
    expect(unscoped.length).toBeGreaterThan(0)
    expect(unscoped.some((route) => !route.routed)).toBe(true)
  })
})

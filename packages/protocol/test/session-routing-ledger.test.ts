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

type Route = { group: string; name: string; path: string; routed: boolean; routingAt: number; bindingAt: number }

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
      // Insertion order = declaration order, and the LAST declared runs OUTERMOST (measured
      // 2026-08-07: `.middleware(A).middleware(B)` runs B:in → A:in → handler).
      // ⚠️ Compared as INDICES rather than "is it last": API-level middleware (`Authorization`,
      // `SchemaErrorMiddleware`) is applied above every group and is correctly outermost of all. The
      // contract is only that routing sits OUTSIDE session-location binding.
      routingAt: [...endpoint.middlewares].indexOf(TestWorkspaceRoutingMiddleware as never),
      bindingAt: [...endpoint.middlewares].indexOf(TestSessionLocationMiddleware as never),
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

  test("🔴 workspace routing is OUTERMOST — routed away before local services are bound", () => {
    // ⚠️ **Order is a correctness property here, not style.** `sessionLocationMiddleware` binds local
    // services to a session; `workspaceRoutingMiddleware` may send the request to another machine
    // entirely. Binding first would boot a location graph for a request that is about to leave — work
    // done on the wrong host, and for a session this instance does not own.
    //
    // Measured 2026-08-07 with a two-middleware probe: `.middleware(A).middleware(B)` runs
    // `B:in → A:in → handler → A:out → B:out`, so the LAST declared is the OUTERMOST. `middlewares` is
    // a Set and JS Sets iterate in insertion order, so the last entry is the outer one.
    // Only routes that bind a session location can be misordered; the rest have nothing to order against.
    const binding = sessionScoped.filter((route) => route.bindingAt >= 0)
    expect(binding.length).toBeGreaterThan(5)
    expect(
      binding
        .filter((route) => !(route.routingAt > route.bindingAt))
        .map(
          (route) =>
            `${route.group} > ${route.name}: workspace routing (${route.routingAt}) is not outside session-location ` +
            `binding (${route.bindingAt}) — this request would bind local services before discovering it belongs ` +
            `to another machine`,
        ),
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

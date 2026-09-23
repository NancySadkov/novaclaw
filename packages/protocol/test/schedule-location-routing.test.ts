import { describe, expect, test } from "bun:test"
import { HttpApi, HttpApiMiddleware } from "effect/unstable/httpapi"
import { makeDefaultApi } from "../src/api"
import { InvalidRequestError, SessionNotFoundError } from "../src/errors"

class TestLocationMiddleware extends HttpApiMiddleware.Service<TestLocationMiddleware>()(
  "@novaclaw/protocol/test/schedule-location/LocationMiddleware",
) {}

class TestSessionLocationMiddleware extends HttpApiMiddleware.Service<TestSessionLocationMiddleware>()(
  "@novaclaw/protocol/test/schedule-location/SessionLocationMiddleware",
  { error: [InvalidRequestError, SessionNotFoundError] },
) {}

class TestWorkspaceRoutingMiddleware extends HttpApiMiddleware.Service<TestWorkspaceRoutingMiddleware>()(
  "@novaclaw/protocol/test/schedule-location/WorkspaceRoutingMiddleware",
) {}

const Api = makeDefaultApi({
  locationMiddleware: TestLocationMiddleware,
  sessionLocationMiddleware: TestSessionLocationMiddleware,
  workspaceRoutingMiddleware: TestWorkspaceRoutingMiddleware,
})

const scheduleRoutes: Array<{ readonly name: string; readonly located: boolean }> = []
HttpApi.reflect(Api, {
  onGroup() {},
  onEndpoint({ endpoint, group }) {
    if (group.identifier !== "server.schedule") return
    scheduleRoutes.push({
      name: endpoint.name,
      located: [...endpoint.middlewares].some((key) => key === (TestLocationMiddleware as never)),
    })
  },
})

describe("schedule location routing", () => {
  test("create and update bind the request location", () => {
    expect(
      scheduleRoutes
        .filter((route) => route.located)
        .map((route) => route.name)
        .sort(),
    ).toEqual(["schedule.create", "schedule.update"])
  })

  test("list, remove and fire history use the explicit agent id without ambient location", () => {
    expect(
      scheduleRoutes
        .filter((route) => !route.located)
        .map((route) => route.name)
        .sort(),
    ).toEqual(["schedule.confirm", "schedule.fires.list", "schedule.list", "schedule.remove"])
  })

  test("the sweep found the whole schedule group", () => {
    expect(scheduleRoutes).toHaveLength(6)
  })
})

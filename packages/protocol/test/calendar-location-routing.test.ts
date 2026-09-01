import { describe, expect, test } from "bun:test"
import { HttpApi, HttpApiMiddleware } from "effect/unstable/httpapi"
import { makeDefaultApi } from "../src/api"
import { InvalidRequestError, SessionNotFoundError } from "../src/errors"

class TestLocationMiddleware extends HttpApiMiddleware.Service<TestLocationMiddleware>()(
  "@novaclaw/protocol/test/calendar-location/LocationMiddleware",
) {}

class TestSessionLocationMiddleware extends HttpApiMiddleware.Service<TestSessionLocationMiddleware>()(
  "@novaclaw/protocol/test/calendar-location/SessionLocationMiddleware",
  { error: [InvalidRequestError, SessionNotFoundError] },
) {}

class TestWorkspaceRoutingMiddleware extends HttpApiMiddleware.Service<TestWorkspaceRoutingMiddleware>()(
  "@novaclaw/protocol/test/calendar-location/WorkspaceRoutingMiddleware",
) {}

const Api = makeDefaultApi({
  locationMiddleware: TestLocationMiddleware,
  sessionLocationMiddleware: TestSessionLocationMiddleware,
  workspaceRoutingMiddleware: TestWorkspaceRoutingMiddleware,
})

const calendarRoutes: Array<{ readonly name: string; readonly located: boolean }> = []
HttpApi.reflect(Api, {
  onGroup() {},
  onEndpoint({ endpoint, group }) {
    if (group.identifier !== "server.calendar") return
    calendarRoutes.push({
      name: endpoint.name,
      located: [...endpoint.middlewares].some((key) => key === (TestLocationMiddleware as never)),
    })
  },
})

describe("calendar location routing", () => {
  test("create and update bind the request location used for ambient validation", () => {
    expect(
      calendarRoutes
        .filter((route) => route.located)
        .map((route) => route.name)
        .sort(),
    ).toEqual(["calendar.schedule.create", "calendar.schedule.update"])
  })

  test("list, remove and fire history stay instance-global", () => {
    expect(
      calendarRoutes
        .filter((route) => !route.located)
        .map((route) => route.name)
        .sort(),
    ).toEqual(["calendar.fires.list", "calendar.schedule.list", "calendar.schedule.remove"])
  })

  test("the sweep found the whole calendar group", () => {
    expect(calendarRoutes).toHaveLength(5)
  })
})

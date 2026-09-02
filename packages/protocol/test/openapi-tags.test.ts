import { describe, expect, test } from "bun:test"
import { Context } from "effect"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeDefaultApi } from "../src/api"
import { InvalidRequestError, SessionNotFoundError } from "../src/errors"

/**
 * ─── THE TAXONOMY IS PART OF THE CONTRACT ────────────────────────────────────────────────────────
 *
 * A stranger meets this API through its reference, and the reference's navigation is the spec's
 * `tags` array. Two ways it used to lie, neither of which anything asserted — no test anywhere read
 * the word `tags` before this file:
 *
 * 1. **A group with no `title` inherits one.** `HttpApi.addHttpApi` merges the embedded API's
 *    annotations into every group it takes (`Context.merge(api.annotations, group.annotations)`), so
 *    a group that never named itself is published under the API's OWN title and description. Seven
 *    groups here had none, and the served document filed **nineteen** operations — `/api/agent*`,
 *    `/api/app/{id}`, `/api/credential*`, `/api/health`, `/api/location`, `/api/telemetry/status`
 *    and all nine of `/api/memory/*` — under a heading literally named `novaclaw HttpApi`,
 *    described as an experimental surface covering selected routes. Meanwhile the DEPRECATED
 *    `/memory/*` routes sat under a tidy `memory` section: the document's own taxonomy pointed
 *    readers at the surface that is being deleted.
 *
 * 2. **One tag entry is pushed per GROUP, and OpenAPI 3.1 requires those names to be unique.**
 *    Effect emits `spec.tags.push(tag)` unconditionally, so four session groups all titled
 *    `sessions` produced four identical entries, and renderers duplicate the navigation section.
 *
 * ⚠️ **The assertions below are over the GENERATED DOCUMENT, not over the declarations.** Reading
 * the source and inferring is what let both defects sit: the fallback is invisible at the
 * declaration site. Only the emitted spec shows which one ran.
 *
 * ⚠️ **Which fallback ran depends on the composition, and only ONE of the two is reachable here.**
 * Generated standalone, an untitled group falls back to `group.identifier` (`server.health`);
 * embedded under `addHttpApi`, it falls back to the outer API's title (`novaclaw HttpApi`). This
 * file cannot exercise the embedded form — `addHttpApi` MUTATES the inner API's group annotations
 * in place, and these groups are module singletons shared with every other test in the process. So
 * the assertion that covers both is *"every group names itself"*: with no group missing a title,
 * neither fallback can fire in any composition. An assertion naming the embedded fallback string
 * would sit here green forever without ever being able to go red, which is not a test.
 */

class TestLocationMiddleware extends HttpApiMiddleware.Service<TestLocationMiddleware>()(
  "@novaclaw/protocol/test/openapi-tags/LocationMiddleware",
) {}

class TestSessionLocationMiddleware extends HttpApiMiddleware.Service<TestSessionLocationMiddleware>()(
  "@novaclaw/protocol/test/openapi-tags/SessionLocationMiddleware",
  { error: [InvalidRequestError, SessionNotFoundError] },
) {}

class TestWorkspaceRoutingMiddleware extends HttpApiMiddleware.Service<TestWorkspaceRoutingMiddleware>()(
  "@novaclaw/protocol/test/openapi-tags/WorkspaceRoutingMiddleware",
) {}

const Api = makeDefaultApi({
  locationMiddleware: TestLocationMiddleware,
  sessionLocationMiddleware: TestSessionLocationMiddleware,
  workspaceRoutingMiddleware: TestWorkspaceRoutingMiddleware,
})

type Tag = { readonly name: string; readonly description?: string }
type Operation = { readonly tags?: readonly string[] }
type Spec = {
  readonly info: { readonly title: string; readonly description?: string }
  readonly tags: readonly Tag[]
  readonly paths: Record<string, Record<string, Operation | undefined>>
}

const spec = OpenApi.fromApi(Api) as unknown as Spec

const METHODS = ["get", "post", "put", "delete", "patch"] as const

const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  METHODS.flatMap((method) => {
    const operation = item[method]
    return operation ? [{ route: `${method.toUpperCase()} ${path}`, tags: operation.tags ?? [] }] : []
  }),
)

const groupsWithoutTitle: string[] = []
HttpApi.reflect(Api, {
  onGroup({ group }) {
    if (Context.getOrElse(group.annotations, OpenApi.Title, () => undefined) === undefined)
      groupsWithoutTitle.push(group.identifier)
  },
  onEndpoint() {},
})

describe("the OpenAPI taxonomy", () => {
  test("the sweep found the whole surface", () => {
    // A guard over an empty document passes for the wrong reason. Both floors are the counts at the
    // time of writing, asserted as floors so adding a group or a route never silently empties this.
    expect(spec.tags.length).toBeGreaterThanOrEqual(29)
    expect(operations.length).toBeGreaterThanOrEqual(140)
  })

  test("every group names itself, so no operation is filed under a fallback", () => {
    expect(groupsWithoutTitle).toEqual([])
  })

  test("no operation is tagged with its group's identifier", () => {
    // The other fallback: `Context.getOrElse(group.annotations, Title, () => group.identifier)`.
    // Every real tag is a human-readable name, never a `server.*` handle.
    const filedUnderAnIdentifier = operations.filter((operation) =>
      operation.tags.some((tag) => tag.startsWith("server.")),
    )
    expect(filedUnderAnIdentifier.map((operation) => operation.route)).toEqual([])
  })

  test("tag names are unique, as OpenAPI 3.1 requires", () => {
    const names = spec.tags.map((tag) => tag.name)
    const duplicated = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))]
    expect(duplicated).toEqual([])
  })

  test("every tag an operation carries is one the document declares", () => {
    const declared = new Set(spec.tags.map((tag) => tag.name))
    const undeclared = operations.filter((operation) => operation.tags.some((tag) => !declared.has(tag)))
    expect(undeclared.map((operation) => `${operation.route} -> ${operation.tags.join(",")}`)).toEqual([])
  })

  test("every tag says what its section is", () => {
    const silent = spec.tags.filter((tag) => (tag.description ?? "").trim() === "")
    expect(silent.map((tag) => tag.name)).toEqual([])
  })

  test("every operation carries exactly one tag", () => {
    const wrong = operations.filter((operation) => operation.tags.length !== 1)
    expect(wrong.map((operation) => `${operation.route} -> ${operation.tags.length}`)).toEqual([])
  })
})

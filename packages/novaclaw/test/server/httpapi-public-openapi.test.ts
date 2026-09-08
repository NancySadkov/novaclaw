import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { CommunityPeerPaths } from "../../src/server/routes/instance/httpapi/groups/community"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

type Method = "get" | "post" | "put" | "delete" | "patch"
type OpenApiSchema = {
  readonly $ref?: string
  readonly anyOf?: ReadonlyArray<OpenApiSchema>
  readonly type?: string
  readonly enum?: readonly unknown[]
  readonly properties?: Record<string, OpenApiSchema>
  readonly required?: readonly string[]
  readonly contentSchema?: OpenApiSchema
  readonly contentMediaType?: string
}
type OpenApiResponse = {
  readonly description?: string
  readonly content?: Record<string, { readonly schema?: OpenApiSchema }>
}
type OpenApiOperation = {
  readonly parameters?: ReadonlyArray<{
    readonly name: string
    readonly in: string
    readonly required?: boolean
    readonly schema?: { readonly type?: string }
  }>
  readonly responses?: Record<string, OpenApiResponse>
  readonly requestBody?: { readonly required?: boolean }
  readonly security?: unknown
}
type OpenApiPathItem = Partial<Record<Method, OpenApiOperation>>
type OpenApiSpec = {
  readonly paths: Record<string, OpenApiPathItem>
  readonly components: { readonly schemas: Record<string, OpenApiSchema> }
}

const methods = ["get", "post", "put", "delete", "patch"] as const

const allowedV2BuiltInEndpointErrors: string[] = []

function v2Operations(spec: OpenApiSpec) {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    path.startsWith("/api/")
      ? methods.flatMap((method) => {
          const operation = item[method]
          return operation ? [{ method, path, operation }] : []
        })
      : [],
  )
}

function responseRef(response: OpenApiResponse | undefined) {
  return response?.content?.["application/json"]?.schema?.$ref
}

function componentName(ref: string) {
  return ref.replace("#/components/schemas/", "")
}

function componentNames(response: OpenApiResponse | undefined) {
  const schema = response?.content?.["application/json"]?.schema
  if (!schema) return []
  return [
    ...new Set([schema, ...(schema.anyOf ?? [])].flatMap((item) => (item.$ref ? [componentName(item.$ref)] : []))),
  ]
}

function isBuiltInEndpointError(name: string) {
  return name.startsWith("EffectHttpApiError") || name.startsWith("effect_HttpApiError_")
}

describe("PublicApi OpenAPI v2 errors", () => {
  test("includes plugin-facing core schemas", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining([
        "CredentialValue",
        "IntegrationInputs",
        "IntegrationMethod",
        "IntegrationRef",
        "SkillV2Source",
      ]),
    )
  })

  test("documents nested global sync events", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const schema = spec.components.schemas.SyncEventSessionCreated

    expect(schema?.required).toEqual(["type", "id", "syncEvent"])
    expect(schema?.properties?.type?.enum).toEqual(["sync"])
    expect(schema?.properties?.syncEvent).toMatchObject({
      required: ["type", "id", "seq", "aggregateID", "data"],
      properties: {
        type: { enum: ["session.created.2"] },
        id: { type: "string" },
        seq: { type: "number" },
        aggregateID: { type: "string" },
      },
    })
  })

  test("names the v2 event union without the SSE string wrapper collision", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    expect(spec.components.schemas.V2Event1).toBeUndefined()
    expect(spec.components.schemas.V2Event?.anyOf?.length).toBeGreaterThan(0)
    expect(spec.components.schemas.V2EventStream).toMatchObject({
      type: "string",
      contentMediaType: "application/json",
      contentSchema: { $ref: "#/components/schemas/V2Event" },
    })
    expect(spec.paths["/api/event"]?.get?.responses?.["200"]?.content?.["text/event-stream"]?.schema).toEqual({
      $ref: "#/components/schemas/V2Event",
    })
  })

  /**
   * 🔴 The routes that are UNAUTHENTICATED on purpose — derived from the peer group, not listed here.
   *
   * A hand-written list was the first attempt and it was wrong three times in a row: every time the
   * P2P surface grew a route I had to remember to add an entry, and the guard failed on work that was
   * entirely correct. That is a guard tracking a copy of the design instead of the design.
   *
   * `CommunityPeerPaths` IS the boundary. Every route in that group is open by definition — it is the
   * peer-to-peer surface, and a node that answers only callers holding this instance's token is a
   * private federation rather than a community. What protects it is the ingress door, not a
   * credential: proof-of-work first (0.83 µs to check, ~49 ms for a sender to produce), then
   * signature, subscription, block, size and duplicate rules. They stay in the public spec on purpose
   * — a stranger building a compatible peer needs the protocol documented.
   *
   * ⚠️ The protection this keeps: a route open ANYWHERE ELSE still fails, and every peer route is
   * asserted to actually BE open, so putting one behind auth fails too and asks for this to be
   * revisited. Deriving it removes the bookkeeping, never the check.
   */
  const openByDesign = new Set<string>(Object.values(CommunityPeerPaths))

  test("preserves /api auth responses", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    const openSeen = new Set<string>()
    for (const route of v2Operations(spec)) {
      const name = `${route.method.toUpperCase()} ${route.path}`
      if (openByDesign.has(route.path)) {
        // ⚠️ Asserted to be open, not merely skipped: a route that quietly gained auth would leave
        // this exemption silently untrue, which is how a guard turns into decoration.
        expect(route.operation.responses?.["401"], `${name} is open by design but now declares 401`).toBeUndefined()
        openSeen.add(route.path)
        continue
      }
      expect(route.operation.responses?.["401"], name).toBeDefined()
      expect(route.operation.security, name).toEqual([])
    }
    /**
     * Every declared peer path is actually served — a typo in the group would otherwise make this
     * exemption cover nothing while looking thorough.
     *
     * ⚠️ Compares the SET of paths, not a count. The first version counted OPERATIONS against the
     * number of paths, which was the same number right up until one path served two methods — the
     * succession endpoint is POST to tell and GET to ask — and then failed on work that was entirely
     * correct. A guard that miscounts is a guard people learn to silence.
     */
    expect([...openSeen].sort()).toEqual([...openByDesign].sort())
  })

  test("documents references separately from filesystem routes", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const path of ["/api/fs/read/*", "/api/fs/list"]) {
      expect(spec.paths[path]?.get?.parameters, path).not.toContainEqual(expect.objectContaining({ name: "reference" }))
    }
    expect(spec.paths["/api/reference"]?.get).toBeDefined()
  })

  test("preserves required request bodies for v2 mutations", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const path of ["/api/session/{sessionID}/prompt"]) {
      expect(spec.paths[path]?.post?.requestBody?.required, path).toBe(true)
    }
  })

  test("documents integration discovery and connection routes", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const [method, path] of [
      ["get", "/api/integration"],
      ["get", "/api/integration/{integrationID}"],
      ["post", "/api/integration/{integrationID}/connect/key"],
      ["post", "/api/integration/{integrationID}/connect/oauth"],
      ["get", "/api/integration/attempt/{attemptID}"],
      ["post", "/api/integration/attempt/{attemptID}/complete"],
      ["delete", "/api/integration/attempt/{attemptID}"],
      ["delete", "/api/credential/{credentialID}"],
      ["patch", "/api/credential/{credentialID}"],
    ] as const) {
      expect(spec.paths[path]?.[method], `${method.toUpperCase()} ${path}`).toBeDefined()
    }

    for (const path of [
      "/api/integration/{integrationID}/connect/key",
      "/api/integration/{integrationID}/connect/oauth",
      "/api/integration/attempt/{attemptID}/complete",
    ]) {
      expect(spec.paths[path]?.post?.requestBody?.required, path).toBe(true)
    }
  })

  test("does not rewrite /api endpoint errors to legacy error components", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const refs = v2Operations(spec)
      .flatMap((route) =>
        Object.entries(route.operation.responses ?? {}).flatMap(([status, response]) => {
          const ref = responseRef(response)
          return ref ? [`${route.method.toUpperCase()} ${route.path} ${status} ${componentName(ref)}`] : []
        }),
      )
      .filter((entry) => entry.endsWith(" BadRequestError") || entry.endsWith(" NotFoundError"))

    expect(refs).toEqual([])
  })

  test("new /api endpoint errors cannot use built-in components without an explicit allowlist", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const builtInEndpointErrors = v2Operations(spec)
      .flatMap((route) =>
        Object.entries(route.operation.responses ?? {}).flatMap(([status, response]) => {
          if (status === "401") return []
          const ref = responseRef(response)
          if (!ref) return []
          const name = componentName(ref)
          return isBuiltInEndpointError(name) ? [`${route.method.toUpperCase()} ${route.path} ${status} ${name}`] : []
        }),
      )
      .sort()

    expect(builtInEndpointErrors).toEqual(allowedV2BuiltInEndpointErrors)
  })

  test("documents v2 provider and model catalog errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    expect(componentName(responseRef(spec.paths["/api/provider"]?.get?.responses?.["503"]) ?? "")).toBe(
      "ServiceUnavailableError",
    )
    expect(componentName(responseRef(spec.paths["/api/model"]?.get?.responses?.["503"]) ?? "")).toBe(
      "ServiceUnavailableError",
    )
    expect(componentName(responseRef(spec.paths["/api/provider/{providerID}"]?.get?.responses?.["404"]) ?? "")).toBe(
      "ProviderNotFoundError",
    )
    expect(componentName(responseRef(spec.paths["/api/provider/{providerID}"]?.get?.responses?.["503"]) ?? "")).toBe(
      "ServiceUnavailableError",
    )
  })

  test("documents v2 session not-found errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["post", "/api/session/{sessionID}/prompt"],
      ["post", "/api/session/{sessionID}/compact"],
      ["post", "/api/session/{sessionID}/wait"],
      ["get", "/api/session/{sessionID}/context"],
      ["get", "/api/session/{sessionID}/message"],
    ] as const) {
      expect(componentNames(spec.paths[route[1]]?.[route[0]]?.responses?.["404"])).toContain("SessionNotFoundError")
    }
  })

  test("documents v2 unfinished session mutation errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["post", "/api/session/{sessionID}/compact"],
      ["post", "/api/session/{sessionID}/wait"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["503"]) ?? "")).toBe(
        "ServiceUnavailableError",
      )
    }
  })

  test("documents v2 session read data errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["get", "/api/session/{sessionID}/context"],
      ["get", "/api/session/{sessionID}/message"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["500"]) ?? "")).toMatch(
        /^UnknownError\d*$/,
      )
    }
  })

  test("the retired question sideband stays absent from the live API", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    expect(Object.keys(spec.paths).filter((path) => path.split("/").includes("question"))).toEqual([])
    expect(Object.keys(spec.components?.schemas ?? {}).filter((name) => /Question/.test(name))).toEqual([])
  })

  /**
   * **The V1 `/permission` routes stay deleted**; the legacy surface is shrink-only.
   *
   * ⚠️ **Why this lives here and not only in the legacy-path ledger.**
   * `packages/sdk/js/test/legacy-path-ledger.test.ts` is the repo's shrink-only ratchet, and it does
   * cover this — but it reads the **committed** `packages/sdk/openapi.json`, so it only sees a
   * re-added group after a regen. This assertion reads the **live** API, so re-adding
   * `PermissionApi` to `api.ts` is red in the same edit that adds it, with no generated artifact in
   * between. Two different doors; ruling 1 wants the one that shuts immediately.
   */
  test("the V1 and pending-request permission routes stay deleted", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const isLegacyPermissionPath = (path: string) => path === "/permission" || path.startsWith("/permission/")

    expect(
      Object.keys(spec.paths).filter(isLegacyPermissionPath),
      [
        "The V1 permission routes are back. They served the V1 engine's asks ONLY and the V1 engine",
        "is gone. Declare permission work",
        "under /api/* in packages/protocol/src/groups/permission.ts — that is the ONE contract.",
      ].join("\n  "),
    ).toEqual([])

    // Negative control: the predicate above is not vacuously true — it DOES name those two paths
    // when they exist, and it never mistakes the /api/* replacement for one of them.
    expect(
      ["/permission", "/permission/{requestID}/reply", "/api/permission/request"].filter(isLegacyPermissionPath),
    ).toEqual(["/permission", "/permission/{requestID}/reply"])

    // Evaluation remains served while the unreachable pending-list and reply surfaces stay absent.
    expect(spec.paths["/api/session/{sessionID}/permission"]?.post).toBeDefined()
    expect(spec.paths["/api/permission/request"]?.get).toBeUndefined()
    expect(spec.paths["/api/session/{sessionID}/permission/{requestID}/reply"]?.post).toBeUndefined()
  })

  test("documents MCP server not-found errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["post", "/mcp/{name}/auth"],
      ["post", "/mcp/{name}/auth/authenticate"],
      ["post", "/mcp/{name}/auth/callback"],
      ["delete", "/mcp/{name}/auth"],
      ["post", "/mcp/{name}/connect"],
      ["post", "/mcp/{name}/disconnect"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["404"]) ?? "")).toBe(
        "McpServerNotFoundError",
      )
    }
  })

  test("documents PTY resource and ticket errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["get", "/api/pty/{ptyID}"],
      ["put", "/api/pty/{ptyID}"],
      ["delete", "/api/pty/{ptyID}"],
      ["post", "/api/pty/{ptyID}/connect-token"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["404"]) ?? "")).toBe(
        "PtyNotFoundError",
      )
    }
    expect(
      componentName(responseRef(spec.paths["/api/pty/{ptyID}/connect-token"]?.post?.responses?.["403"]) ?? ""),
    ).toBe("ForbiddenError")
    expect(
      spec.paths["/api/pty/{ptyID}/connect"]?.get?.parameters
        ?.filter((parameter) => parameter.in === "query")
        .map((parameter) => parameter.name),
    ).toEqual(["location[directory]", "location[workspace]", "cursor", "ticket"])
  })
})

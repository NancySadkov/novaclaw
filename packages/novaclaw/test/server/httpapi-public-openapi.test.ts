import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
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

  test("preserves /api auth responses", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of v2Operations(spec)) {
      expect(route.operation.responses?.["401"], `${route.method.toUpperCase()} ${route.path}`).toBeDefined()
      expect(route.operation.security, `${route.method.toUpperCase()} ${route.path}`).toEqual([])
    }
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

    for (const path of [
      "/api/session/{sessionID}/prompt",
      "/api/session/{sessionID}/permission/{requestID}/reply",
      "/api/session/{sessionID}/question/{requestID}/reply",
    ]) {
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

  test("documents permission and question not-found errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    // The V1 `/permission/{requestID}/reply` assertion that stood here was re-pointed at the native
    // route when the V1 permission routes were deleted (v0.2.0-prep Wave 4 §5). The V2 route carries
    // BOTH not-founds, so this is strictly more than the legacy one asserted.
    expect(
      componentNames(spec.paths["/api/session/{sessionID}/permission/{requestID}/reply"]?.post?.responses?.["404"]),
    ).toEqual(["PermissionNotFoundError", "SessionNotFoundError"])
    for (const route of [
      ["post", "/question/{requestID}/reply"],
      ["post", "/question/{requestID}/reject"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["404"]) ?? "")).toBe(
        "QuestionNotFoundError",
      )
    }
    for (const route of [
      ["post", "/api/session/{sessionID}/question/{requestID}/reply"],
      ["post", "/api/session/{sessionID}/question/{requestID}/reject"],
    ] as const) {
      expect(componentNames(spec.paths[route[1]]?.[route[0]]?.responses?.["404"])).toEqual([
        "QuestionNotFoundError",
        "SessionNotFoundError",
      ])
    }
  })

  /**
   * **The V1 `/permission` routes stay deleted** (v0.2.0-prep Wave 4 §5, authorised by todo.md's
   * *"we discard all the cruft"*; ruling 11 pins the legacy surface shrink-only).
   *
   * ⚠️ **Why this lives here and not only in the legacy-path ledger.**
   * `packages/sdk/js/test/legacy-path-ledger.test.ts` is the repo's shrink-only ratchet, and it does
   * cover this — but it reads the **committed** `packages/sdk/openapi.json`, so it only sees a
   * re-added group after a regen. This assertion reads the **live** API, so re-adding
   * `PermissionApi` to `api.ts` is red in the same edit that adds it, with no generated artifact in
   * between. Two different doors; ruling 1 wants the one that shuts immediately.
   */
  test("the V1 /permission routes stay deleted, and the V2 surface carries the asks", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const isLegacyPermissionPath = (path: string) => path === "/permission" || path.startsWith("/permission/")

    expect(
      Object.keys(spec.paths).filter(isLegacyPermissionPath),
      [
        "The V1 permission routes are back. They served the V1 engine's asks ONLY and the V1 engine",
        "is gone; a V2-native session's asks ride the routes asserted below. Declare permission work",
        "under /api/* in packages/protocol/src/groups/permission.ts — that is the ONE contract.",
      ].join("\n  "),
    ).toEqual([])

    // Negative control: the predicate above is not vacuously true — it DOES name those two paths
    // when they exist, and it never mistakes the /api/* replacement for one of them.
    expect(
      ["/permission", "/permission/{requestID}/reply", "/api/permission/request"].filter(isLegacyPermissionPath),
    ).toEqual(["/permission", "/permission/{requestID}/reply"])

    // …and the replacement is really served, so this cannot pass by the API being empty.
    expect(spec.paths["/api/permission/request"]?.get, "GET /api/permission/request").toBeDefined()
    expect(
      spec.paths["/api/session/{sessionID}/permission/{requestID}/reply"]?.post,
      "POST /api/session/{sessionID}/permission/{requestID}/reply",
    ).toBeDefined()
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
    ).toBe(
      "ForbiddenError",
    )
    expect(
      spec.paths["/api/pty/{ptyID}/connect"]?.get?.parameters
        ?.filter((parameter) => parameter.in === "query")
        .map((parameter) => parameter.name),
    ).toEqual(["location[directory]", "location[workspace]", "cursor", "ticket"])
  })

})

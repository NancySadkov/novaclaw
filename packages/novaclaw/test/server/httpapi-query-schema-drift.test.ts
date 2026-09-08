import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import {
  FilePaths,
  FileQuery,
  FindFileQuery,
  FindTextQuery,
} from "../../src/server/routes/instance/httpapi/groups/file"
import { VcsDiffQuery } from "@novaclaw/protocol/groups/vcs"
import { PtyPaths } from "@novaclaw/protocol/groups/pty"
import { SessionMessagesQuery } from "@novaclaw/protocol/groups/message"
import { QueryBoolean, QueryBooleanOpenApi } from "../../src/server/routes/instance/httpapi/groups/query"
import { it } from "../lib/effect"

type Method = "get" | "post" | "put" | "delete" | "patch"
type QuerySchema = { readonly fields: Record<string, unknown> }
type OpenApiSchema = {
  readonly anyOf?: readonly OpenApiSchema[]
  readonly enum?: readonly string[]
  readonly maximum?: number
  readonly minimum?: number
  readonly pattern?: string
  readonly type?: string
}
type OpenApiParameter = { readonly name: string; readonly in: string; readonly schema?: OpenApiSchema }
type OpenApiOperation = { readonly parameters?: readonly OpenApiParameter[] }

const openApiDriftRoutes = [
  { method: "get", path: FilePaths.findFile, query: FindFileQuery },
  { method: "get", path: FilePaths.findText, query: FindTextQuery },
  { method: "get", path: FilePaths.list, query: FileQuery },
  // Re-pointed 2026-09-03: the row moved from the legacy `/vcs/diff` to the contract route with
  // the family. The invariant is the same one — the served spec's query parameters must match the
  // schema the route declares - and it survived the move rather than leaving with it.
  { method: "get", path: "/api/vcs/diff", query: VcsDiffQuery },
  { method: "get", path: "/api/session/:sessionID/message", query: SessionMessagesQuery },
] satisfies Array<{ method: Method; path: string; query: QuerySchema }>

const numericSdkQueryParams = [
  { method: "get", path: FilePaths.findFile, name: "limit", schema: { type: "integer", minimum: 1, maximum: 200 } },
  { method: "get", path: "/api/session/:sessionID/message", name: "limit", schema: { type: "number" } },
] satisfies Array<{ method: Method; path: string; name: string; schema: OpenApiSchema }>

// V1-nuke slice D: emptied — every entry was a bare-/session or experimental-session row.
const booleanSdkQueryParams: Array<{ method: Method; path: string; name: string }> = []

const queryParamPatterns: Array<{ method: Method; path: string; name: string; pattern: string }> = []

// Session message reads brand both path parameters; keep this invariant on a live route.
const pathParamPatterns = [
  {
    method: "get",
    path: "/api/session/:sessionID/message/:messageID",
    name: "messageID",
    pattern: "^msg_",
  },
  {
    method: "get",
    path: "/api/session/:sessionID/message/:messageID",
    name: "sessionID",
    pattern: "^ses",
  },
  { method: "put", path: PtyPaths.update, name: "ptyID", pattern: "^pty" },
] satisfies Array<{ method: Method; path: string; name: string; pattern: string }>

function openApiPath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")
}

function queryParameters(operation: OpenApiOperation | undefined) {
  return (operation?.parameters ?? []).filter((param) => param.in === "query").map((param) => param.name)
}

function queryParameter(operation: OpenApiOperation | undefined, name: string) {
  return (operation?.parameters ?? []).find((param) => param.in === "query" && param.name === name)
}

function pathParameter(operation: OpenApiOperation | undefined, name: string) {
  return (operation?.parameters ?? []).find((param) => param.in === "path" && param.name === name)
}

function assertAdvertisedQueryParamsAreRuntimeFields(input: {
  readonly method: Method
  readonly operation: OpenApiOperation | undefined
  readonly path: string
  readonly query: QuerySchema
}) {
  const runtimeFields = new Set(Object.keys(input.query.fields))
  const advertisedOnly = queryParameters(input.operation).filter((name) => !runtimeFields.has(name))

  expect(
    advertisedOnly,
    `${input.method.toUpperCase()} ${input.path} advertises query params not accepted by runtime schema`,
  ).toEqual([])
}

// Regression for the class where OpenAPI advertises query fields that the runtime decoder does not
// accept. Keep this suite on the current contract routes: the old V1 live probes were deleted with
// their routes, and a 404 from one of those probes was the false-green failure this suite existed
// to prevent.
describe("httpapi query schema drift", () => {
  it.effect(
    "boolean query schema accepts only true and false strings",
    Effect.sync(() => {
      const decode = Schema.decodeUnknownSync(QueryBoolean)
      const encode = Schema.encodeUnknownSync(QueryBoolean)

      expect(decode("true")).toBe(true)
      expect(decode("false")).toBe(false)
      expect(encode(true)).toBe("true")
      expect(encode(false)).toBe("false")

      for (const input of ["1", "yes", "True", "", true, false]) {
        expect(() => decode(input)).toThrow()
      }
    }),
  )

  it.effect(
    "OpenAPI query params are declared by runtime query schemas",
    Effect.sync(() => {
      const spec = OpenApi.fromApi(PublicApi)
      for (const route of openApiDriftRoutes) {
        assertAdvertisedQueryParamsAreRuntimeFields({
          ...route,
          operation: spec.paths[openApiPath(route.path)]?.[route.method],
        })
      }
    }),
  )

  it.effect(
    "OpenAPI query and path schemas preserve compatibility metadata",
    Effect.sync(() => {
      const spec = OpenApi.fromApi(PublicApi)
      for (const expected of numericSdkQueryParams) {
        expect(
          queryParameter(spec.paths[openApiPath(expected.path)]?.[expected.method], expected.name)?.schema,
          `${expected.method.toUpperCase()} ${expected.path} ${expected.name}`,
        ).toEqual(expected.schema)
      }
      for (const expected of booleanSdkQueryParams) {
        expect(
          queryParameter(spec.paths[openApiPath(expected.path)]?.[expected.method], expected.name)?.schema,
          `${expected.method.toUpperCase()} ${expected.path} ${expected.name}`,
        ).toEqual(QueryBooleanOpenApi)
      }
      for (const expected of queryParamPatterns) {
        expect(
          queryParameter(spec.paths[openApiPath(expected.path)]?.[expected.method], expected.name)?.schema,
          `${expected.method.toUpperCase()} ${expected.path} ${expected.name}`,
        ).toEqual({ type: "string", pattern: expected.pattern })
      }
      for (const expected of pathParamPatterns) {
        expect(
          pathParameter(spec.paths[openApiPath(expected.path)]?.[expected.method], expected.name)?.schema,
          `${expected.method.toUpperCase()} ${expected.path} ${expected.name}`,
        ).toEqual({ type: "string", pattern: expected.pattern })
      }
    }),
  )

  it.effect(
    "drift assertion catches spec-only workspace query params",
    Effect.sync(() => {
      expect(() =>
        assertAdvertisedQueryParamsAreRuntimeFields({
          method: "get",
          operation: {
            parameters: [
              { name: "directory", in: "query" },
              { name: "workspace", in: "query" },
            ],
          },
          path: "/fixture",
          query: Schema.Struct({}),
        }),
      ).toThrow("advertises query params not accepted by runtime schema")
    }),
  )
})

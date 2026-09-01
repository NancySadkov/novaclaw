import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { emit } from "../script/emitter"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function output() {
  const root = await mkdtemp(path.join(os.tmpdir(), "novaclaw-sdk-emitter-"))
  roots.push(root)
  return root
}

describe("the owned OpenAPI emitter", () => {
  test("the build reads the one committed contract and has no third-party emitter", async () => {
    const packageRoot = path.resolve(import.meta.dir, "..")
    const build = await Bun.file(path.join(packageRoot, "script/build.ts")).text()
    const manifest = await Bun.file(path.join(packageRoot, "package.json")).text()
    expect(build).toContain('path.resolve(dir, "../openapi.json")')
    expect(build).not.toContain('Bun.file("./openapi.json")')
    expect(build).not.toContain("@hey-api")
    expect(manifest).not.toContain("@hey-api/openapi-ts")
  })

  test("names schemas, resolves collisions, and builds the operation tree deterministically", async () => {
    const document = {
      components: {
        schemas: {
          "thing.status": { type: "string", enum: ["ready"] },
          ThingStatus: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          ToolIDs: { type: "array", items: { type: "string" } },
        },
      },
      paths: {
        "/thing/{id}": {
          post: {
            operationId: "thing.status.set",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
                },
              },
            },
            responses: {
              200: { content: { "application/json": { schema: { $ref: "#/components/schemas/ThingStatus" } } } },
            },
          },
        },
      },
    }
    const first = await output()
    const second = await output()
    await emit(document as any, first)
    await emit(document as any, second)

    const types = await Bun.file(path.join(first, "types.gen.ts")).text()
    const sdk = await Bun.file(path.join(first, "sdk.gen.ts")).text()
    expect(types).toContain('export type ThingStatus = "ready"')
    expect(types).toContain("export type ThingStatus2 = {")
    expect(types).toContain("export type ToolIds = Array<string>")
    expect(sdk).toContain("class ApiThingStatus extends NovaClawApiClient")
    expect(sdk).toContain("public set<ThrowOnError extends boolean = false>")
    expect(await Bun.file(path.join(second, "types.gen.ts")).text()).toBe(types)
    expect(await Bun.file(path.join(second, "sdk.gen.ts")).text()).toBe(sdk)
  })

  test("keeps colliding body and query fields independently addressable", async () => {
    const root = await output()
    await emit(
      {
        components: { schemas: {} },
        paths: {
          "/sync": {
            post: {
              operationId: "sync.replay",
              parameters: [{ name: "directory", in: "query", schema: { type: "string" } }],
              requestBody: {
                content: {
                  "application/json": {
                    schema: { type: "object", properties: { directory: { type: "string" } } },
                  },
                },
              },
              responses: { 204: {} },
            },
          },
        },
      } as any,
      root,
    )
    const sdk = await Bun.file(path.join(root, "sdk.gen.ts")).text()
    expect(sdk).toContain("query_directory?: string")
    expect(sdk).toContain("body_directory?: string")
    expect(sdk).toContain('const query = { "directory": parameters?.["query_directory"] }')
    expect(sdk).toContain('const body = { "directory": parameters?.["body_directory"] }')
  })

  test("keeps binary request bodies raw and emits their declared media type", async () => {
    const root = await output()
    await emit(
      {
        components: { schemas: {} },
        paths: {
          "/archive": {
            post: {
              operationId: "archive.import",
              requestBody: {
                required: true,
                content: {
                  "application/zip": { schema: { type: "string", format: "binary" } },
                },
              },
              responses: { 204: {} },
            },
          },
        },
      } as any,
      root,
    )
    const types = await Bun.file(path.join(root, "types.gen.ts")).text()
    const sdk = await Bun.file(path.join(root, "sdk.gen.ts")).text()
    expect(types).toContain("body: Blob | File")
    expect(sdk).toContain("bodySerializer: null")
    expect(sdk).toContain('headers: { "Content-Type": "application/zip", ...options?.headers }')
  })
})

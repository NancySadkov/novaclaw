import { describe, expect, test } from "bun:test"
import { ToolDefinition } from "@novaclaw/llm"
import { Database } from "@novaclaw/core/database/database"
import { ToolCatalogue } from "@novaclaw/core/tool-catalogue"
import { ToolCatalogueGuidance } from "@novaclaw/core/tool-catalogue-guidance"
import { ToolCatalogueStore } from "@novaclaw/core/tool-catalogue-store"
import { Effect, Layer } from "effect"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"

const source = (name: string, server: string, description: string): ToolCatalogue.Source => ({
  server,
  definition: new ToolDefinition({
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string", description: "Repository name" },
        title: { type: "string", description: "Issue title" },
      },
      required: ["repository", "title"],
    },
  }),
})

describe("ToolCatalogue", () => {
  test("extracts argument metadata and deterministic index-only vocabulary", () => {
    expect(ToolCatalogue.rows("/work", [source("github_create_issue", "github", "Creates an issue")])).toEqual([
      {
        scope: "/work",
        name: "github_create_issue",
        server: "github",
        description: "Creates an issue",
        argument_names: "repository title",
        arguments: [
          { name: "repository", description: "Repository name" },
          { name: "title", description: "Issue title" },
        ],
        input_schema: {
          type: "object",
          properties: {
            repository: { type: "string", description: "Repository name" },
            title: { type: "string", description: "Issue title" },
          },
          required: ["repository", "title"],
        },
        keywords: expect.stringContaining("bug"),
      },
    ])
  })

  test("renders categories only and bounds a many-server manifest", () => {
    const sources = [
      source("read", "core", "SECRET DESCRIPTION"),
      source("github_create_issue", "github", "SECRET DESCRIPTION"),
      ...Array.from({ length: 1_000 }, (_, index) =>
        source(`server${index}_search_records`, `server${index}`, "SECRET DESCRIPTION"),
      ),
    ]
    const rendered = ToolCatalogueGuidance.render(ToolCatalogue.manifest(sources))

    expect(rendered).toContain("core — files")
    expect(rendered).toContain("github — issue")
    expect(rendered).toContain("more servers catalogued")
    expect(rendered).not.toContain("SECRET DESCRIPTION")
    expect(rendered.length).toBeLessThanOrEqual(6_100)
  })

  test("derives stable source labels from namespaced external tools", () => {
    expect(ToolCatalogue.externalServer("github_create_issue")).toBe("github")
    expect(ToolCatalogue.externalServer("standalone")).toBe("external")
  })
})

test("ToolCatalogueStore lazily indexes, searches, scopes, and replaces catalogue rows", async () => {
  await using tmp = await tmpdir()
  const layer = ToolCatalogueStore.layer.pipe(
    Layer.provide(Database.layerFromPath(path.join(tmp.path, "catalogue.sqlite"))),
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ToolCatalogueStore.Service
      const issue = ToolCatalogue.rows("/alpha", [source("github_create_issue", "github", "Creates an issue")])
      const users = ToolCatalogue.rows("/beta", [source("github_list_users", "github", "Lists users")])

      yield* store.replace("/alpha", issue)
      yield* store.replace("/beta", users)
      expect(yield* store.search("/alpha", "file bug")).toMatchObject([
        {
          name: "github_create_issue",
          server: "github",
          arguments: [
            { name: "repository", description: "Repository name" },
            { name: "title", description: "Issue title" },
          ],
          inputSchema: { type: "object" },
        },
      ])
      expect(yield* store.search("/beta", "file bug")).toEqual([])
      expect(yield* store.search("/alpha", "file bug", 5, new Set(["github_create_issue"]))).toHaveLength(1)
      expect(yield* store.search("/alpha", "file bug", 5, new Set(["github_list_users"]))).toEqual([])
      expect(yield* store.search("/alpha", "file bug", 5, new Set())).toEqual([])

      yield* store.replace("/alpha", [])
      expect(yield* store.search("/alpha", "file bug")).toEqual([])

      const bulk = ToolCatalogue.rows(
        "/bulk",
        Array.from({ length: 1_001 }, (_, index) =>
          source(`bulk_search_record_${index}`, "bulk", `Search record ${index}`),
        ),
      )
      yield* store.replace("/bulk", bulk)
      expect((yield* store.search("/bulk", "record 1000"))[0]?.name).toBe("bulk_search_record_1000")
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
})

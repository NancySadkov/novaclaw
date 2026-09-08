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
    expect(ToolCatalogue.rows("/work", [source("tracker_create_issue", "tracker", "Creates an issue")])).toEqual([
      {
        scope: "/work",
        name: "tracker_create_issue",
        server: "tracker",
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
      source("issue_create_ticket", "issue", "SECRET DESCRIPTION"),
      ...Array.from({ length: 1_000 }, (_, index) =>
        source(`server${index}_search_records`, `server${index}`, "SECRET DESCRIPTION"),
      ),
    ]
    const rendered = ToolCatalogueGuidance.render(ToolCatalogue.manifest(sources))

    expect(rendered).toContain("core — files")
    expect(rendered).toContain("issue — ticket")
    expect(rendered).toContain("more servers catalogued")
    expect(rendered).not.toContain("SECRET DESCRIPTION")
    expect(rendered.length).toBeLessThanOrEqual(6_100)
  })

  test("derives stable source labels from namespaced external tools", () => {
    expect(ToolCatalogue.externalServer("tracker_create_issue")).toBe("tracker")
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
      const issue = ToolCatalogue.rows("/alpha", [source("tracker_create_issue", "tracker", "Creates an issue")])
      const users = ToolCatalogue.rows("/beta", [source("tracker_list_users", "tracker", "Lists users")])

      yield* store.replace("/alpha", issue)
      yield* store.replace("/beta", users)
      expect(yield* store.search("/alpha", "file bug")).toMatchObject([
        {
          name: "tracker_create_issue",
          server: "tracker",
          arguments: [
            { name: "repository", description: "Repository name" },
            { name: "title", description: "Issue title" },
          ],
          inputSchema: { type: "object" },
        },
      ])
      expect(yield* store.search("/beta", "file bug")).toEqual([])
      expect(yield* store.search("/alpha", "file bug", 5, new Set(["tracker_create_issue"]))).toHaveLength(1)
      expect(yield* store.search("/alpha", "file bug", 5, new Set(["tracker_list_users"]))).toEqual([])
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

      // ⚠️ The reason the match is OR rather than AND, pinned. A plain-language request carries
      // words no tool description contains ("for me", "please"), and ANDing every token made the
      // whole query miss: measured 3/15 top-5 recall with 11 EMPTY results over a 15-request corpus
      // against the live catalogue, versus 10/15 and zero empties for OR. The line above is the
      // guard that stops OR becoming a flood — "record" alone matches all 1,001 rows, and bm25 must
      // still rank the one that also matches "1000" first.
      expect((yield* store.search("/bulk", "please find record 77 for me"))[0]?.name).toBe("bulk_search_record_77")
      expect(yield* store.search("/bulk", "please find it for me")).not.toEqual([])
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
})

export * as ToolCatalogueStore from "./tool-catalogue-store"

import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { ToolCatalogue } from "./tool-catalogue"
import { ToolCatalogueTable } from "./tool-catalogue/sql"

const WRITE_BATCH = 200
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export interface SearchHit {
  readonly name: string
  readonly server: string
  readonly description: string
  readonly arguments: ReadonlyArray<{ readonly name: string; readonly description?: string }>
  readonly inputSchema: unknown
  readonly score: number
}

export interface Interface {
  readonly replace: (scope: string, rows: ReadonlyArray<ToolCatalogue.Row>) => Effect.Effect<void, unknown>
  readonly search: (
    scope: string,
    query: string,
    limit?: number,
    allowedNames?: ReadonlySet<string>,
  ) => Effect.Effect<ReadonlyArray<SearchHit>, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ToolCatalogueStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const indexed = yield* Ref.make(false)
    const fingerprints = new Map<string, string>()

    const ensureIndex = Effect.fn("ToolCatalogueStore.ensureIndex")(function* () {
      if (yield* Ref.get(indexed)) return
      yield* db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS tool_catalogue_fts USING fts5(
          scope UNINDEXED,
          name,
          description,
          argument_names,
          keywords,
          content='tool_catalogue',
          content_rowid='rowid'
        )
      `)
      yield* db.run(`
        CREATE TRIGGER IF NOT EXISTS tool_catalogue_fts_insert AFTER INSERT ON tool_catalogue BEGIN
          INSERT INTO tool_catalogue_fts(rowid, scope, name, description, argument_names, keywords)
          VALUES (new.rowid, new.scope, new.name, new.description, new.argument_names, new.keywords);
        END
      `)
      yield* db.run(`
        CREATE TRIGGER IF NOT EXISTS tool_catalogue_fts_delete AFTER DELETE ON tool_catalogue BEGIN
          INSERT INTO tool_catalogue_fts(tool_catalogue_fts, rowid, scope, name, description, argument_names, keywords)
          VALUES ('delete', old.rowid, old.scope, old.name, old.description, old.argument_names, old.keywords);
        END
      `)
      yield* db.run(`
        CREATE TRIGGER IF NOT EXISTS tool_catalogue_fts_update AFTER UPDATE ON tool_catalogue BEGIN
          INSERT INTO tool_catalogue_fts(tool_catalogue_fts, rowid, scope, name, description, argument_names, keywords)
          VALUES ('delete', old.rowid, old.scope, old.name, old.description, old.argument_names, old.keywords);
          INSERT INTO tool_catalogue_fts(rowid, scope, name, description, argument_names, keywords)
          VALUES (new.rowid, new.scope, new.name, new.description, new.argument_names, new.keywords);
        END
      `)
      yield* db.run("INSERT INTO tool_catalogue_fts(tool_catalogue_fts) VALUES ('rebuild')")
      yield* Ref.set(indexed, true)
    })

    return Service.of({
      replace: Effect.fn("ToolCatalogueStore.replace")(function* (scope, rows) {
        yield* ensureIndex()
        const fingerprint = JSON.stringify(rows)
        if (fingerprints.get(scope) === fingerprint) return
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(ToolCatalogueTable).where(eq(ToolCatalogueTable.scope, scope))
            for (let offset = 0; offset < rows.length; offset += WRITE_BATCH) {
              const batch = rows.slice(offset, offset + WRITE_BATCH)
              if (batch.length > 0) yield* tx.insert(ToolCatalogueTable).values(batch)
              if (offset > 0 && offset % 1_000 === 0)
                yield* tx.run("INSERT INTO tool_catalogue_fts(tool_catalogue_fts, rank) VALUES ('merge', 16)")
            }
          }),
        )
        fingerprints.set(scope, fingerprint)
      }),
      search: Effect.fn("ToolCatalogueStore.search")(function* (scope, query, limit = 5, allowedNames) {
        if (allowedNames !== undefined && allowedNames.size === 0) return []
        yield* ensureIndex()
        const terms = words(query)
        if (terms.length === 0) return []
        // ⚠️ OR, not AND — measured 2026-08-11 against the live 272-row catalogue with 15
        // plain-language requests ("execute a terminal command for me", "take a screenshot"):
        // AND scored 3/15 top-5 recall and returned NOTHING for 11 of them, because it requires
        // every token — including "me", "for", "the" — to appear in the tool's indexed text. OR
        // scores 10/15 with zero empty results over the same corpus and the same bm25 ranking.
        // Ranking is what separates the candidates; ANDing was doing the ranker's job badly and
        // discarding the answer instead.
        //
        // ⚠️ **Do not cite the "remaining 5" as vocabulary gaps — that battery was never committed.**
        // The sentence stood here, was contradicted the same day by a rank dump, and neither run can
        // be re-executed. `tests/tool-search-recall.ts` is the committed replacement and scores
        // **15/15 at top-5 over the 42-tool scope**, every answer at rank 1–4. That is not proof the
        // corpus has no gaps; it is proof that the only reproducible battery shows none. Extend THAT
        // file before claiming a retrieval limit, and before costing a vector rung.
        //
        // ⚠️ Also retire "the live 272-row catalogue" from the commit history's phrasing: 272 is the
        // whole table across SEVEN scopes, and every search filters to one. A query sees ~42.
        const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ")
        const hits = yield* db.all<{
          name: string
          server: string
          description: string
          arguments: string
          inputSchema: string
          score: number
        }>(sql`
          SELECT
            tool_catalogue.name,
            tool_catalogue.server,
            tool_catalogue.description,
            tool_catalogue.arguments,
            tool_catalogue.input_schema AS inputSchema,
            bm25(tool_catalogue_fts) AS score
          FROM tool_catalogue_fts
          JOIN tool_catalogue ON tool_catalogue.rowid = tool_catalogue_fts.rowid
          WHERE tool_catalogue_fts MATCH ${match}
            AND tool_catalogue.scope = ${scope}
            ${
              allowedNames === undefined
                ? sql``
                : sql`AND tool_catalogue.name IN (${sql.join(
                    [...allowedNames].map((name) => sql`${name}`),
                    sql`, `,
                  )})`
            }
          ORDER BY score, tool_catalogue.name
          LIMIT ${Math.max(1, Math.min(50, limit))}
        `)
        return hits.map((hit) => ({
          ...hit,
          arguments: argumentsFrom(Option.getOrElse(decodeJson(hit.arguments), () => [])),
          inputSchema: Option.getOrElse(decodeJson(hit.inputSchema), () => ({})),
        }))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

function words(value: string) {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
}

function argumentsFrom(value: unknown): SearchHit["arguments"] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return []
    const name = Reflect.get(item, "name")
    const description = Reflect.get(item, "description")
    if (typeof name !== "string") return []
    return typeof description === "string" ? [{ name, description }] : [{ name }]
  })
}

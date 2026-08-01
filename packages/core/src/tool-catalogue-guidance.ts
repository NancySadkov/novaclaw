export * as ToolCatalogueGuidance from "./tool-catalogue-guidance"

import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { Location } from "./location"
import { SystemContext } from "./system-context"
import { ToolCatalogue } from "./tool-catalogue"
import { ToolCatalogueStore } from "./tool-catalogue-store"
import { ToolRegistry } from "./tool/registry"

const ManifestLine = Schema.Struct({ server: Schema.String, categories: Schema.Array(Schema.String) })
const MANIFEST_MAX_CHARS = 6_000

export interface Interface {
  readonly load: () => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ToolCatalogueGuidance") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const registry = yield* ToolRegistry.Service
    const store = yield* ToolCatalogueStore.Service

    return Service.of({
      load: Effect.fn("ToolCatalogueGuidance.load")(function* () {
        const sources = yield* registry.catalogue()
        yield* store
          .replace(location.directory, ToolCatalogue.rows(location.directory, sources))
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("tool catalogue index unavailable; continuing with the live manifest", { cause }),
            ),
          )
        const available = ToolCatalogue.manifest(sources)
        return SystemContext.make({
          key: SystemContext.Key.make("core/tool-catalogue"),
          codec: Schema.toCodecJson(Schema.Array(ManifestLine)),
          load: Effect.succeed(available),
          baseline: render,
          update: (_previous, current) =>
            [
              "The installed tool families have changed. This manifest supersedes the previous one.",
              render(current),
            ].join("\n"),
          removed: () => "The installed tool-family manifest is no longer available.",
        })
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node, ToolRegistry.node, ToolCatalogueStore.node],
})

export function render(lines: ReadonlyArray<ToolCatalogue.ManifestLine>) {
  const header = "Installed tool families (category manifest; permitted callable schemas are supplied separately):"
  if (lines.length === 0) return `${header}\n  No tools are currently available.`
  const rendered: string[] = [header, "<tool_catalogue>"]
  for (let index = 0; index < lines.length; index++) {
    const line = `  ${lines[index]!.server} — ${lines[index]!.categories.join(", ")}`
    const remaining = lines.length - index
    if ([...rendered, line, "</tool_catalogue>"].join("\n").length <= MANIFEST_MAX_CHARS) {
      rendered.push(line)
      continue
    }
    rendered.push(`  … ${remaining} more server${remaining === 1 ? "" : "s"} catalogued`)
    break
  }
  rendered.push("</tool_catalogue>")
  return rendered.join("\n")
}

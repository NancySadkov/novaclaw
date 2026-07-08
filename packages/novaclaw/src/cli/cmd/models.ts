import { EOL } from "os"
import { Effect } from "effect"
import { ModelsDev } from "@novaclaw/core/models-dev"
import { Catalog } from "@novaclaw/core/catalog"
import { LocationServiceMap, locationServiceMapLayer } from "@novaclaw/core/location-services"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { ProviderCatalogView } from "@/provider/catalog-view"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: "list all available models",
  // Lists the global catalog; no project state needed. Resolve the V2 Catalog for
  // the cwd through the core location-service map (cf. cli/cmd/debug/v2.ts) and
  // project it onto the V1 provider shape.
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("provider", {
        describe: "provider ID to filter models by",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "use more verbose model output (includes metadata like costs)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the models cache from models.dev",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.models")(function* (args) {
    if (args.refresh) {
      yield* ModelsDev.Service.use((s) => s.refresh(true))
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

    const result = yield* Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providers = yield* catalog.provider.all()
      const models = yield* catalog.model.all()
      const available = yield* catalog.provider.available()
      return ProviderCatalogView.listResult({ providers, models, connected: available.map((p) => p.id) })
    }).pipe(
      Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }))),
      Effect.provide(locationServiceMapLayer),
    )

    const byId = Object.fromEntries(result.all.map((p) => [p.id, p]))

    const print = (providerID: string, verbose?: boolean) => {
      const p = byId[providerID]
      const sorted = Object.entries(p.models).sort(([a], [b]) => a.localeCompare(b))
      for (const [modelID, model] of sorted) {
        process.stdout.write(`${providerID}/${modelID}`)
        process.stdout.write(EOL)
        if (verbose) {
          process.stdout.write(JSON.stringify(model, null, 2))
          process.stdout.write(EOL)
        }
      }
    }

    if (args.provider) {
      if (!byId[args.provider]) return yield* fail(`Provider not found: ${args.provider}`)
      print(args.provider, args.verbose)
      return
    }

    const ids = Object.keys(byId).sort((a, b) => {
      const aIsNovaclaw = a.startsWith("novaclaw")
      const bIsNovaclaw = b.startsWith("novaclaw")
      if (aIsNovaclaw && !bIsNovaclaw) return -1
      if (!aIsNovaclaw && bIsNovaclaw) return 1
      return a.localeCompare(b)
    })

    for (const providerID of ids) print(providerID, args.verbose)
  }),
})

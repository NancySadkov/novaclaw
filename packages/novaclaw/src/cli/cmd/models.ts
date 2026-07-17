import { EOL } from "os"
import { Effect } from "effect"
import { ModelsDev } from "@novaclaw/core/models-dev"
import { Catalog } from "@novaclaw/core/catalog"
import { LocationServiceMap, locationServiceMapLayer } from "@novaclaw/core/location-services"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { ProviderCatalogResult } from "@/provider/catalog-result"
import { Config } from "@/config/config"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: "list all available models",
  // Lists the global catalog; no project state needed. Resolve the V2 Catalog for
  // the cwd through the core location-service map (cf. cli/cmd/debug/v2.ts).
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

    // Config→SQLite step 9: a bare CLI process must run the first-boot IMPORT before the
    // catalog location boots — a fresh install (or an XDG-isolated test) would otherwise
    // list only the ModelsDev defaults, never the user's configured providers. The V1
    // config service's first read runs the idempotent seedAll pass over every store.
    yield* Config.use.getGlobal()

    const result = yield* Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providers = yield* catalog.provider.all()
      const models = yield* catalog.model.all()
      const available = yield* catalog.provider.available()
      return ProviderCatalogResult.listResult({ providers, models, connected: available.map((p) => p.id) })
    }).pipe(
      Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }))),
      Effect.provide(locationServiceMapLayer),
    )

    const byId = new Map(result.providers.map((p) => [p.id as string, p]))
    const modelsByProvider = new Map<string, typeof result.models>()
    for (const model of result.models) {
      const list = modelsByProvider.get(model.providerID) ?? []
      list.push(model)
      modelsByProvider.set(model.providerID, list)
    }

    const print = (providerID: string, verbose?: boolean) => {
      const sorted = (modelsByProvider.get(providerID) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id))
      for (const model of sorted) {
        process.stdout.write(`${providerID}/${model.id}`)
        process.stdout.write(EOL)
        if (verbose) {
          process.stdout.write(JSON.stringify(model, null, 2))
          process.stdout.write(EOL)
        }
      }
    }

    if (args.provider) {
      if (!byId.has(args.provider)) return yield* fail(`Provider not found: ${args.provider}`)
      print(args.provider, args.verbose)
      return
    }

    const ids = [...byId.keys()].sort((a, b) => {
      const aIsNovaclaw = a.startsWith("novaclaw")
      const bIsNovaclaw = b.startsWith("novaclaw")
      if (aIsNovaclaw && !bIsNovaclaw) return -1
      if (!aIsNovaclaw && bIsNovaclaw) return 1
      return a.localeCompare(b)
    })

    for (const providerID of ids) print(providerID, args.verbose)
  }),
})

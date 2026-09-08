import { EOL } from "os"
import { Effect } from "effect"
import { ModelsDev } from "@novaclaw/core/models-dev"
import { PluginV2 } from "@novaclaw/core/plugin"
import { LocationServiceMap, locationServiceMapLayer } from "@novaclaw/core/location-services"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { ProviderCatalogResult } from "@/provider/catalog-result"
import { Config } from "@/config/config"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { CommandSpec } from "../command-spec"
import { DatabasePath } from "@novaclaw/core/database/db-path"
import { InstallationChannel } from "@novaclaw/core/installation/version"

export const ModelsCommand = effectCmd({
  ...CommandSpec.models,
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
    // Which store this listing comes from — as a `#` line, so `models | grep spark-` and every
    // other pipe over this output is unchanged. A from-source run is channel `local` on
    // `novaclaw-local.db`; the packaged app is on `novaclaw.db`, with a different provider catalog,
    // and the model-not-found message tells the user to compare the two as if they were one.
    UI.println(`# store: ${DatabasePath.path()} (channel ${InstallationChannel})`)
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
      // The location graph starts PluginInternal in a scoped fork. Await its initial
      // batch before reading Catalog or a fast CLI process can observe an empty store.
      yield* (yield* PluginV2.Service).ready
      // : the four-call catalog read is `ProviderCatalogResult.listCatalog`, shared verbatim
      // with `httpapi/handlers/provider.ts`'s `list`. Only the DIRECTORY differs between the two —
      // `process.cwd()` here, `InstanceState.context.directory` there — so only the provision below
      // stays local. `run.ts` drives the in-process HTTP handler instead, which is the other valid
      // shape; this command predates it.
      return yield* ProviderCatalogResult.listCatalog
    }).pipe(
      Effect.provide(
        LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })),
      ),
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

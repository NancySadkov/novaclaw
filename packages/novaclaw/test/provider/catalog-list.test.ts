import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Catalog } from "@novaclaw/core/catalog"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { ProviderCatalogResult } from "@/provider/catalog-result"

/**
 * **`listCatalog` — the read `cli/cmd/models.ts` and `httpapi/handlers/provider.ts` now share**
 * (). The two used to spell the same four calls out separately, so "what the CLI thinks the
 * catalog is" and "what the HTTP route thinks it is" could drift with nothing reporting it.
 *
 * ⚠️ What this pins is the part a caller cannot see and would not notice going wrong: that
 * `connected` comes from `provider.available()` and NOT from `provider.all()`. Swap those and every
 * provider reports connected; the CLI prints the same list either way, and only a user wondering
 * why a key-less provider shows as reachable would ever find it.
 *
 * ⚠️ It also pins that each read happens exactly ONCE. `provider.all()` reaches the store, and a
 * refactor that called it again per provider would be invisible to any output-shape assertion.
 *
 * ⚠️ This is a unit against a stub because this machine's real catalog is EMPTY — `nova-cli debug
 * v2` answers `{"providers": []}` here, with no configured provider and no models.dev cache — so a
 * live before/after diff of `nova-cli models` compares two empty strings and proves nothing.
 */

const provider = (id: string, extra: Partial<ProviderV2.Info> = {}) =>
  ({ id: ProviderV2.ID.make(id), name: id, ...extra }) as unknown as ProviderV2.Info

const model = (providerID: string, id: string, extra: Partial<ModelV2.Info> = {}) =>
  ({
    id: ModelV2.ID.make(id),
    providerID: ProviderV2.ID.make(providerID),
    name: id,
    ...extra,
  }) as unknown as ModelV2.Info

function stubCatalog(input: {
  providers: readonly ProviderV2.Info[]
  models: readonly ModelV2.Info[]
  available: readonly ProviderV2.Info[]
}) {
  const calls = { all: 0, models: 0, available: 0 }
  const layer = Layer.succeed(Catalog.Service)({
    provider: {
      get: () => Effect.succeed(undefined),
      all: () => {
        calls.all += 1
        return Effect.succeed([...input.providers])
      },
      available: () => {
        calls.available += 1
        return Effect.succeed([...input.available])
      },
    },
    model: {
      get: () => Effect.succeed(undefined),
      all: () => {
        calls.models += 1
        return Effect.succeed([...input.models])
      },
      available: () => Effect.succeed([]),
      default: () => Effect.succeed(undefined),
      small: () => Effect.succeed(undefined),
    },
  } as unknown as Catalog.Interface)
  return { layer, calls }
}

describe("ProviderCatalogResult.listCatalog", () => {
  test("projects the three catalog reads, with `connected` taken from AVAILABLE", async () => {
    const anthropic = provider("anthropic")
    const openai = provider("openai")
    const stub = stubCatalog({
      providers: [anthropic, openai],
      models: [model("anthropic", "claude-sonnet-4"), model("openai", "gpt-5")],
      // openai has a key; anthropic does not. That distinction is the whole point of `available`.
      available: [openai],
    })

    const result = await Effect.runPromise(ProviderCatalogResult.listCatalog.pipe(Effect.provide(stub.layer)))

    expect(result.providers.map((entry) => String(entry.id)).toSorted()).toEqual(["anthropic", "openai"])
    // 🔴 The assertion the extraction exists to protect. `all()` returned BOTH providers; only the
    // one `available()` named may be reported connected.
    expect(result.connected.map(String)).toEqual(["openai"])
    expect(result.default).toEqual({ anthropic: "claude-sonnet-4", openai: "gpt-5" })
    expect(stub.calls).toEqual({ all: 1, models: 1, available: 1 })
  })

  test("a provider with no models is dropped, and so is its entry in `connected`", async () => {
    const stub = stubCatalog({
      providers: [provider("anthropic"), provider("empty")],
      models: [model("anthropic", "claude-sonnet-4")],
      available: [provider("anthropic"), provider("empty")],
    })

    const result = await Effect.runPromise(ProviderCatalogResult.listCatalog.pipe(Effect.provide(stub.layer)))

    expect(result.providers.map((entry) => String(entry.id))).toEqual(["anthropic"])
    expect(result.connected.map(String)).toEqual(["anthropic"])
  })

  test("an empty catalog is an empty answer, not a throw — this machine's real state", async () => {
    const stub = stubCatalog({ providers: [], models: [], available: [] })
    const result = await Effect.runPromise(ProviderCatalogResult.listCatalog.pipe(Effect.provide(stub.layer)))
    expect(result).toEqual({ providers: [], models: [], connected: [], default: {} })
    // …and the stub was really driven, so the case above is not passing on a dead layer.
    expect(stub.calls).toEqual({ all: 1, models: 1, available: 1 })
  })
})

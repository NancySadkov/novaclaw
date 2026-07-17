import { type Accessor, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { DateTime } from "luxon"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@novaclaw/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
// Rough capability class (by parameter count) the user assigns — or "guess" to let NovaClaw
// estimate it later by probing (see notes/guesstimation.md). Kept client-side like `variant`;
// wiring it into the system prompt is future work.
export type ModelTier = "guess" | "micro" | "tiny" | "small" | "medium" | "large" | "frontier"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
  tier?: Record<string, ModelTier>
  removed?: string[]
}

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  gate: false,
  init: (props: { directory?: Accessor<string | undefined> } = {}) => {
    const providers = useProviders(props.directory)

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
      }),
    )

    const availableAll = createMemo(() =>
      providers.connected().flatMap((p) =>
        providers.models(p.id).map((m) => ({
          ...m,
          provider: p,
        })),
      ),
    )
    // Client-side "removed" models — the Models-tab delete. Filtered out of everything downstream
    // (the tab AND the picker) reliably, without a config write: patchJsonc can't delete a key over
    // the wire (JSON drops `undefined`; `null` would poison the entry). A user-added model's
    // novaclaw.jsonc entry lingers but stays invisible; resetting UI prefs restores the catalog view.
    const removedSet = createMemo(() => new Set(store.removed ?? []))
    const available = createMemo(() =>
      availableAll().filter((m) => !removedSet().has(modelKey({ providerID: m.provider.id, modelID: m.id }))),
    )

    const release = createMemo(
      () =>
        new Map(
          available().map((model) => {
            const parsed = DateTime.fromMillis(model.time.released)
            return [modelKey({ providerID: model.provider.id, modelID: model.id }), parsed] as const
          }),
        ),
    )

    const latest = createMemo(() =>
      pipe(
        available(),
        filter(
          (x) =>
            Math.abs(
              (release().get(modelKey({ providerID: x.provider.id, modelID: x.id })) ?? DateTime.invalid("invalid"))
                .diffNow()
                .as("months"),
            ) < 6,
        ),
        groupBy((x) => x.provider.id),
        mapValues((models) =>
          pipe(
            models,
            groupBy((x) => x.family),
            values(),
            (groups) =>
              groups.flatMap((g) => {
                const first = firstBy(g, [(x) => x.time.released, "desc"])
                return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
              }),
          ),
        ),
        values(),
        flat(),
      ),
    )

    const latestSet = createMemo(() => new Set(latest().map((x) => modelKey(x))))

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
    }

    const visible = (model: ModelKey) => {
      const key = modelKey(model)
      const state = visibility().get(key)
      if (state === "hide") return false
      if (state === "show") return true
      if (latestSet().has(key)) return true
      const date = release().get(key)
      // No meaningful release date → show it. This covers a missing date AND the epoch
      // placeholder (`1970-01-01T00:00:00.000Z`, i.e. `toMillis() <= 0`) that the catalog emits
      // for a local endpoint that reports none — those are user-configured models, not a sprawling
      // dated cloud catalog, so they belong in the picker by default. Only genuinely dated,
      // >6-month-old models stay hidden-by-default (the declutter heuristic for large catalogs).
      if (!date?.isValid || date.toMillis() <= 0) return true
      return false
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    // Models the user explicitly marked visible ("show") in the Models tab AND that are still
    // available (connected, not removed) — a deliberate "use this" signal. The default-model
    // fallback prefers these so a curated setup never resolves to a hidden/removed/stale entry.
    const shown = createMemo(() =>
      available()
        .filter((m) => visibility().get(modelKey({ providerID: m.provider.id, modelID: m.id })) === "show")
        .map((m) => ({ providerID: m.provider.id, modelID: m.id }) satisfies ModelKey),
    )

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    const tierKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getTier = (model: ModelKey): ModelTier => store.tier?.[tierKey(model)] ?? "guess"
    const setTier = (model: ModelKey, value: ModelTier) => {
      const key = tierKey(model)
      if (!store.tier) {
        setStore("tier", { [key]: value })
        return
      }
      setStore("tier", key, value)
    }

    const remove = (model: ModelKey) => {
      const key = modelKey(model)
      if ((store.removed ?? []).includes(key)) return
      setStore("removed", [...(store.removed ?? []), key])
    }

    const [recentModels] = createResource(
      async () => {
        const recent = store.recent
        await ready.promise
        return recent
      },
      (p) => p,
      { initialValue: [] },
    )
    return {
      ready,
      list,
      find,
      visible,
      shown,
      setVisibility,
      recent: {
        list: () => recentModels()!,
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
      tier: {
        get: getTier,
        set: setTier,
      },
      remove,
    }
  },
})

import { type Accessor, createEffect, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { DateTime } from "luxon"
import * as Timestamp from "@novaclaw/schema/time"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@novaclaw/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { useServerSync } from "@/context/server-sync"
import type { Tier } from "@/apps/agent-model"
import { pruneCovers } from "./models-covers"
import { modelStoreTarget } from "./models-store"
import { persisted } from "@/utils/persist"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
// Rough capability class (by parameter count) the user assigns — or "guess" to let NovaClaw
// estimate it later by probing (see notes/guesstimation.md). Kept client-side like `variant`;
// wiring it into the system prompt is future work.
// The ladder itself is `AgentModelFit.LADDER` (re-exported as `TIERS`), never re-spelled: a fifth
// hand-kept copy of the same order is a tier the schema knows and this screen cannot show.
export type ModelTier = "guess" | Tier
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

export const {
  use: useModels,
  provider: ModelsProvider,
  context: ModelsContext,
} = createSimpleContext({
  name: "Models",
  gate: false,
  init: (props: { directory?: Accessor<string | undefined> } = {}) => {
    const providers = useProviders(props.directory)
    const serverSync = useServerSync()

    /**
     * 🔴 **PER INSTANCE, because everything in it is an answer ABOUT one instance's catalog.**
     *
     * This was `Persist.global`, one store shared by every configured instance, while every rule
     * that reads or writes it is scoped to the selected one: `removed` is pruned against
     * `availableAll()`, which is *this* instance's catalog. Delete a model on instance A, switch to
     * instance B — which does not serve it — and B's catalog loads, the prune below sees the key
     * unlisted, and the cover is dropped. Switch back to A and the deleted model is in the Models
     * tab and in every agent's Tune dialog again. A destructive write, performed on one instance's
     * data by a different instance, with nothing on any screen saying it happened.
     *
     * `user` (visibility), `recent`, `variant` and `tier` are the same kind of claim — a model id
     * only means anything next to the instance that serves it — so the whole store moves, not just
     * `removed`.
     *
     * ⚠️ The scope comes from the same context the catalog does, deliberately: `useProviders` reads
     * `useServerSync()` too, so there is no second source of "which instance is this" for the two to
     * disagree about. `modelStoreTarget` carries the rest, including why the local instance's stored
     * data survives the change untouched.
     */
    const [store, setStore, _, ready] = persisted(
      modelStoreTarget(serverSync().scope),
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

    /**
     * 🔴 **A REMOVED KEY IS A COVER, NOT A TOMBSTONE — drop it once the server agrees.**
     *
     * `remove()` only ever APPENDED, and nothing on any path ever cleared a key, so deleting a model
     * wrote a permanent tombstone. Re-adding that exact model then did nothing visible:
     * the server had it, `availableAll()` carried it, and this filter hid it forever — in the Models
     * tab AND in the agent's Tune dialog, because both read `available()`. The only escape was
     * resetting UI preferences, which the comment above offers as a feature and is really the
     * symptom. Reported by the owner 2026-08-24: delete a model, add it back, it never returns.
     *
     * The cover's own justification had already expired. It was written when the delete was
     * client-only (*"patchJsonc can't delete a key over the wire"*); `settings-v2/models.tsx` now
     * calls `provider.removeModel` and hides locally only until that lands — its comment says so.
     *
     * So the rule is: a key stays only while the SERVER still lists the model. Once the catalog drops
     * it the delete is confirmed and the cover has done its job; if that model is ever added back it
     * arrives with no tombstone waiting for it.
     *
     * ⚠️ Guarded on a non-empty catalog. At boot `availableAll()` is empty until providers load, and
     * pruning against nothing would clear every cover on every start — harmless today (a confirmed
     * delete is gone server-side anyway) but it would make this effect a liar about what it does.
     */
    createEffect(() => {
      const listed = availableAll().map((m) => modelKey({ providerID: m.provider.id, modelID: m.id }))
      const kept = pruneCovers({ removed: store.removed ?? [], listed })
      if (kept !== undefined) setStore("removed", kept)
    })

    const release = createMemo(
      () =>
        new Map(
          available().map((model) => {
            const released = Timestamp.toEpochMillis(model.time.released)
            const parsed = released === undefined ? DateTime.invalid("invalid") : DateTime.fromMillis(released)
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

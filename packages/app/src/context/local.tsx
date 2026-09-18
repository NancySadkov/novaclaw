import { createSimpleContext } from "@novaclaw/ui/context"
import { base64Encode } from "@novaclaw/core/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, createSignal, startTransition } from "solid-js"
import { createStore } from "solid-js/store"
import { useModels } from "@/context/models"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./model-variant"
import { useSDK } from "./sdk"
import { useSettings } from "./settings"
import { useSync } from "./sync"
import { useServerSDK } from "./server-sdk"
import { useLanguage } from "./language"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { showToast } from "@/utils/toast"

export type ModelKey = { providerID: string; modelID: string; variant?: string }

/** 1K: the session's permission-mode ceiling, chosen at create time in the composer. */
export type PermissionMode = "plan" | "ask" | "surgical" | "bypass" | "yolo"

/** The composer's per-chat Strict-harness choice (jh.md): on/off + racing width + time budget. */
export type StrictChoice = { enabled: boolean; attempts?: number; wallMinutes?: number }

/** The composer's per-chat harness-feature stances (the Tuning control); absent key = inherit. */
export type FeatureChoices = {
  introspection?: boolean
  quality?: boolean
  affective?: boolean
  thinkingBudget?: boolean
  surgicalEdits?: boolean
  askBeforeChanges?: boolean
  safeMode?: boolean
  contextBudget?: boolean
  memory?: boolean
  shortChat?: boolean
}

/** The composer's Mode choice (kernel thread type): attended, or the unattended pair. */
export type SessionModeChoice = "interactive" | "auto-prompting" | "goal-oriented"

type State = {
  agent?: string
  /**
   * A model pick for a session that does not exist YET — the in-memory draft state that becomes the
   * new session's override at create. For an EXISTING session this is deliberately unused: the
   * kernel row is the one source of truth (see `kernelModel`/`pickedModel`).
   *
   * ⚠️ It used to be persisted per session alongside the kernel row, which made the same question —
   * "what model does this chat run?" — have two answers. The client copy was invisible to the kernel
   * and to other clients, and because a session row is an override it silently won, so re-pointing
   * an officer changed nothing the user could see (owner, 2026-09-16). One answer, owned by the
   * entity: the session.
   */
  model?: ModelKey
  variant?: string | null
  permissionMode?: PermissionMode
  strict?: StrictChoice
  features?: FeatureChoices
  mode?: SessionModeChoice
}

type Saved = {
  session: Record<string, State | undefined>
}

const WORKSPACE_KEY = "__workspace__"
const handoff = new Map<string, State>()

const handoffKey = (scope: ServerScope, dir: string, id: string) => ScopedKey.from(scope, dir, id)

const migrate = (value: unknown) => {
  if (!value || typeof value !== "object") return { session: {} }

  const item = value as {
    session?: Record<string, State | undefined>
    pick?: Record<string, State | undefined>
  }

  if (item.session && typeof item.session === "object") return { session: item.session }
  if (!item.pick || typeof item.pick !== "object") return { session: {} }

  return {
    session: Object.fromEntries(Object.entries(item.pick).filter(([key]) => key !== WORKSPACE_KEY)),
  }
}

const clone = (value: State | undefined) => {
  if (!value) return
  return {
    ...value,
    model: value.model ? { ...value.model } : undefined,
  } satisfies State
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const params = useParams()
    const language = useLanguage()
    const sdk = useSDK()
    const sync = useSync()
    const serverSDK = useServerSDK()
    const providers = useProviders(() => sdk().directory)
    const models = useModels()
    const settings = useSettings()

    const id = createMemo(() => params.id || undefined)
    const list = createMemo(() => sync().data.agent.filter((item) => item.mode !== "subagent" && !item.hidden))
    const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

    const [saved, setSaved] = persisted(
      {
        ...Persist.serverWorkspace(serverSDK().scope, sdk().directory, "model-selection", ["model-selection.v1"]),
        migrate,
      },
      createStore<Saved>({
        session: {},
      }),
    )

    const [store, setStore] = createStore<{
      current?: string
      draft?: State
      last?: {
        type: "agent" | "model" | "variant"
        agent?: string
        model?: ModelKey | null
        variant?: string | null
      }
    }>({
      current: list()[0]?.name,
      draft: undefined,
      last: undefined,
    })

    /**
     * 🔴 A SWITCHED-OFF MODEL IS NOT A RESOLUTION (owner, 2026-09-16: *"disabling a model still
     * doesn't shortcircuit all its uses"*).
     *
     * This checked only "listed + provider connected", so a model the installation had switched off
     * stayed the composer's answer for the configured instance default, for recents, and for a pinned
     * session row. The kernel would then substitute a different model on the next turn, which is how
     * the UI came to name a model that was never going to answer. Enablement is
     * `models.enabled` — the same predicate `catalog.model.available()` resolves through — so a
     * disabled candidate falls through to the next link in the chain, exactly as the runner does.
     */
    const validModel = (model: ModelKey) => {
      return (
        !!providers.model(model.providerID, model.modelID) &&
        connected().has(model.providerID) &&
        models.enabled(model)
      )
    }

    const firstModel = (...items: Array<() => ModelKey | undefined>) => {
      for (const item of items) {
        const model = item()
        if (!model) continue
        if (validModel(model)) return model
      }
    }

    /**
     * ⚠️ **A NAMED colleague resolves to that colleague or to nothing — never to a substitute.**
     *
     * This used to end `?? items[0]`, and `items[0]` is `build`: the first row of the legacy roster
     * projection. So asking for a colleague the list did not have — because the roster had not
     * loaded yet, or because the row was missing — answered with a DIFFERENT one, confidently. The
     * composer then wrote that answer onto the session (`prompt-input/submit.ts`), which is how
     * chats belonging to Umbris ended up running as `build`.
     *
     * The fallback survives only for the case it was actually for: nobody asked for anyone, so the
     * default primary agent is the honest answer. `current()` returning `undefined` while the roster
     * loads is correct and already handled — submit says so and declines rather than sending the
     * prompt to whoever happened to sort first.
     */
    const pickAgent = (name: string | undefined) => {
      const items = list()
      if (items.length === 0) return
      if (name !== undefined) return items.find((item) => item.name === name)
      return items[0]
    }

    createEffect(() => {
      const items = list()
      if (items.length === 0) {
        if (store.current !== undefined) setStore("current", undefined)
        return
      }
      if (items.some((item) => item.name === store.current)) return
      setStore("current", items[0]?.name)
    })

    const scope = createMemo<State | undefined>(() => {
      const session = id()
      if (!session) return store.draft
      return saved.session[session] ?? handoff.get(handoffKey(serverSDK().scope, sdk().directory, session))
    })

    createEffect(() => {
      const session = id()
      if (!session) return

      const key = handoffKey(serverSDK().scope, sdk().directory, session)
      const next = handoff.get(key)
      if (!next) return
      if (saved.session[session] !== undefined) {
        handoff.delete(key)
        return
      }

      setSaved("session", session, clone(next))
      handoff.delete(key)
    })

    const configuredModel = () => {
      const configured = sync().data.config.model
      if (!configured) return
      const [providerID, modelID] = configured.split("/")
      const model = { providerID, modelID }
      if (validModel(model)) return model
    }

    const recentModel = () => {
      for (const item of models.recent.list()) {
        if (validModel(item)) return item
      }
    }

    // A fallback candidate must be usable AND not curated out: the user's model-tab visibility ("hide")
    // and delete ("removed") settings gate what the picker may auto-select. Without this, the default
    // resolves to the first raw model of the first connected provider — which can be a stale/dead entry
    // the user hid (e.g. a provider pointed at an endpoint that no longer serves that model), sending
    // every new chat's first turn to a 404.
    const usableFallback = (model: ModelKey) => validModel(model) && !!models.find(model) && models.visible(model)

    const defaultModel = () => {
      // Prefer a model the user explicitly marked visible ("show") — a deliberate "this is my model"
      // signal — so a curated single-model setup resolves to it immediately (before recents hydrate).
      for (const model of models.shown()) if (validModel(model)) return model

      const defaults = providers.default()
      for (const provider of providers.connected()) {
        const configured = defaults[provider.id]
        if (configured) {
          const model = { providerID: provider.id, modelID: configured }
          if (usableFallback(model)) return model
        }

        for (const entry of providers.models(provider.id)) {
          const model = { providerID: provider.id, modelID: entry.id }
          if (usableFallback(model)) return model
        }
      }
    }

    const fallback = createMemo<ModelKey | undefined>(() => configuredModel() ?? recentModel() ?? defaultModel())

    // The composer's visible agent picker is retired — `current()` (the default primary agent)
    // is all the app still needs.
    const agent = {
      list,
      current() {
        return pickAgent(scope()?.agent ?? store.current)
      },
    }

    /**
     * An in-flight model switch, per session, so the composer reflects the pick immediately and a
     * prompt sent in the same tick carries it. NOT persisted: it is staging for a kernel write, not a
     * second copy of the truth. `null` means "clearing back to the officer".
     */
    const [pendingModel, setPendingModel] = createSignal<Record<string, ModelKey | null | undefined>>({})
    const clearPending = (session: string) =>
      setPendingModel((current) => {
        if (!(session in current)) return current
        const next = { ...current }
        delete next[session]
        return next
      })
    createEffect(() => {
      const session = id()
      if (!session) return
      const pending = pendingModel()[session]
      if (!(session in pendingModel())) return
      const kernel = kernelModel()
      const settled =
        (pending ?? undefined)?.providerID === kernel?.providerID &&
        (pending ?? undefined)?.modelID === kernel?.modelID &&
        (pending ?? undefined)?.variant === kernel?.variant
      if (settled) clearPending(session)
    })

    /**
     * The kernel's model override for this session, as a `ModelKey`, or `undefined` when the chat
     * inherits its officer. **The session row is the ONE source of truth** — the kernel owns the
     * component (`session.switchModel`, `session.next.model.switched`), so a second client store would
     * give the same question two answers, and the invisible one silently outranks the officer.
     */
    const kernelModel = (): ModelKey | undefined => {
      const session = id()
      if (!session) return undefined
      const bound = sync().session.get(session)?.model
      if (!bound) return undefined
      return {
        providerID: bound.providerID,
        modelID: bound.id,
        ...(bound.variant ? { variant: bound.variant } : {}),
      }
    }

    /**
     * This chat's model override: an in-flight pick first, then the kernel row. For a session that
     * does not exist yet, the in-memory draft pick (it is promoted to the kernel at create).
     */
    const pickedModel = (): ModelKey | undefined => {
      const session = id()
      if (!session) return scope()?.model
      const map = pendingModel()
      if (session in map) return map[session] ?? undefined
      return kernelModel()
    }

    const current = () => {
      const item = firstModel(
        () => pickedModel(),
        () => agent.current()?.model,
        fallback,
      )
      if (!item) return
      return models.find(item)
    }

    const override = () => pickedModel()

    /** The officer's own model, resolved, for the "this chat overrides it" affordance. */
    const officerModel = () => {
      const bound = agent.current()?.model
      if (!bound) return undefined
      return models.find({ providerID: bound.providerID, modelID: bound.modelID })
    }
    /**
     * True when this chat carries an override that differs from what its officer would run — the
     * fact the user could not see. `resolveSessionConfig` will run the override, so the UI must SAY
     * so and offer the one-click way back (principle 12: say what is in force).
     */
    const overridden = () => {
      const pick = override()
      if (!pick) return false
      const officer = officerModel()
      if (!officer) return true
      return pick.providerID !== officer.provider.id || pick.modelID !== officer.id
    }
    /** Return the chat to its officer's model (clears the session override). */
    const followOfficer = () => model.set(undefined)

    const configured = () => {
      const item = agent.current()
      const model = current()
      if (!item || !model) return
      return getConfiguredAgentVariant({
        agent: { model: item.model, variant: item.variant },
        model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
      })
    }

    /**
     * The explicit variant for THIS chat. For an existing session it is the kernel override's variant
     * (the model component carries it — `Model.Ref { providerID, id, variant }`); the stale persisted
     * shadow is deliberately ignored. A pre-session draft keeps its variant in the draft state.
     */
    const selected = () => {
      if (!id()) return scope()?.variant
      return pickedModel()?.variant
    }

    const snapshot = () => {
      const model = current()
      return {
        agent: agent.current()?.name,
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        variant: selected(),
        permissionMode: scope()?.permissionMode,
        strict: scope()?.strict,
        features: scope()?.features,
        mode: scope()?.mode,
      } satisfies State
    }

    const write = (next: Partial<State>) => {
      const state = {
        ...(scope() ?? { agent: agent.current()?.name }),
        ...next,
      } satisfies State

      const session = id()
      if (session) {
        setSaved("session", session, state)
        return
      }
      setStore("draft", state)
    }

    const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

    const model = {
      ready: models.ready,
      current,
      override,
      /** The officer's own model, for the override affordance. */
      officer: officerModel,
      /** True when this chat overrides what its officer would run. */
      overridden,
      recent,
      list: models.list,
      cycle(direction: 1 | -1) {
        const items = recent()
        const item = current()
        if (!item) return

        const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0

        const entry = items[next]
        if (!entry) return
        model.set({ providerID: entry.provider.id, modelID: entry.id })
      },
      set(item: ModelKey | undefined, options?: { recent?: boolean }) {
        const session = id()
        startTransition(() =>
          batch(() => {
            setStore("last", {
              type: "model",
              agent: agent.current()?.name,
              model: item ?? null,
              variant: selected(),
            })
            const fail = (error: unknown) =>
              showToast({
                variant: "error",
                title: language.t("dialog.model.switchFailed"),
                description: error instanceof Error ? error.message : String(error),
              })
            if (!item) {
              // Clearing the override. A session is a KERNEL write; a pre-session draft is just state.
              if (session === undefined) {
                write({ model: undefined, variant: undefined })
                return
              }
              setPendingModel((m) => ({ ...m, [session]: null }))
              void sdk().client.v2.session
                .switchModel({ sessionID: session, model: null })
                .catch((error: unknown) => {
                  clearPending(session)
                  fail(error)
                })
              return
            }
            models.setVisibility(item, true)
            if (options?.recent) models.recent.push(item)
            if (session === undefined) {
              // No session yet: the pick is promoted from this draft after `create`.
              write({ model: item, variant: item.variant })
              return
            }
            // The session OWNS the override: stage it for the immediate UI, then write the kernel.
            setPendingModel((m) => ({ ...m, [session]: item }))
            void sdk().client.v2.session
              .switchModel({
                sessionID: session,
                model: {
                  providerID: item.providerID,
                  id: item.modelID,
                  ...(item.variant ? { variant: item.variant } : {}),
                },
              })
              .catch((error: unknown) => {
                clearPending(session)
                fail(error)
              })
          }),
        )
      },
      visible(item: ModelKey) {
        return models.visible(item)
      },
      setVisibility(item: ModelKey, visible: boolean) {
        models.setVisibility(item, visible)
      },
      variant: {
        configured,
        selected,
        current() {
          const resolved = resolveModelVariant({
            variants: this.list(),
            selected: this.selected(),
            configured: this.configured(),
          })
          if (resolved) return resolved
          const model = current()
          if (!model) return
          const saved = models.variant.get({ providerID: model.provider.id, modelID: model.id })
          if (saved && this.list().includes(saved)) return saved
        },
        list() {
          const item = current()
          if (!item?.variants) return []
          return item.variants.map((v) => v.id)
        },
        set(value: string | undefined) {
          const session = id()
          startTransition(() =>
            batch(() => {
              const item = current()
              setStore("last", {
                type: "variant",
                agent: agent.current()?.name,
                model: item ? { providerID: item.provider.id, modelID: item.id } : null,
                variant: value ?? null,
              })
              if (item) {
                models.variant.set({ providerID: item.provider.id, modelID: item.id }, value ?? undefined)
              }
              if (session === undefined) {
                write({ variant: value ?? null })
                return
              }
              if (!item) return
              // An explicit variant is part of the model override, so it rides the SAME kernel write.
              const next: ModelKey = {
                providerID: item.provider.id,
                modelID: item.id,
                ...(value ? { variant: value } : {}),
              }
              setPendingModel((m) => ({ ...m, [session]: next }))
              void sdk().client.v2.session
                .switchModel({
                  sessionID: session,
                  model: { providerID: item.provider.id, id: item.id, ...(value ? { variant: value } : {}) },
                })
                .catch((error: unknown) => {
                  clearPending(session)
                  showToast({
                    variant: "error",
                    title: language.t("dialog.model.switchFailed"),
                    description: error instanceof Error ? error.message : String(error),
                  })
                })
            }),
          )
        },
        cycle() {
          const items = this.list()
          if (items.length === 0) return
          this.set(
            cycleModelVariant({
              variants: items,
              selected: this.selected(),
              configured: this.configured(),
            }),
          )
        },
      },
    }

    const permissionMode = {
      // 1K: an unset draft starts on the user's configured default mode (the
      // "yolo setting" — Settings → General), not a hardcoded "ask".
      current: (): PermissionMode => scope()?.permissionMode ?? settings.general.defaultPermissionMode(),
      set(value: PermissionMode) {
        // Persist the explicit choice (no default-normalization: a chosen mode
        // must stay sticky even if the default setting changes later).
        write({ permissionMode: value })
      },
    }

    // The composer's Strict switch (jh.md). `undefined` = no explicit choice yet (the global
    // Settings → Strict mode default applies); a live session ALSO persists the choice server-side
    // (the switchStrict route) — this local state carries the new-session draft to create time.
    const strict = {
      current: (): StrictChoice | undefined => scope()?.strict,
      set(value: StrictChoice | undefined) {
        write({ strict: value })
      },
    }

    // The composer's Tuning toggles (introspection · quality · affective · thinkingBudget). Same contract as
    // `strict`: this local state is the new-session draft; a live session ALSO persists each
    // stance server-side (the switchFeature route).
    const features = {
      current: (): FeatureChoices | undefined => scope()?.features,
      set(value: FeatureChoices | undefined) {
        write({ features: value })
      },
    }

    // The composer's Mode control (kernel thread type — interactive vs the unattended pair).
    // Same contract as `strict`: the local state is the new-session draft; a live session ALSO
    // persists the switch server-side (the switchType route).
    const mode = {
      current: (): SessionModeChoice | undefined => scope()?.mode,
      set(value: SessionModeChoice | undefined) {
        write({ mode: value })
      },
    }

    const result = {
      slug: createMemo(() => base64Encode(sdk().directory)),
      model,
      agent,
      permissionMode,
      strict,
      features,
      mode,
      session: {
        reset() {
          setStore("draft", undefined)
        },
        promote(dir: string, session: string) {
          const next = clone(snapshot())
          if (!next) return

          if (dir === sdk().directory) {
            setSaved("session", session, next)
            setStore("draft", undefined)
            return
          }

          handoff.set(handoffKey(serverSDK().scope, dir, session), next)
          setStore("draft", undefined)
        },
        restore(msg: { sessionID: string; agent: string; model: ModelKey }) {
          const session = id()
          if (!session) return
          if (msg.sessionID !== session) return
          if (saved.session[session] !== undefined) return
          if (handoff.has(handoffKey(serverSDK().scope, sdk().directory, session))) return

          setSaved("session", session, {
            agent: msg.agent,
            model: msg.model,
            variant: msg.model?.variant ?? null,
          })
        },
      },
    }
    return result
  },
})

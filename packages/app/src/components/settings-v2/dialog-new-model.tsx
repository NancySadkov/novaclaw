import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { Icon } from "@novaclaw/ui/icon"
import { ProviderIcon } from "@novaclaw/ui/provider-icon"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import {
  localModelInstall,
  localModelStatus,
  providerPresets,
  providerProbe,
  type LocalModelStatus,
  type ProbeResult,
  type ProviderPreset,
} from "@/utils/fs-api"
import { matchPreset } from "@/utils/model-presets"
import { ConfigLocalRuntime } from "@novaclaw/core/config/local-runtime"
import { ModelV2 } from "@novaclaw/core/model"
import type { ServerConnection } from "@/context/server"

// "Add models" — the provider-import flow. Three steps in one dialog:
//   0. (S0) offer any model server ALREADY running on the instance's machine — see below
//   1. pick a provider (the preset catalog served by GET /provider/presets — builtins merged
//      with `provider_presets` config overrides, so runtime endpoint repairs show immediately)
//   2. connect (API key + get-a-key link; URL prefilled from the preset or the saved provider)
//   3. choose models (server-side probe discovers the served list; user multi-selects)
// Import writes ONE updateConfig payload. The API key goes INLINE into the provider layer
// (request.body.apiKey) — the ONLY place V2 model resolution reads a config key from
// (session/runner/model.ts apiKey()); the legacy auth.json store is never consulted by the
// runtime, so writing there stranded imported providers at 401 (the P0 key-gap fix).
// Every preset rides an in-tree API channel — no vendor SDKs, ever.
const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/
const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

/** Internal config keys are generated from the endpoint and never presented as user-authored identity. */
export const providerIDFromEndpoint = (input: string): string => {
  let source = input.trim().toLowerCase()
  try {
    const url = new URL(source)
    source = `${url.hostname}${url.port ? `-${url.port}` : ""}${url.pathname}`
  } catch {
    // An incomplete URL is still useful while the user types; validation remains the probe's job.
  }
  return (
    source
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "endpoint"
  )
}

type SavedProvider = {
  name?: string
  api?: { url?: string; package?: string }
  request?: { body?: Record<string, unknown> }
  models?: Record<string, unknown>
}

export const DialogNewModel: Component<{
  http: ServerConnection.HttpBase
  directory: string
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSync = useServerSync()
  // ⚠️ This used to be a local `(key: string, vars) => language.t(key as ..., vars as never)`
  // wrapper — a per-file escape hatch that turned off key checking for the whole dialog, including
  // the two template-literal keys in `Field` below. `language.t` is used directly now: `p.field` is
  // a four-member union, so `` `settings.models.new.field.${p.field}.label` `` still resolves to a
  // literal union and all eight keys are checked.
  const t = language.t

  const [presets, setPresets] = createSignal<Record<string, ProviderPreset>>({})
  const [localSweep, setLocalSweep] = createSignal<ConfigLocalRuntime.SweepResult>()

  const [step, setStep] = createSignal<"pick" | "local" | "connect" | "choose">("pick")
  // undefined = nothing chosen yet; "custom" = the free-form endpoint card.
  const [presetID, setPresetID] = createSignal<string>()
  const [form, setForm] = createStore({ baseURL: "", providerID: "", apiKey: "" })
  const [probing, setProbing] = createSignal(false)
  const [result, setResult] = createSignal<ProbeResult>()
  const [picked, setPicked] = createStore<Record<string, boolean>>({})
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [managed, setManaged] = createSignal<LocalModelStatus>()
  const [managedContext, setManagedContext] = createSignal<number>()

  const config = () =>
    serverSync().data.config as {
      disabled_providers?: string[]
      providers?: Record<string, SavedProvider>
    }
  const preset = (): ProviderPreset | undefined => {
    const id = presetID()
    return id === undefined || id === "custom" ? undefined : presets()[id]
  }
  // ── S0 — "you may not need the sidecar": the local-runtime probe ────────────────────────────
  //
  // A fresh install has no providers BY DESIGN (AGENTS.md → Config) and this dialog is where that
  // state is resolved — a model-less instance is routed straight here (dialog-select-model.tsx).
  // What it asked of a normal person, though, was to know what a base URL is. If Ollama or LM Studio
  // is already running, the honest answer is to find it and offer it, which is the whole of slice S0.
  //
  // ⚠️ WHEN, and why not at boot. Four TCP connects on every launch is a startup cost paid by every
  // machine that has none of them, and startup speed is first-class here. Opening THIS dialog is the
  // moment the user has asked the question, and it still covers first run for free because the
  // no-models path lands here anyway. Nothing probes until this dialog is opened.
  //
  // ⚠️ The probe runs SERVER-SIDE, through the shipped `POST /provider/:id/probe`. That is not an
  // implementation convenience: the UI and the runtime need never share a machine (AGENTS.md → P2P
  // instances), so a browser-side fetch to `localhost:11434` would probe the user's laptop instead of
  // the instance that will actually serve the turn. It also means no new route — the sweep is four
  // calls to an endpoint that already exists.
  //
  // ⚠️ Airgap: NOT suppressed, deliberately. `offline.ts`'s checkUrl allows loopback unconditionally
  // ("the app talking to itself is not egress"), and an airgapped user is exactly the one whose only
  // possible model is a local one. Loopback-only is enforced in the core module, before any socket.
  const configuredURLs = () =>
    Object.values(config().providers ?? {}).flatMap((entry) =>
      typeof entry.api?.url === "string" ? [entry.api.url] : [],
    )
  /**
   * A provider id that is NOT a saved provider — used both to probe under and to adopt as.
   *
   * 🔴 Probing under a taken id LEAKS A CREDENTIAL. `POST /provider/:providerID/probe` falls back to
   * the saved provider's `request.body.apiKey` whenever the payload carries no key of its own, so a
   * bare `providerID: "ollama"` on an instance that already has a provider called `ollama` (pointed
   * at a paid API, holding that API's key) would send that key as a Bearer token to whatever program
   * happens to be listening on loopback :11434. Resolving to a free id first means the handler finds
   * no entry, and the probe goes out with no `Authorization` header at all.
   */
  const freeProviderID = (base: string) =>
    ConfigLocalRuntime.uniqueProviderID(base, Object.keys(config().providers ?? {}))
  const providerIDAtURL = (baseURL: string) => {
    const target = baseURL.trim().replace(/\/+$/, "")
    if (!target) return undefined
    return Object.entries(config().providers ?? {}).find(
      ([, provider]) => provider.api?.url?.trim().replace(/\/+$/, "") === target,
    )?.[0]
  }
  onMount(() => {
    // A Resource created while dialog.push() commits inside a Solid transition can suspend the
    // dialog itself. Mount the usable Custom endpoint card first; discovery fills in afterward.
    const abort = new AbortController()
    void providerPresets(props.http, { directory: props.directory, signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setPresets(value)
      })
      .catch(() => undefined)
    void localModelStatus(props.http, { directory: props.directory, signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) {
          setManaged(value)
          setManagedContext(value.context ?? value.recommendedContext)
        }
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      })
    void ConfigLocalRuntime.sweep({
      probe: (localCandidate) =>
        providerProbe(props.http, {
          directory: props.directory,
          providerID: freeProviderID(localCandidate.id),
          baseURL: localCandidate.baseURL,
          signal: abort.signal,
        }),
    }).then((value) => {
      if (!abort.signal.aborted) setLocalSweep(value)
    })
    onCleanup(() => abort.abort())
  })
  /** Adoptable runtimes minus the ones this instance already points at. */
  const localFound = (): readonly ConfigLocalRuntime.Outcome[] => {
    const result = localSweep()
    return result === undefined ? [] : ConfigLocalRuntime.excludeConfigured(result.adoptable, configuredURLs())
  }
  /** ⚠️ Ruling 2: "we could not look" is a different fact from "nothing is there". Only this is it. */
  const localUnavailable = () => {
    const result = localSweep()
    return result !== undefined && !result.ran
  }

  const effectiveProviderID = () =>
    presetID() === "custom"
      ? form.providerID.trim() || providerIDAtURL(form.baseURL) || freeProviderID(providerIDFromEndpoint(form.baseURL))
      : form.providerID.trim()
  const saved = (): SavedProvider | undefined => config().providers?.[effectiveProviderID()]
  const savedKey = () => typeof saved()?.request?.body?.apiKey === "string" && !!saved()?.request?.body?.apiKey
  const models = () => result()?.models ?? []
  const validID = () => PROVIDER_ID.test(effectiveProviderID())
  const canDiscover = () => !!form.baseURL.trim() && validID() && !probing()
  const pickedIDs = () => models().filter((id) => picked[id])
  const visiblePresets = () => Object.entries(presets()).filter(([, entry]) => entry.hidden !== true)
  const discoveredLimits = (id: string) => result()?.limits?.[id]
  const tokenLabel = (tokens: number) =>
    tokens >= 1024 && tokens % 1024 === 0 ? `${tokens / 1024}K` : tokens.toLocaleString()
  const limitDescription = (id: string) => {
    const limits = discoveredLimits(id)
    if (limits?.context !== undefined && limits.output !== undefined)
      return t("settings.models.new.limits.reported", {
        context: tokenLabel(limits.context),
        output: tokenLabel(limits.output),
      })
    if (limits?.context !== undefined)
      return t("settings.models.new.limits.contextOnly", {
        context: tokenLabel(limits.context),
        output: tokenLabel(ModelV2.DEFAULT_LIMIT.output),
      })
    if (limits?.output !== undefined)
      return t("settings.models.new.limits.outputOnly", {
        context: tokenLabel(ModelV2.DEFAULT_LIMIT.context),
        output: tokenLabel(limits.output),
      })
    return t("settings.models.new.limits.unknown", {
      context: tokenLabel(ModelV2.DEFAULT_LIMIT.context),
      output: tokenLabel(ModelV2.DEFAULT_LIMIT.output),
    })
  }

  const statusMessage = (r: ProbeResult): string => {
    switch (r.status) {
      case "unreachable":
        return t("settings.models.probe.unreachable")
      case "auth":
        return t("settings.models.probe.auth")
      case "no-url":
        return t("settings.models.probe.noUrl")
      case "model-missing":
        return t("settings.models.probe.missing")
      case "error":
        return `${t("settings.models.probe.error")}${r.detail ? ` (${r.detail})` : ""}`
      default:
        return ""
    }
  }

  const choose = (id: string, entry: ProviderPreset) => {
    setPresetID(id)
    const existing = config().providers?.[id]
    // A saved provider's URL wins over the preset default — it may carry a self-healing repair
    // (an agent PATCHed providers.<id>.api.url after a vendor moved).
    setForm({
      baseURL: existing?.api?.url ?? entry.baseURL ?? "",
      providerID: id,
      apiKey: "",
    })
    setResult(undefined)
    setError(undefined)
    setStep("connect")
  }

  const chooseCustom = () => {
    setPresetID("custom")
    setForm({ baseURL: "", providerID: "", apiKey: "" })
    setResult(undefined)
    setError(undefined)
    setStep("connect")
  }

  // Adopt a runtime the sweep found. `presetID` is set to "custom" because that is what this IS —
  // a user-owned OpenAI-compatible endpoint — so no branded preset can leak an api channel or a
  // keyURL into a local server. Its internal config id remains generated and hidden from the user.
  const adoptLocal = (outcome: ConfigLocalRuntime.Outcome) => {
    const found = outcome.candidate
    setPresetID("custom")
    setForm({
      baseURL: found.baseURL,
      // Never silently repoint an existing id: if `ollama` is taken by a provider aimed elsewhere,
      // overwriting its endpoint would break a working setup in order to install a new one. Same
      // resolution the probe used, so the id on screen is the id that was tested.
      providerID: freeProviderID(found.id),
      apiKey: "",
    })
    setError(undefined)
    if (outcome.kind === "found") {
      // The sweep already carries the model list — probing the same endpoint twice to learn the
      // same answer would be a second wait for nothing.
      setResult({
        status: "ok",
        models: outcome.models,
        ...(outcome.limits === undefined ? {} : { limits: outcome.limits }),
      })
      for (const id of outcome.models) setPicked(id, true)
      setStep("choose")
      return
    }
    // needs-key: something is listening and wants credentials. The URL is filled in; the key is not
    // something we can guess, so this is the one local case that still needs the connect step.
    setResult(undefined)
    setStep("connect")
  }

  const discover = async () => {
    if (!canDiscover()) return
    setProbing(true)
    setResult(undefined)
    setError(undefined)
    const r = await providerProbe(props.http, {
      directory: props.directory,
      providerID: effectiveProviderID(),
      baseURL: form.baseURL.trim(),
      apiKey: form.apiKey.trim() || undefined,
      authStyle: preset()?.authStyle,
    }).catch((e): ProbeResult => ({ status: "error", detail: String(e).slice(0, 200) }))
    setProbing(false)
    setResult(r)
    if (!r.models || r.models.length === 0) {
      setError(statusMessage(r) || t("settings.models.new.noModels"))
      return
    }
    for (const id of r.models) setPicked(id, true)
    setStep("choose")
  }

  const saveProvider = async (input: {
    providerID: string
    name: string
    baseURL: string
    ids: readonly string[]
    limits: Readonly<Record<string, { readonly context?: number; readonly output?: number }>>
    apiKey?: string
    apiPackage?: string
    requestBody?: Readonly<Record<string, unknown>>
  }) => {
    if (!input.ids.length || saving()) return
    setSaving(true)
    setError(undefined)
    try {
      const providerID = input.providerID
      const key = input.apiKey?.trim() ?? ""
      const disabled = (config().disabled_providers ?? []).filter((id) => id !== providerID)
      // Patch-merge semantics: only send what changed — the layered store folds this fragment
      // over any existing provider layer, so already-imported models and a previously saved key
      // survive without re-sending.
      const modelsObj: Record<
        string,
        { name: string; limit: { context: number; output: number }; request?: { body: Record<string, unknown> } }
      > = {}
      // Models (d) — a recognized family lands with its recommended sampling pre-filled
      // (request.body is the same overlay the Configure dialog edits; unknown ids get none).
      for (const id of input.ids) {
        const familyPreset = matchPreset(id)
        const limits = input.limits[id]
        modelsObj[id] = {
          name: id,
          // Keep every limit attached to its model: OpenRouter-style catalogs may serve a 32K
          // model beside a 256K one. Unknown fields retain Nova's visible product defaults. Persist both
          // limits so the request stays bounded after restart rather than relying on probe memory.
          limit: {
            context: limits?.context ?? ModelV2.DEFAULT_LIMIT.context,
            output: limits?.output ?? ModelV2.DEFAULT_LIMIT.output,
          },
          ...(familyPreset === undefined && input.requestBody === undefined
            ? {}
            : { request: { body: { ...(familyPreset?.body ?? {}), ...(input.requestBody ?? {}) } } }),
        }
      }
      await serverSync().updateConfig({
        providers: {
          [providerID]: {
            api: { type: "aisdk", package: input.apiPackage ?? OPENAI_COMPATIBLE, url: input.baseURL },
            name: input.name || providerID,
            models: modelsObj,
            // P0 key-gap fix: the key lives INLINE in the provider layer, where V2 resolution
            // reads it. Empty field = keep whatever is already stored (patch-merge never clears).
            ...(key ? { request: { body: { apiKey: key } } } : {}),
          },
        },
        disabled_providers: disabled,
      } as never)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: t("settings.models.new.toast.added", { count: input.ids.length }),
      })
      dialog.close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const add = () =>
    saveProvider({
      providerID: effectiveProviderID(),
      name: saved()?.name?.trim() || form.baseURL.trim(),
      baseURL: form.baseURL.trim(),
      ids: pickedIDs(),
      limits: result()?.limits ?? {},
      apiKey: form.apiKey,
      apiPackage: preset()?.api,
    })

  const useManaged = async (status: LocalModelStatus) => {
    if (!status.baseURL || !status.modelID) return
    const providerID = freeProviderID("local")
    await saveProvider({
      providerID,
      name: "local",
      baseURL: status.baseURL,
      ids: [status.modelID],
      limits: {
        [status.modelID]: { context: status.context, output: status.output },
      },
      // Qwen's thinking mode can consume the whole response budget before producing visible text.
      // This laptop profile is the fast setup/repair model, so it defaults to direct answers; the
      // user can still change the model body later through the ordinary config surface.
      requestBody: { thinkingBudget: 0, chat_template_kwargs: { enable_thinking: false } },
    })
  }

  let managedPoll: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => managedPoll && clearTimeout(managedPoll))
  const refreshManaged = async (): Promise<void> => {
    const status = await localModelStatus(props.http, { directory: props.directory }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    })
    if (!status) return
    setManaged(status)
    if (status.context !== undefined) setManagedContext(status.context)
    if (status.stage === "installed" || status.stage === "ready") {
      await useManaged(status)
      return
    }
    if (status.stage === "error") return
    managedPoll = setTimeout(() => void refreshManaged(), 750)
  }
  const installManaged = async (profileID: string) => {
    setError(undefined)
    const status = await localModelInstall(props.http, {
      directory: props.directory,
      profileID,
      context: managedContext(),
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    })
    if (!status) return
    setManaged(status)
    if (status.stage === "installed" || status.stage === "ready") await useManaged(status)
    else if (status.stage !== "error") managedPoll = setTimeout(() => void refreshManaged(), 500)
  }

  const Field = (p: { field: "baseURL" | "apiKey"; type?: string; placeholder?: string }) => (
    <div class="flex flex-col gap-1.5">
      <label class="text-[12px] font-medium text-v2-text-text-faint">
        {t(`settings.models.new.field.${p.field}.label`)}
      </label>
      <TextInputV2
        type={p.type ?? "text"}
        appearance="base"
        value={form[p.field]}
        onInput={(event) => setForm(p.field, event.currentTarget.value)}
        placeholder={p.placeholder ?? t(`settings.models.new.field.${p.field}.placeholder`)}
        spellcheck={false}
        autocorrect="off"
        autocomplete="off"
        autocapitalize="off"
      />
    </div>
  )

  const BackButton = (p: { to: "pick" | "connect" }) => (
    <button
      type="button"
      class="flex items-center gap-1 self-start text-[12px] font-medium text-v2-text-text-muted hover:text-v2-text-text-base transition-colors"
      onClick={() => {
        setError(undefined)
        if (p.to === "pick") setResult(undefined)
        setStep(p.to)
      }}
    >
      <Icon name="chevron-down" size="small" class="rotate-90" />
      {t("settings.models.new.back")}
    </button>
  )

  const managedBusy = () => {
    const stage = managed()?.stage
    return (
      stage === "checking" ||
      stage === "downloading-runtime" ||
      stage === "installing-runtime" ||
      stage === "downloading-model" ||
      stage === "starting"
    )
  }
  const bytesLabel = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`
  const progress = () => {
    const status = managed()
    if (!status?.completed || !status.total) return undefined
    return Math.min(100, Math.round((status.completed / status.total) * 100))
  }

  return (
    <Dialog size="content">
      <div class="flex flex-col gap-4 px-7 py-7 min-w-[22rem] max-w-[32rem]">
        <div class="flex flex-col gap-1 text-center">
          <span class="text-[17px] font-semibold text-v2-text-text-base">
            {step() === "connect"
              ? t("settings.models.new.connect.title", { name: form.baseURL || "…" })
              : step() === "local"
                ? t("settings.models.new.managed.title")
                : t("settings.models.new.title")}
          </span>
          <span class="text-[13px] font-medium text-v2-text-text-muted">
            {step() === "pick"
              ? t("settings.models.new.description")
              : step() === "local"
                ? t("settings.models.new.managed.description")
                : t("settings.models.new.connect.description")}
          </span>
        </div>

        <Show when={step() === "pick"}>
          <div class="flex flex-col gap-3">
            {/* S0 — a model server already running on the instance's machine. Above the presets and
                above Custom endpoint, because it is the only option here that needs no typing at
                all: one click and the model list is already in hand. */}
            <Show when={localSweep() === undefined}>
              <span class="text-[11px] text-v2-text-text-faint">{t("settings.models.new.local.checking")}</span>
            </Show>
            <Show when={localFound().length > 0}>
              <div class="flex flex-col gap-2">
                <span class="text-[12px] font-medium text-v2-text-text-faint">
                  {t("settings.models.new.local.title")}
                </span>
                <div class="grid grid-cols-2 gap-2">
                  <For each={localFound()}>
                    {(outcome) => (
                      <button
                        type="button"
                        data-action="new-model-local"
                        class="flex flex-col items-start gap-1.5 rounded-xl px-3.5 py-3 text-left ring-1 ring-v2-text-text-accent bg-v2-background-bg-layer-01 hover:bg-v2-background-bg-layer-02 transition-colors"
                        onClick={() => adoptLocal(outcome)}
                      >
                        <span class="flex items-center gap-2">
                          <Icon name="server" size="small" class="shrink-0 text-v2-icon-icon-accent" />
                          {/* The ADDRESS is what we verified, so the address is what the card claims.
                              Ruling 2: a `/v1/models` answer on :11434 does not prove that the program
                              answering is Ollama — that is a hint, and it reads as one. */}
                          <span class="text-[13px] font-semibold text-v2-text-text-base">
                            {`localhost:${outcome.candidate.port}`}
                          </span>
                        </span>
                        <span class="text-[11px] leading-snug text-v2-text-text-faint">
                          {outcome.kind === "found"
                            ? t("settings.models.new.local.models", { count: outcome.models.length })
                            : t("settings.models.new.local.needsKey")}
                          {" · "}
                          {t("settings.models.new.local.usually", { runtime: outcome.candidate.usually })}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
            {/* Not "nothing found" — the probe itself could not run, and saying the former would be
                ruling 2's *a fault described falsely*. */}
            <Show when={localUnavailable()}>
              <span class="text-[11px] text-v2-text-text-faint">{t("settings.models.new.local.unavailable")}</span>
            </Show>
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                data-action="new-model-local"
                class="flex flex-col items-start gap-1.5 rounded-xl px-3.5 py-3 text-left ring-1 ring-v2-border-border-base hover:bg-v2-background-bg-layer-01 transition-colors"
                onClick={() => {
                  setError(undefined)
                  setStep("local")
                  if (!managed()) void refreshManaged()
                }}
              >
                <span class="flex items-center gap-2">
                  <Icon name="cpu" size="small" class="shrink-0 text-v2-icon-icon-accent" />
                  <span class="text-[13px] font-semibold text-v2-text-text-base">
                    {t("settings.models.new.managed.name")}
                  </span>
                </span>
                <span class="text-[11px] leading-snug text-v2-text-text-faint">
                  {t("settings.models.new.managed.card")}
                </span>
              </button>
              {/* Custom endpoint FIRST (owner, 2026-07-27). It used to trail every branded preset, which
                  had the priority backwards: NovaClaw's own story is "point it at your own model" — a local
                  vLLM / llama.cpp / LM Studio / Ollama endpoint — and that is also the path a user with no
                  models at all is most likely arriving on, since the picker now sends them straight here.
                  The branded presets are the convenience; they follow.
                  ⚠️ S0 sits ABOVE this, not in place of it: a found runtime is the same story with the
                  typing already done, and when nothing is found this is still the first card. */}
              <button
                type="button"
                data-action="new-model-custom"
                class="flex flex-col items-start gap-1.5 rounded-xl px-3.5 py-3 text-left ring-1 ring-v2-border-border-base hover:bg-v2-background-bg-layer-01 transition-colors"
                onClick={chooseCustom}
              >
                <span class="flex items-center gap-2">
                  <Icon name="sliders" size="small" class="shrink-0 text-v2-icon-icon-accent" />
                  <span class="text-[13px] font-semibold text-v2-text-text-base">
                    {t("settings.models.new.custom.name")}
                  </span>
                </span>
                <span class="text-[11px] leading-snug text-v2-text-text-faint">
                  {t("settings.models.new.custom.description")}
                </span>
              </button>
              <For each={visiblePresets()}>
                {([id, entry]) => (
                  <button
                    type="button"
                    class="flex flex-col items-start gap-1.5 rounded-xl px-3.5 py-3 text-left ring-1 ring-v2-border-border-base hover:bg-v2-background-bg-layer-01 transition-colors"
                    onClick={() => choose(id, entry)}
                  >
                    <span class="flex items-center gap-2">
                      <ProviderIcon id={id} class="size-4 shrink-0" />
                      <span class="text-[13px] font-semibold text-v2-text-text-base">{entry.name ?? id}</span>
                    </span>
                    <Show when={entry.description}>
                      <span class="text-[11px] leading-snug text-v2-text-text-faint">{entry.description}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={step() === "local"}>
          <div class="flex flex-col gap-3">
            <BackButton to="pick" />
            <Show
              when={managed()}
              fallback={
                <span class="select-text text-[12px] text-v2-text-text-faint">
                  {error() ?? t("settings.models.new.managed.checking")}
                </span>
              }
            >
              {(status) => (
                <div class="flex flex-col gap-3">
                  <Show when={!status().supported}>
                    <div class="rounded-xl bg-v2-background-bg-layer-01 px-3.5 py-3 text-[12px] text-v2-text-text-danger ring-1 ring-v2-border-border-base">
                      {t("settings.models.new.managed.unsupported", { platform: status().platform })}
                    </div>
                  </Show>
                  <For each={status().profiles}>
                    {(profile) => (
                      <div class="flex flex-col gap-3 rounded-xl px-4 py-4 ring-1 ring-v2-border-border-base">
                        <div class="flex items-start justify-between gap-3">
                          <div class="flex min-w-0 flex-col gap-1">
                            <span class="text-[14px] font-semibold text-v2-text-text-base">{profile.name}</span>
                            <span class="text-[12px] leading-snug text-v2-text-text-muted">{profile.description}</span>
                          </div>
                          <span class="shrink-0 rounded-full bg-v2-background-bg-layer-02 px-2 py-1 text-[10px] font-medium text-v2-text-text-faint">
                            {profile.quant}
                          </span>
                        </div>
                        <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-v2-text-text-faint">
                          <span>
                            {t("settings.models.new.managed.download", { size: bytesLabel(profile.downloadBytes) })}
                          </span>
                          <span>
                            {t("settings.models.new.managed.memory", { size: bytesLabel(profile.minimumMemoryBytes) })}
                          </span>
                          <span>
                            {t("settings.models.new.managed.context", {
                              count: tokenLabel(managedContext() ?? status().recommendedContext),
                            })}
                          </span>
                          <span>{profile.license}</span>
                        </div>
                        <div class="flex items-center gap-1.5">
                          <span class="mr-1 text-[11px] text-v2-text-text-faint">
                            {t("settings.models.new.managed.contextChoice")}
                          </span>
                          <For each={profile.contexts}>
                            {(value) => (
                              <button
                                type="button"
                                class="rounded-lg px-2.5 py-1 text-[11px] font-medium ring-1 transition-colors"
                                classList={{
                                  "bg-v2-background-bg-layer-02 text-v2-text-text-base ring-v2-text-text-accent":
                                    managedContext() === value,
                                  "text-v2-text-text-muted ring-v2-border-border-base hover:bg-v2-background-bg-layer-01":
                                    managedContext() !== value,
                                }}
                                disabled={managedBusy()}
                                aria-pressed={managedContext() === value}
                                onClick={() => setManagedContext(value)}
                              >
                                {tokenLabel(value)}
                              </button>
                            )}
                          </For>
                          <Show when={managedContext() === status().recommendedContext}>
                            <span class="text-[10px] text-v2-text-text-faint">
                              {t("settings.models.new.managed.recommended")}
                            </span>
                          </Show>
                        </div>
                        <Show when={status().profileID === profile.id && status().message}>
                          <div class="flex flex-col gap-1.5">
                            <span class="select-text text-[12px] text-v2-text-text-muted">{status().message}</span>
                            <Show when={progress() !== undefined}>
                              <div class="h-1.5 overflow-hidden rounded-full bg-v2-background-bg-layer-02">
                                <div
                                  class="h-full rounded-full bg-v2-icon-icon-accent transition-[width]"
                                  style={{ width: `${progress()}%` }}
                                />
                              </div>
                              <span class="text-[10px] text-v2-text-text-faint">
                                {t("settings.models.new.managed.progress", { percent: progress() ?? 0 })}
                              </span>
                            </Show>
                          </div>
                        </Show>
                        <Show when={status().preflight?.issues.length}>
                          <For each={status().preflight?.issues}>
                            {(issue) => <span class="select-text text-[11px] text-v2-text-text-danger">{issue}</span>}
                          </For>
                        </Show>
                        <Show when={status().stage === "error" && status().profileID === profile.id}>
                          <span class="select-text whitespace-pre-wrap text-[11px] text-v2-text-text-danger">
                            {status().detail ?? status().message}
                          </span>
                        </Show>
                        <ButtonV2
                          size="normal"
                          variant="gold"
                          disabled={
                            !status().supported ||
                            managedBusy() ||
                            saving() ||
                            (managedContext() === status().context && status().preflight?.ok === false)
                          }
                          onClick={() =>
                            (status().stage === "installed" || status().stage === "ready") &&
                            managedContext() === status().context
                              ? void useManaged(status())
                              : void installManaged(profile.id)
                          }
                        >
                          {(status().stage === "installed" || status().stage === "ready") &&
                          managedContext() === status().context
                            ? t("settings.models.new.managed.use")
                            : managedBusy()
                              ? t("settings.models.new.managed.working")
                              : t("settings.models.new.managed.install")}
                        </ButtonV2>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </Show>
            <Show when={managed() && error()}>
              <span class="select-text text-[12px] text-v2-text-text-danger">{error()}</span>
            </Show>
          </div>
        </Show>

        <Show when={step() === "connect"}>
          <div class="flex flex-col gap-3">
            <BackButton to="pick" />
            <Field field="baseURL" />
            <div class="flex flex-col gap-1.5">
              <Field
                field="apiKey"
                type="password"
                placeholder={savedKey() ? t("settings.models.new.field.apiKey.keep") : undefined}
              />
              <Show when={preset()?.keyURL}>
                {(url) => (
                  <a
                    href={url()}
                    target="_blank"
                    rel="noreferrer"
                    class="flex items-center gap-1 self-start text-[12px] font-medium text-v2-text-text-accent hover:underline"
                  >
                    {t("settings.models.new.getKey")}
                    <Icon name="share" size="small" />
                  </a>
                )}
              </Show>
              <span class="text-[11px] text-v2-text-text-faint">{t("settings.models.new.keyHint")}</span>
            </div>
            <ButtonV2 size="normal" variant="gold" disabled={!canDiscover()} onClick={() => void discover()}>
              {probing() ? t("settings.models.new.discovering") : t("settings.models.new.discover")}
            </ButtonV2>
            <Show when={error()}>
              <span class="text-[12px] text-v2-text-text-danger">{error()}</span>
            </Show>
          </div>
        </Show>

        <Show when={step() === "choose"}>
          <div class="flex flex-col gap-2">
            <BackButton to="connect" />
            <label class="text-[12px] font-medium text-v2-text-text-faint">
              {t("settings.models.new.pick", { count: models().length })}
            </label>
            <div class="flex flex-col gap-1.5 max-h-[36vh] overflow-y-auto -mx-1 px-1">
              <For each={models()}>
                {(id) => (
                  <button
                    type="button"
                    class="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-[13px] ring-1 transition-colors"
                    classList={{
                      "ring-v2-text-text-accent bg-v2-background-bg-layer-02 text-v2-text-text-base": !!picked[id],
                      "ring-v2-border-border-base text-v2-text-text-muted hover:bg-v2-background-bg-layer-01":
                        !picked[id],
                    }}
                    aria-pressed={!!picked[id]}
                    onClick={() => setPicked(id, !picked[id])}
                  >
                    <span class="min-w-0 flex flex-col gap-0.5">
                      <span class="truncate">{id}</span>
                      <span class="text-[10px] leading-snug text-v2-text-text-faint">{limitDescription(id)}</span>
                    </span>
                    <span class="ml-auto flex shrink-0 items-center gap-2">
                      <Show when={matchPreset(id)}>
                        {(familyPreset) => (
                          <span class="text-[11px] text-v2-text-text-faint">
                            {t("settings.models.new.preset", { family: familyPreset().family })}
                          </span>
                        )}
                      </Show>
                      <Show when={picked[id]}>
                        <Icon name="check" size="small" class="shrink-0 text-v2-icon-icon-accent" />
                      </Show>
                    </span>
                  </button>
                )}
              </For>
            </div>
            <Show when={error()}>
              <span class="text-[12px] text-v2-text-text-danger">{error()}</span>
            </Show>
          </div>
        </Show>

        <div class="flex items-center justify-end gap-2 pt-1">
          <ButtonV2 size="normal" variant="ghost-muted" onClick={() => dialog.close()}>
            {t("common.cancel")}
          </ButtonV2>
          <Show when={step() === "choose"}>
            <ButtonV2
              size="normal"
              variant="gold"
              disabled={!pickedIDs().length || saving()}
              onClick={() => void add()}
            >
              {t("settings.models.new.add", { count: pickedIDs().length })}
            </ButtonV2>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

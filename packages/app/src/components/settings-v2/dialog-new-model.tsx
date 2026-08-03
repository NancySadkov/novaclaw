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
import { providerPresets, providerProbe, type ProbeResult, type ProviderPreset } from "@/utils/fs-api"
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

  const [step, setStep] = createSignal<"pick" | "connect" | "choose">("pick")
  // undefined = nothing chosen yet; "custom" = the free-form endpoint card.
  const [presetID, setPresetID] = createSignal<string | "custom">()
  const [form, setForm] = createStore({ baseURL: "", providerID: "", name: "", apiKey: "" })
  const [probing, setProbing] = createSignal(false)
  const [result, setResult] = createSignal<ProbeResult>()
  const [picked, setPicked] = createStore<Record<string, boolean>>({})
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()

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
  onMount(() => {
    // A Resource created while dialog.push() commits inside a Solid transition can suspend the
    // dialog itself. Mount the usable Custom endpoint card first; discovery fills in afterward.
    const abort = new AbortController()
    void providerPresets(props.http, { directory: props.directory, signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setPresets(value)
      })
      .catch(() => undefined)
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

  const saved = (): SavedProvider | undefined => config().providers?.[form.providerID.trim()]
  const savedKey = () => typeof saved()?.request?.body?.apiKey === "string" && !!saved()?.request?.body?.apiKey
  const models = () => result()?.models ?? []
  const validID = () => PROVIDER_ID.test(form.providerID.trim())
  const canDiscover = () => !!form.baseURL.trim() && validID() && !probing()
  const pickedIDs = () => models().filter((id) => picked[id])
  const visiblePresets = () => Object.entries(presets()).filter(([, entry]) => entry.hidden !== true)

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
      name: existing?.name ?? entry.name ?? id,
      apiKey: "",
    })
    setResult(undefined)
    setError(undefined)
    setStep("connect")
  }

  const chooseCustom = () => {
    setPresetID("custom")
    setForm({ baseURL: "", providerID: "", name: "", apiKey: "" })
    setResult(undefined)
    setError(undefined)
    setStep("connect")
  }

  // Adopt a runtime the sweep found. `presetID` is set to "custom" because that is what this IS —
  // a user-owned OpenAI-compatible endpoint — so Back shows the editable Short-name field and no
  // branded preset can leak an api channel or a keyURL into a local server.
  const adoptLocal = (outcome: ConfigLocalRuntime.Outcome) => {
    const found = outcome.candidate
    setPresetID("custom")
    setForm({
      baseURL: found.baseURL,
      // Never silently repoint an existing id: if `ollama` is taken by a provider aimed elsewhere,
      // overwriting its endpoint would break a working setup in order to install a new one. Same
      // resolution the probe used, so the id on screen is the id that was tested.
      providerID: freeProviderID(found.id),
      name: found.label,
      apiKey: "",
    })
    setError(undefined)
    if (outcome.kind === "found") {
      // The sweep already carries the model list — probing the same endpoint twice to learn the
      // same answer would be a second wait for nothing.
      setResult({ status: "ok", models: outcome.models })
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
      providerID: form.providerID.trim(),
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

  const add = async () => {
    const ids = pickedIDs()
    if (!ids.length || saving()) return
    setSaving(true)
    setError(undefined)
    try {
      const providerID = form.providerID.trim()
      const key = form.apiKey.trim()
      const disabled = (config().disabled_providers ?? []).filter((id) => id !== providerID)
      // Patch-merge semantics: only send what changed — the layered store folds this fragment
      // over any existing provider layer, so already-imported models and a previously saved key
      // survive without re-sending.
      const modelsObj: Record<
        string,
        { name: string; limit: { context: number; output: number }; request?: { body: Record<string, number> } }
      > = {}
      // Models (d) — a recognized family lands with its recommended sampling pre-filled
      // (request.body is the same overlay the Configure dialog edits; unknown ids get none).
      for (const id of ids) {
        const familyPreset = matchPreset(id)
        modelsObj[id] = {
          name: id,
            // A discovery response may carry one shared server window (vLLM max_model_len,
            // llama.cpp meta.n_ctx). Unknown fields retain Nova's 64K default. Persist both
          // limits so the request stays bounded after restart rather than relying on probe memory.
          limit: {
            context: result()?.window ?? ModelV2.DEFAULT_LIMIT.context,
            output: ModelV2.DEFAULT_LIMIT.output,
          },
          ...(familyPreset === undefined ? {} : { request: { body: familyPreset.body } }),
        }
      }
      await serverSync().updateConfig({
        providers: {
          [providerID]: {
            api: { type: "aisdk", package: preset()?.api ?? OPENAI_COMPATIBLE, url: form.baseURL.trim() },
            name: form.name.trim() || providerID,
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
        title: t("settings.models.new.toast.added", { count: ids.length }),
      })
      dialog.close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const Field = (p: { field: "baseURL" | "providerID" | "name" | "apiKey"; type?: string; placeholder?: string }) => (
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
      <Show when={p.field === "providerID" && !!form.providerID.trim() && !validID()}>
        <span class="text-[11px] text-v2-text-text-danger">{t("settings.models.new.field.providerID.invalid")}</span>
      </Show>
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

  return (
    <Dialog size="content">
      <div class="flex flex-col gap-4 px-7 py-7 min-w-[22rem] max-w-[32rem]">
        <div class="flex flex-col gap-1 text-center">
          <span class="text-[17px] font-semibold text-v2-text-text-base">
            {step() === "connect"
              ? t("settings.models.new.connect.title", { name: form.name || form.providerID || "…" })
              : t("settings.models.new.title")}
          </span>
          <span class="text-[13px] font-medium text-v2-text-text-muted">
            {step() === "pick" ? t("settings.models.new.description") : t("settings.models.new.connect.description")}
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

        <Show when={step() === "connect"}>
          <div class="flex flex-col gap-3">
            <BackButton to="pick" />
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
            <Show when={presetID() === "custom"}>
              <Field field="providerID" />
            </Show>
            <Field field="name" />
            <Field field="baseURL" />
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
                    <span class="truncate">{id}</span>
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

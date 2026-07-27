import { Component, For, Show, createResource, createSignal } from "solid-js"
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
import type { ServerConnection } from "@/context/server"

// "Add models" — the provider-import flow. Three steps in one dialog:
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
  const t = (key: string, vars?: Record<string, string | number | boolean>) =>
    language.t(key as Parameters<typeof language.t>[0], vars as never)

  const [presets] = createResource(
    () => providerPresets(props.http, { directory: props.directory }).catch(() => ({}) as Record<string, ProviderPreset>),
    { initialValue: {} as Record<string, ProviderPreset> },
  )

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
    return id === undefined || id === "custom" ? undefined : presets.latest[id]
  }
  const saved = (): SavedProvider | undefined => config().providers?.[form.providerID.trim()]
  const savedKey = () => typeof saved()?.request?.body?.apiKey === "string" && !!saved()?.request?.body?.apiKey
  const models = () => result()?.models ?? []
  const validID = () => PROVIDER_ID.test(form.providerID.trim())
  const canDiscover = () => !!form.baseURL.trim() && validID() && !probing()
  const pickedIDs = () => models().filter((id) => picked[id])
  const visiblePresets = () =>
    Object.entries(presets.latest).filter(([, entry]) => entry.hidden !== true)

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
      const modelsObj: Record<string, { name: string; request?: { body: Record<string, number> } }> = {}
      // Models (d) — a recognized family lands with its recommended sampling pre-filled
      // (request.body is the same overlay the Configure dialog edits; unknown ids get none).
      for (const id of ids) {
        const familyPreset = matchPreset(id)
        modelsObj[id] = { name: id, ...(familyPreset === undefined ? {} : { request: { body: familyPreset.body } }) }
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
          <div class="grid grid-cols-2 gap-2">
            {/* Custom endpoint FIRST (owner, 2026-07-27). It used to trail every branded preset, which
                had the priority backwards: NovaClaw's own story is "point it at your own model" — a local
                vLLM / llama.cpp / LM Studio / Ollama endpoint — and that is also the path a user with no
                models at all is most likely arriving on, since the picker now sends them straight here.
                The branded presets are the convenience; they follow. */}
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
            <ButtonV2 size="normal" variant="gold" disabled={!pickedIDs().length || saving()} onClick={() => void add()}>
              {t("settings.models.new.add", { count: pickedIDs().length })}
            </ButtonV2>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

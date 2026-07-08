import { Component, For, Show, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { Icon } from "@novaclaw/ui/icon"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { providerProbe, type ProbeResult } from "@/utils/fs-api"
import type { ServerConnection } from "@/context/server"

// "New Model": paste an access-point URL (+ optional key), NovaClaw PROBES it (GET {url}/models,
// server-side) to DISCOVER the served models, and the user picks which to add. Saves an
// OpenAI-compatible provider + the picked models to novaclaw.jsonc — the same config shape the
// custom-provider flow writes. Discovery is OpenAI-compatible today (vLLM / llama.cpp / Ollama /
// LM Studio / OpenAI all expose /v1/models); other API families are a follow-up (todo.md).
const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/
const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

export const DialogNewModel: Component<{
  http: ServerConnection.HttpBase
  directory: string
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const t = (key: string, vars?: Record<string, string | number | boolean>) =>
    language.t(key as Parameters<typeof language.t>[0], vars as never)

  const [form, setForm] = createStore({ baseURL: "", providerID: "", name: "", apiKey: "" })
  const [probing, setProbing] = createSignal(false)
  const [result, setResult] = createSignal<ProbeResult>()
  const [picked, setPicked] = createStore<Record<string, boolean>>({})
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const models = () => result()?.models ?? []
  const validID = () => PROVIDER_ID.test(form.providerID.trim())
  const canDiscover = () => !!form.baseURL.trim() && validID() && !probing()
  const pickedIDs = () => models().filter((id) => picked[id])

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
    }).catch((e): ProbeResult => ({ status: "error", detail: String(e).slice(0, 200) }))
    setProbing(false)
    setResult(r)
    if (!r.models || r.models.length === 0) setError(statusMessage(r) || t("settings.models.new.noModels"))
    for (const id of r.models ?? []) setPicked(id, true)
  }

  const add = async () => {
    const ids = pickedIDs()
    if (!ids.length || saving()) return
    setSaving(true)
    setError(undefined)
    try {
      const providerID = form.providerID.trim()
      const key = form.apiKey.trim()
      if (key) await serverSDK().client.auth.set({ providerID, auth: { type: "api", key } })
      // F1d: config is V2 now — author the `providers` (not `provider`) shape: the endpoint URL lives
      // on `api.url`, and the openai-compatible SDK package on `api.package`.
      const cfg = serverSync().data.config as {
        disabled_providers?: string[]
        providers?: Record<string, { name?: string; models?: Record<string, unknown> }>
      }
      const disabled = (cfg.disabled_providers ?? []).filter((id) => id !== providerID)
      const existing = cfg.providers?.[providerID] ?? {}
      const modelsObj: Record<string, { name: string }> = { ...(existing.models as Record<string, { name: string }>) }
      for (const id of ids) modelsObj[id] = { name: id }
      await serverSync().updateConfig({
        providers: {
          [providerID]: {
            ...existing,
            api: { type: "aisdk", package: OPENAI_COMPATIBLE, url: form.baseURL.trim() },
            name: form.name.trim() || providerID,
            models: modelsObj,
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

  const Field = (p: { field: "baseURL" | "providerID" | "name" | "apiKey"; type?: string }) => (
    <div class="flex flex-col gap-1.5">
      <label class="text-[12px] font-medium text-v2-text-text-faint">
        {t(`settings.models.new.field.${p.field}.label`)}
      </label>
      <TextInputV2
        type={p.type ?? "text"}
        appearance="base"
        value={form[p.field]}
        onInput={(event) => setForm(p.field, event.currentTarget.value)}
        placeholder={t(`settings.models.new.field.${p.field}.placeholder`)}
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

  return (
    <Dialog size="content">
      <div class="flex flex-col gap-4 px-7 py-7 min-w-[22rem] max-w-[32rem]">
        <div class="flex flex-col gap-1 text-center">
          <span class="text-[17px] font-semibold text-v2-text-text-base">{t("settings.models.new.title")}</span>
          <span class="text-[13px] font-medium text-v2-text-text-muted">{t("settings.models.new.description")}</span>
        </div>

        <div class="flex flex-col gap-3">
          <Field field="baseURL" />
          <Field field="providerID" />
          <Field field="name" />
          <Field field="apiKey" type="password" />
          <ButtonV2 size="normal" variant="neutral" disabled={!canDiscover()} onClick={() => void discover()}>
            {probing() ? t("settings.models.new.discovering") : t("settings.models.new.discover")}
          </ButtonV2>
          <Show when={error()}>
            <span class="text-[12px] text-v2-text-text-danger">{error()}</span>
          </Show>
        </div>

        <Show when={models().length}>
          <div class="flex flex-col gap-2">
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
                    <Show when={picked[id]}>
                      <Icon name="check" size="small" class="shrink-0 text-v2-icon-icon-accent" />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <div class="flex items-center justify-end gap-2 pt-1">
          <ButtonV2 size="normal" variant="ghost-muted" onClick={() => dialog.close()}>
            {t("common.cancel")}
          </ButtonV2>
          <Show when={models().length}>
            <ButtonV2 size="normal" variant="gold" disabled={!pickedIDs().length || saving()} onClick={() => void add()}>
              {t("settings.models.new.add", { count: pickedIDs().length })}
            </ButtonV2>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

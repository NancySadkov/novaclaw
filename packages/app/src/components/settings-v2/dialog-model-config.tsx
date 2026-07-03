import { Component, For } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

// The per-model config the dialog reads from / writes back to provider.<id>.models.<id> in
// novaclaw.jsonc. Sampling knobs live under `options` (passed to the model API); limits, capability
// flags, and modalities describe the model. We are "far from Plug&Play for LLMs" (owner), so every
// knob is exposed — but each carries a friendly name + one-line explanation.
type ModelConfig = {
  reasoning?: boolean
  tool_call?: boolean
  limit?: { context?: number; output?: number }
  modalities?: { input?: string[]; output?: string[] }
  options?: Record<string, unknown>
  [k: string]: unknown
}

const MODALITIES = ["text", "image", "audio"] as const
// Sampling params in display order. Each is a number the user may leave blank (= model/provider default).
const SAMPLING = ["temperature", "top_p", "top_k", "min_p", "repetition_penalty", "presence_penalty", "frequency_penalty"] as const
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const DialogModelConfig: Component<{
  providerID: string
  modelID: string
  modelName: string
  // Catalog spec, so a brand-new/unconfigured model opens with sane defaults rather than blanks.
  defaults?: ModelConfig
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSync = useServerSync()
  const tk = (key: string) => language.t(key as Parameters<typeof language.t>[0])

  const providerCfg = (): { models?: Record<string, ModelConfig>; [k: string]: unknown } =>
    (serverSync().data.config?.provider as Record<string, { models?: Record<string, ModelConfig> }> | undefined)?.[
      props.providerID
    ] ?? {}
  const savedModel = (): ModelConfig => providerCfg().models?.[props.modelID] ?? {}

  const init = savedModel()
  const d = props.defaults ?? {}
  const nstr = (v: unknown) => (typeof v === "number" ? String(v) : "")
  const optNum = (k: string) => nstr((init.options as Record<string, unknown> | undefined)?.[k])
  const inMod = init.modalities?.input ?? d.modalities?.input ?? ["text"]
  const outMod = init.modalities?.output ?? d.modalities?.output ?? ["text"]

  const [form, setForm] = createStore({
    temperature: optNum("temperature"),
    top_p: optNum("top_p"),
    top_k: optNum("top_k"),
    min_p: optNum("min_p"),
    repetition_penalty: optNum("repetition_penalty"),
    presence_penalty: optNum("presence_penalty"),
    frequency_penalty: optNum("frequency_penalty"),
    context: nstr(init.limit?.context ?? d.limit?.context),
    maxTokens: nstr(init.limit?.output ?? d.limit?.output),
    reasoning: init.reasoning ?? d.reasoning ?? false,
    tool_call: init.tool_call ?? d.tool_call ?? true,
    inText: inMod.includes("text"),
    inImage: inMod.includes("image"),
    inAudio: inMod.includes("audio"),
    outText: outMod.includes("text"),
    outImage: outMod.includes("image"),
    outAudio: outMod.includes("audio"),
  })

  const num = (s: string): number | undefined => {
    const t = s.trim()
    if (!t) return undefined
    const n = Number(t)
    return Number.isFinite(n) ? n : undefined
  }

  const save = async () => {
    const options: Record<string, number> = {}
    for (const k of SAMPLING) {
      const v = num(form[k])
      if (v !== undefined) options[k] = v
    }
    const limit: { context?: number; output?: number } = {}
    if (num(form.context) !== undefined) limit.context = num(form.context)
    if (num(form.maxTokens) !== undefined) limit.output = num(form.maxTokens)
    const input = MODALITIES.filter((m) => form[`in${cap(m)}` as "inText" | "inImage" | "inAudio"])
    const output = MODALITIES.filter((m) => form[`out${cap(m)}` as "outText" | "outImage" | "outAudio"])

    const model: ModelConfig = {
      ...savedModel(),
      reasoning: form.reasoning,
      tool_call: form.tool_call,
      limit,
      modalities: { input, output },
      options,
    }
    // Reconstruct the whole provider entry (preserving npm/options.baseURL + other models) with just
    // this model replaced — the same shape the custom-provider flow writes, safe against merge depth.
    const provider = providerCfg()
    const patch = {
      provider: {
        [props.providerID]: { ...provider, models: { ...(provider.models ?? {}), [props.modelID]: model } },
      },
    }
    try {
      await serverSync().updateConfig(patch as never)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.models.config.toast.saved"),
      })
      dialog.close()
    } catch (error) {
      showToast({
        title: language.t("settings.models.config.toast.failed"),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const numInput = (field: keyof typeof form) => (
    <div class="w-[128px] shrink-0">
      <TextInputV2
        type="text"
        appearance="base"
        inputmode="decimal"
        value={form[field] as string}
        onInput={(event) => setForm(field as never, event.currentTarget.value as never)}
        placeholder={tk("settings.models.config.defaultPlaceholder")}
        spellcheck={false}
        autocorrect="off"
        autocomplete="off"
        autocapitalize="off"
        aria-label={tk(`settings.models.config.${String(field)}.name`)}
      />
    </div>
  )

  const modalityRow = (dir: "in" | "out") => (
    <SettingsRowV2
      title={tk(`settings.models.config.modalities.${dir}.name`)}
      description={tk(`settings.models.config.modalities.${dir}.desc`)}
    >
      <div class="flex gap-1.5 flex-wrap justify-end">
        <For each={MODALITIES}>
          {(m) => {
            const field = `${dir}${cap(m)}` as keyof typeof form
            return (
              <button
                type="button"
                class="rounded-full px-3 py-1 text-[12px] font-medium ring-1 transition-colors"
                classList={{
                  "ring-v2-text-text-accent bg-v2-background-bg-layer-02 text-v2-text-text-base": !!form[field],
                  "ring-v2-border-border-base text-v2-text-text-muted hover:bg-v2-background-bg-layer-01": !form[field],
                }}
                aria-pressed={!!form[field]}
                onClick={() => setForm(field as never, (!form[field]) as never)}
              >
                {tk(`settings.models.config.modality.${m}`)}
              </button>
            )
          }}
        </For>
      </div>
    </SettingsRowV2>
  )

  const section = (key: string) => <h3 class="settings-v2-section-title mt-1">{tk(`settings.models.config.section.${key}`)}</h3>

  return (
    <Dialog size="content">
      <div class="flex flex-col gap-4 px-7 py-7 min-w-[22rem] max-w-[34rem]">
        <div class="flex flex-col gap-1 text-center">
          <span class="text-[17px] font-semibold text-v2-text-text-base">
            {language.t("settings.models.config.title", { model: props.modelName })}
          </span>
          <span class="text-[13px] font-medium text-v2-text-text-muted">
            {language.t("settings.models.config.description")}
          </span>
        </div>

        <div class="flex flex-col gap-4 max-h-[62vh] overflow-y-auto -mx-1 px-1">
          {section("sampling")}
          <SettingsListV2>
            <For each={SAMPLING}>
              {(k) => (
                <SettingsRowV2
                  title={tk(`settings.models.config.${k}.name`)}
                  description={tk(`settings.models.config.${k}.desc`)}
                >
                  {numInput(k)}
                </SettingsRowV2>
              )}
            </For>
          </SettingsListV2>

          {section("limits")}
          <SettingsListV2>
            <SettingsRowV2
              title={tk("settings.models.config.context.name")}
              description={tk("settings.models.config.context.desc")}
            >
              {numInput("context")}
            </SettingsRowV2>
            <SettingsRowV2
              title={tk("settings.models.config.maxTokens.name")}
              description={tk("settings.models.config.maxTokens.desc")}
            >
              {numInput("maxTokens")}
            </SettingsRowV2>
          </SettingsListV2>

          {section("capabilities")}
          <SettingsListV2>
            <SettingsRowV2
              title={tk("settings.models.config.reasoning.name")}
              description={tk("settings.models.config.reasoning.desc")}
            >
              <Switch checked={form.reasoning} onChange={(v) => setForm("reasoning", v)} />
            </SettingsRowV2>
            <SettingsRowV2
              title={tk("settings.models.config.tool_call.name")}
              description={tk("settings.models.config.tool_call.desc")}
            >
              <Switch checked={form.tool_call} onChange={(v) => setForm("tool_call", v)} />
            </SettingsRowV2>
          </SettingsListV2>

          {section("modalities")}
          <SettingsListV2>
            {modalityRow("in")}
            {modalityRow("out")}
          </SettingsListV2>
        </div>

        <div class="flex items-center justify-end gap-2 pt-1">
          <ButtonV2 size="normal" variant="ghost-muted" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 size="normal" variant="gold" onClick={() => void save()}>
            {language.t("common.save")}
          </ButtonV2>
        </div>
      </div>
    </Dialog>
  )
}

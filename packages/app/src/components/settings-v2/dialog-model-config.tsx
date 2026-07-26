import { Component, For, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

// The per-model config the dialog reads from / writes back to provider.<id>.models.<id> in
// novaclaw.jsonc. Sampling knobs live under `options`; limits, capability flags, and modalities
// describe the model. We're "far from Plug&Play for LLMs" (owner), so every knob is exposed — but
// with a NAMED-PRESET droplist beside each raw field, so a user needn't know that e.g.
// repetition_penalty 1.02 is already a meaningful nudge (expert knowledge → taxonomic labels).
type ModelConfig = {
  reasoning?: boolean
  tool_call?: boolean
  limit?: { context?: number; output?: number }
  modalities?: { input?: string[]; output?: string[] }
  options?: Record<string, unknown>
  [k: string]: unknown
}

const MODALITIES = ["text", "image", "audio"] as const
const SAMPLING = ["temperature", "top_p", "top_k", "min_p", "repetition_penalty", "presence_penalty", "frequency_penalty"] as const
type FieldKey = (typeof SAMPLING)[number] | "context" | "maxTokens" | "thinkingBudget"
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// MindControl thinking budget is stored in request.body (the free-form record the runtime reads),
// NOT under `options`/`limit` — see reasoning-budget.ts. Read/written directly by this dialog.
type WithRequestBody = { request?: { headers?: Record<string, string>; body?: Record<string, unknown>; variant?: string } }
const bodyBudget = (m: unknown): unknown => (m as WithRequestBody | undefined)?.request?.body?.thinkingBudget

// Presets per field. `{}` = "use the default" (blank). `word` is a shared i18n intensity term; `size`
// is a literal unit label (context/output are token counts, not intensities). The number is the value.
type RawPreset = { num?: number; word?: string; size?: string }
const PRESETS: Record<FieldKey, RawPreset[]> = {
  temperature: [{}, { word: "precise", num: 0 }, { word: "focused", num: 0.3 }, { word: "balanced", num: 0.7 }, { word: "creative", num: 1 }, { word: "wild", num: 1.3 }],
  top_p: [{}, { word: "off", num: 1 }, { word: "focused", num: 0.9 }, { word: "balanced", num: 0.95 }, { word: "diverse", num: 0.8 }],
  top_k: [{}, { word: "off", num: 0 }, { word: "tight", num: 20 }, { word: "balanced", num: 40 }, { word: "wide", num: 100 }],
  min_p: [{}, { word: "off", num: 0 }, { word: "light", num: 0.05 }, { word: "balanced", num: 0.1 }, { word: "strong", num: 0.2 }],
  repetition_penalty: [{}, { word: "off", num: 1 }, { word: "gentle", num: 1.02 }, { word: "light", num: 1.05 }, { word: "moderate", num: 1.1 }, { word: "strong", num: 1.2 }],
  presence_penalty: [{}, { word: "off", num: 0 }, { word: "light", num: 0.3 }, { word: "moderate", num: 0.6 }, { word: "strong", num: 1 }],
  frequency_penalty: [{}, { word: "off", num: 0 }, { word: "light", num: 0.3 }, { word: "moderate", num: 0.6 }, { word: "strong", num: 1 }],
  context: [{}, { size: "4K", num: 4096 }, { size: "8K", num: 8192 }, { size: "16K", num: 16384 }, { size: "32K", num: 32768 }, { size: "64K", num: 65536 }, { size: "128K", num: 131072 }, { size: "256K", num: 262144 }],
  maxTokens: [{}, { size: "512", num: 512 }, { size: "1K", num: 1024 }, { size: "2K", num: 2048 }, { size: "4K", num: 4096 }, { size: "8K", num: 8192 }, { size: "16K", num: 16384 }, { size: "32K", num: 32768 }],
  // -1 is the DISABLED value (owner 2026-07-26): one entry in the same list rather than a separate switch,
  // because "no budget" is a budget setting. The runtime already collapses any non-positive configured
  // value to 0 (`defaultThinkingBudget` clamps with Math.max(0, …)) and the runner gates on `> 0`, so the
  // sentinel needs no schema, migration or protocol change. Blank still means "derive the default".
  thinkingBudget: [{}, { word: "disabled", num: -1 }, { size: "2K", num: 2048 }, { size: "4K", num: 4096 }, { size: "6K", num: 6144 }, { size: "8K", num: 8192 }, { size: "16K", num: 16384 }, { size: "32K", num: 32768 }],
}

type Opt = { id: string; num: number | undefined; label: string }

export const DialogModelConfig: Component<{
  providerID: string
  modelID: string
  modelName: string
  defaults?: ModelConfig
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSync = useServerSync()
  const tk = (key: string) => language.t(key as Parameters<typeof language.t>[0])

  const providerCfg = (): { models?: Record<string, ModelConfig>; [k: string]: unknown } =>
    (serverSync().data.config?.providers as Record<string, { models?: Record<string, ModelConfig> }> | undefined)?.[
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
    thinkingBudget: nstr(bodyBudget(init) ?? bodyBudget(d)),
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

  const optLabel = (p: RawPreset): string => {
    if (p.num === undefined) return tk("settings.models.config.preset.default")
    // A sentinel is not a quantity: "Disabled (-1)" would invite the reader to reason about -1 tokens.
    if (p.word) return p.num < 0 ? tk(`settings.models.config.preset.${p.word}`) : `${tk(`settings.models.config.preset.${p.word}`)} (${p.num})`
    if (p.size) return p.size
    return String(p.num)
  }
  // The option id is an internal key, and it must not start with "-": a NEGATIVE value (the -1 "Disabled"
  // budget) produced the id "-1", and the listbox then refused to open at all — measured, with the
  // temperature select opening from the identical events while this one stayed shut. Prefixing keeps every
  // id a safe identifier regardless of sign.
  const optId = (p: RawPreset) => (p.num === undefined ? "default" : `v${p.num}`)

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

    // Thinking budget rides request.body (the runtime carrier), preserving any other body params.
    const saved = savedModel()
    const savedRequest = (saved as WithRequestBody).request
    const body: Record<string, unknown> = { ...(savedRequest?.body ?? {}) }
    const tb = num(form.thinkingBudget)
    if (tb !== undefined) body.thinkingBudget = tb
    else delete body.thinkingBudget

    const model: ModelConfig = {
      ...saved,
      reasoning: form.reasoning,
      tool_call: form.tool_call,
      limit,
      modalities: { input, output },
      options,
      request: { ...(savedRequest ?? {}), body },
    }
    const provider = providerCfg()
    // The config key is `providers` (plural) — the schema drops a stray `provider`, which silently
    // discarded every save this dialog made (pre-existing bug, fixed 2026-07-24).
    const patch = {
      providers: {
        [props.providerID]: { ...provider, models: { ...(provider.models ?? {}), [props.modelID]: model } },
      },
    }
    try {
      await serverSync().updateConfig(patch as never)
      showToast({ variant: "success", icon: "circle-check", title: language.t("settings.models.config.toast.saved") })
      dialog.close()
    } catch (error) {
      showToast({
        title: language.t("settings.models.config.toast.failed"),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // A named-preset droplist + a raw input for one numeric field. The droplist teaches typical values
  // by name; the input allows any exact value and reflects back as "Custom" when it matches no preset.
  const PresetField = (p: { field: FieldKey }) => {
    const options = createMemo<Opt[]>(() =>
      PRESETS[p.field].map((preset) => ({ id: optId(preset), num: preset.num, label: optLabel(preset) })),
    )
    const currentNum = () => num(form[p.field])
    const matched = () => options().find((o) => o.num === currentNum())
    const customOpt = (): Opt | undefined =>
      currentNum() !== undefined && !matched()
        ? { id: "custom", num: currentNum(), label: `${tk("settings.models.config.preset.custom")} (${currentNum()})` }
        : undefined
    const allOptions = () => {
      const extra = customOpt()
      return extra ? [...options(), extra] : options()
    }
    const current = () => matched() ?? customOpt() ?? options()[0]
    return (
      // No disabled state here any more. It existed for ONE caller — the old budgeting switch, which greyed
      // the budget row out via `pointer-events-none`. "Disabled" is now a value in the list itself, so a row
      // that cannot be clicked is always a bug; keeping the mechanism around only preserved a way to cause it.
      <div class="flex items-center gap-2 justify-end">
        <SelectV2<Opt>
          appearance="inline"
          aria-label={tk(`settings.models.config.${p.field}.name`)}
          options={allOptions()}
          current={current()}
          value={(o) => o.id}
          label={(o) => o.label}
          placement="bottom-end"
          gutter={6}
          onSelect={(o) => o && setForm(p.field, o.num === undefined ? "" : String(o.num))}
        />
        <div class="w-[76px] shrink-0">
          <TextInputV2
            type="text"
            appearance="base"
            inputmode="decimal"
            value={form[p.field]}
            onInput={(event) => setForm(p.field, event.currentTarget.value)}
            // Select the whole value on focus so typing REPLACES it. These fields arrive pre-filled with
            // the current setting, and a click lands the caret wherever you happened to click — so
            // typing a new number silently INSERTED into the old one. Measured live: a field holding
            // `32768`, clicked and typed `8192`, became `327819268`. Nothing downstream clamps it, so
            // the garbage was persisted; the real dev DB ended up with a thinkingBudget of 600060006000
            // (6000 typed three times), which silently disables the budget it was meant to set.
            onFocus={(event) => event.currentTarget.select()}
            placeholder={tk("settings.models.config.defaultPlaceholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={tk(`settings.models.config.${p.field}.name`)}
          />
        </div>
      </div>
    )
  }

  const paramRow = (field: FieldKey) => (
    <SettingsRowV2
      title={tk(`settings.models.config.${field}.name`)}
      description={tk(`settings.models.config.${field}.desc`)}
    >
      <PresetField field={field} />
    </SettingsRowV2>
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

  const section = (key: string) => (
    <h3 class="settings-v2-section-title mt-1">{tk(`settings.models.config.section.${key}`)}</h3>
  )

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
            <For each={SAMPLING}>{(k) => paramRow(k)}</For>
          </SettingsListV2>

          {section("limits")}
          <SettingsListV2>
            {paramRow("context")}
            {paramRow("maxTokens")}
            {paramRow("thinkingBudget")}
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

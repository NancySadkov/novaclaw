import type {
  ConfigV2Model as ModelConfig,
  ConfigV2Provider as ProviderConfig,
  ProviderApi,
} from "@novaclaw/sdk/v2/client"
import { Component, For, type JSX, Show, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { Icon } from "@novaclaw/ui/v2/icon"
import { mergeProviderKey, type ProviderRequest } from "./provider-key"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { TextareaV2 } from "@novaclaw/ui/v2/textarea-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { providerProbe } from "@/utils/fs-api"
import type { ServerConnection } from "@/context/server"
import { errorMessage } from "@/pages/layout/helpers"
import * as ToolChannel from "./tool-channel"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { PresetFieldV2 } from "./parts/preset-field"
import { SAMPLING, type FieldKey, numFromText as num } from "./parts/preset-value"
import { SettingsRowV2 } from "./parts/row"
import { SettingsExplainV2 } from "./explain"

// Use the HTTP contract directly: obsolete model fields must fail the typecheck, not vanish on Save.
const MODALITIES = ["text", "image", "audio"] as const
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// MindControl thinking budget is stored in request.body (the free-form record the runtime reads),
// NOT under `options`/`limit` — see reasoning-budget.ts. Read/written directly by this dialog.
type WithRequestBody = Pick<ModelConfig, "request">
const bodyBudget = (m: unknown): unknown => (m as WithRequestBody | undefined)?.request?.body?.thinkingBudget

/**
 * THINKING EFFORT — the one the INFERENCE SERVER is told, `reasoning_effort` on the wire.
 *
 * ⚠️ Not `thinkingBudget` above, and the pair is worth naming because the words are nearly the same
 * and the mechanisms are not. The BUDGET is NovaClaw's own controller: it counts reasoning tokens off
 * the stream and interrupts at checkpoints (`session/runner/reasoning-budget.ts`), which is why it is
 * pulled out of the body before the wire (`session/runner/model.ts` → `withDefaults`). The EFFORT is
 * a parameter: it rides `request.body` through `splitModelSampling` into the HTTP overlay and the
 * server decides what it means. A user setting one and getting the other would be a fault described
 * falsely, so they say which is which on screen.
 *
 * Empty means UNSET — the model server's own default (principle 12a: a setting is an override).
 */
const bodyEffort = (m: unknown): unknown => (m as WithRequestBody | undefined)?.request?.body?.reasoning_effort

/**
 * The efforts the product knows, in ascending order (`llm/src/schema/ids.ts` → `ReasoningEfforts`).
 *
 * Offered as a LIST because principle 12(b) says a list-shaped setting offers its list, and this one
 * is the reason the rule exists: until 2026-09-03 the only way to send an effort was to know the
 * literal `reasoning_effort` and type it into a raw body field — a value nothing on screen names.
 * Which of these a given endpoint honours is the SERVER's to say (OpenAI takes minimal…high, GLM
 * takes high and max), so the row says that rather than pretending to know for every endpoint.
 */
const THINKING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export const DialogModelConfig: Component<{
  providerID: string
  modelID: string
  modelName: string
  apiModelID: string
  providerApi: ProviderApi
  defaults?: Pick<ModelConfig, "capabilities">
  /**
   * The connection to probe through, passed in like `DialogNewModel`'s.
   *
   * ⚠️ NOT `useSDK()`/`useServer()`. A settings dialog is pushed OUTSIDE the SDK context provider, so
   * reaching for the context throws "SDK context must be used within a context provider" and the app
   * error boundary swallows the whole dialog. Measured 2026-08-13 by opening it; the typecheck and
   * 1,009 unit tests were green through it.
   */
  http: ServerConnection.HttpBase
  directory: string
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSync = useServerSync()

  const providerCfg = (): ProviderConfig => serverSync().data.config?.providers?.[props.providerID] ?? {}
  const savedModel = (): ModelConfig => providerCfg().models?.[props.modelID] ?? {}

  /**
   * The tool channel in force, and who decided it.
   *
   * Read from the SAME config the runner resolves against — the measurement under
   * `provider_capability`, the operator's answer under this model's `request.body`. Nothing is
   * recomputed here: staleness is checked server-side when a model resolves, and a second
   * implementation would be free to disagree with what is actually in force.
   */
  const channelStatus = () =>
    ToolChannel.status(
      serverSync().data.config as ToolChannel.ConfigLike | undefined,
      props.providerID,
      props.modelID,
      // Where this model points NOW — the same value the form edits, so a URL the user just changed
      // is compared against, not the stale saved one.
      form.apiPath || providerCfg().api?.url || props.providerApi.url,
    )

  const [testing, setTesting] = createSignal(false)
  const [testError, setTestError] = createSignal<string>()

  /**
   * Measure this endpoint and record the verdict.
   *
   * ⚠️ Three generations, so it is only ever this button. The server writes the result, so the panel
   * re-reads it from config rather than holding a second copy that could disagree with the runner.
   */
  const testChannel = async () => {
    setTesting(true)
    setTestError(undefined)
    try {
      const result = await providerProbe(props.http, {
        directory: props.directory,
        providerID: props.providerID,
        modelID: props.modelID,
        capabilities: true,
      })
      // A probe that answers `status: ok` with no capabilities negotiated something it could not
      // measure at all — reported rather than shown as a silent no-op.
      if (result.capabilities === undefined)
        setTestError(result.detail ?? language.t("settings.models.config.toolChannel.testFailed"))
      await serverSync().refetchConfig?.()
    } catch (error) {
      setTestError(errorMessage(error, language.t("settings.models.config.toolChannel.testFailed")))
    } finally {
      setTesting(false)
    }
  }

  const init = savedModel()

  const d = props.defaults ?? {}
  const nstr = (v: unknown) => (typeof v === "number" ? String(v) : "")
  const optNum = (k: string) => nstr(init.request?.body?.[k])
  const inMod = init.capabilities?.input ?? d.capabilities?.input ?? ["text"]
  const outMod = init.capabilities?.output ?? d.capabilities?.output ?? ["text"]
  const defaultProviderName = () =>
    providerCfg().name === "local" ? "local" : (providerCfg().api?.url ?? props.providerApi.url ?? props.providerID)
  const customProviderName = () => {
    const name = providerCfg().name?.trim()
    return name && name !== defaultProviderName() ? name : ""
  }

  /**
   * The key this provider is using, read from where V2 resolution reads it
   * (`providers.<id>.request.body.apiKey` — `session/runner/model.ts`).
   */
  const storedApiKey = (): string => {
    const body = (providerCfg() as { request?: { body?: Record<string, unknown> } }).request?.body
    return typeof body?.["apiKey"] === "string" ? (body["apiKey"] as string) : ""
  }
  const [revealKey, setRevealKey] = createSignal(false)

  // Editable numbers are stored overrides. Seeding from resolved catalog defaults would pin
  // inheritance on the next unrelated Save; blank stays the default until explicitly overridden.
  const [form, setForm] = createStore({
    apiPath: providerCfg().api?.url ?? props.providerApi.url ?? "",
    // Seeded from what is STORED, because the owner's ask was to see it as well as change it. A
    // write-only field cannot answer "which key is this provider using?", which is the question
    // somebody opening this dialog actually has.
    apiKey: storedApiKey(),
    providerName: customProviderName(),
    modelID: init.api?.id ?? props.apiModelID,
    modelName: init.name ?? props.modelName,
    temperature: optNum("temperature"),
    top_p: optNum("top_p"),
    top_k: optNum("top_k"),
    min_p: optNum("min_p"),
    repetition_penalty: optNum("repetition_penalty"),
    presence_penalty: optNum("presence_penalty"),
    frequency_penalty: optNum("frequency_penalty"),
    context: nstr(init.limit?.context),
    maxTokens: nstr(init.limit?.output),
    images: nstr(init.limit?.images),
    thinkingBudget: nstr(bodyBudget(init)),
    thinkingEffort: ((): string => {
      const value = bodyEffort(init)
      return typeof value === "string" && (THINKING_EFFORTS as readonly string[]).includes(value) ? value : ""
    })(),
    retryAttempts: nstr(init.retry?.attempts),
    tool_call: init.capabilities?.tools ?? d.capabilities?.tools ?? true,
    prePrompt: init.prePrompt ?? "",
    inText: inMod.includes("text"),
    inImage: inMod.includes("image"),
    inAudio: inMod.includes("audio"),
    outText: outMod.includes("text"),
    outImage: outMod.includes("image"),
    outAudio: outMod.includes("audio"),
  })

  const save = async () => {
    const limit: { context?: number; output?: number; images?: number } = {}
    if (num(form.context) !== undefined) limit.context = num(form.context)
    if (num(form.maxTokens) !== undefined) limit.output = num(form.maxTokens)
    // Left blank the key is OMITTED, not written as 1 — so the model keeps NO declared cap and the
    // runner's learned value can still outrank the floor. Writing 1 here would pin it forever.
    if (num(form.images) !== undefined) limit.images = num(form.images)
    const input = MODALITIES.filter((m) => form[`in${cap(m)}` as "inText" | "inImage" | "inAudio"])
    const output = MODALITIES.filter((m) => form[`out${cap(m)}` as "outText" | "outImage" | "outAudio"])

    // Thinking budget rides request.body (the runtime carrier), preserving any other body params.
    const saved = savedModel()
    const savedRequest = saved.request
    const body: Record<string, unknown> = { ...(savedRequest?.body ?? {}) }
    for (const key of SAMPLING) {
      const value = num(form[key])
      if (value !== undefined) body[key] = value
      else delete body[key]
    }
    const tb = num(form.thinkingBudget)
    if (tb !== undefined) body.thinkingBudget = tb
    else delete body.thinkingBudget
    // Unset clears the key rather than sending an empty string: the server's default is the absence
    // of the parameter, not a parameter whose value is "".
    if (form.thinkingEffort) body.reasoning_effort = form.thinkingEffort
    else delete body.reasoning_effort

    const model: ModelConfig = {
      ...saved,
      name: form.modelName.trim() || props.modelName,
      api: { ...(saved.api ?? {}), id: form.modelID.trim() || props.apiModelID },
      limit,
      capabilities: { tools: form.tool_call, input, output },
      request: { ...(savedRequest ?? {}), body },
      retry:
        num(form.retryAttempts) === undefined
          ? undefined
          : { attempts: Math.min(10, Math.max(1, Math.floor(num(form.retryAttempts)!))) },
    }
    // Per-model pre-prompt: persist the trimmed correction; an empty field clears it. Use an empty
    // STRING (not delete) to clear a previously-saved value, since the patch-merge cannot drop a key
    // over the wire — and the runtime treats "" as inert (system-compose.ts). Never write "" for a
    // model that never had one.
    const pre = form.prePrompt.trim()
    if (pre) model.prePrompt = pre
    else if (saved.prePrompt !== undefined) model.prePrompt = ""
    else delete model.prePrompt
    const provider = providerCfg()
    const apiPath = form.apiPath.trim()
    // The endpoint is provider-wide today, so preserve the complete resolved API channel (including
    // its discriminant, package and settings) when a built-in provider had no saved override yet.
    // A fragment containing only `url` does not decode as Provider.Api and would make Save fail.
    const api = apiPath ? { ...(provider.api ?? props.providerApi), url: apiPath } : provider.api
    // The config key is `providers` (plural) — the schema drops a stray `provider`, which silently
    // discarded every save this dialog made (pre-existing bug, fixed 2026-07-24).
    // 🔴 The key rides the PROVIDER, not the model — `providers.<id>.request.body.apiKey` is the one
    // place V2 resolution reads it. `...provider` above already carries any stored key forward, so
    // this only has to express a CHANGE.
    //
    // ⚠️ An empty field CLEARS it, and that is deliberate: this dialog shows the stored key, so what
    // the user sees is what will be saved. (`dialog-new-model` treats empty as "keep" because it is
    // an ADD form with nothing to show.) Written as `""` rather than omitted, because the store
    // patch-merges — omitting a key preserves it, so "delete my key" needs a value to land.
    const request = mergeProviderKey({
      request: (provider as { request?: ProviderRequest }).request,
      stored: storedApiKey(),
      next: form.apiKey.trim(),
    })
    const patch = {
      providers: {
        [props.providerID]: {
          ...provider,
          name: form.providerName.trim() || (provider.name === "local" ? "local" : apiPath || props.providerID),
          ...(api === undefined ? {} : { api }),
          ...(request === undefined ? {} : { request }),
          models: { ...(provider.models ?? {}), [props.modelID]: model },
        },
      },
    }
    try {
      await serverSync().updateConfig(patch)
      // PATCH merges objects: omission alone keeps the old override. Remove only fields this form
      // owns, after the new values have been accepted; a failed deletion keeps the dialog open.
      const base = ["providers", props.providerID, "models", props.modelID]
      await serverSync().removeConfig([
        ...(model.retry === undefined ? [[...base, "retry"]] : []),
        ...[...SAMPLING, "thinkingBudget", "reasoning_effort"]
          .filter((key) => body[key] === undefined)
          .map((key) => [...base, "request", "body", key]),
        ...(["context", "output", "images"] as const)
          .filter((key) => limit[key] === undefined)
          .map((key) => [...base, "limit", key]),
      ])
      showToast({ variant: "success", icon: "circle-check", title: language.t("settings.models.config.toast.saved") })
      dialog.close()
    } catch (error) {
      showToast({
        title: language.t("settings.models.config.toast.failed"),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // The explain node is passed in rather than derived from `field`: a template-literal `.desc.more`
  // key would type-check for every field and render NOTHING for the ones that have no second half
  // — a miss resolves to the fallback, never to the key id (`i18n/resolve.ts`) — and a `?` with
  // nothing behind it is a dead control besides. Opt in per row instead.
  const paramRow = (field: FieldKey, more?: JSX.Element) => (
    <SettingsRowV2
      title={language.t(`settings.models.config.${field}.name`)}
      description={
        <>
          {language.t(`settings.models.config.${field}.desc`)}
          {more}
        </>
      }
    >
      <PresetFieldV2
        field={field}
        value={() => form[field]}
        onValue={(next) => setForm(field, next)}
        ariaLabel={language.t(`settings.models.config.${field}.name`)}
      />
    </SettingsRowV2>
  )

  const modalityRow = (dir: "in" | "out") => (
    <SettingsRowV2
      title={language.t(`settings.models.config.modalities.${dir}.name`)}
      description={language.t(`settings.models.config.modalities.${dir}.desc`)}
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
                onClick={() => setForm(field as never, !form[field] as never)}
              >
                {language.t(`settings.models.config.modality.${m}`)}
              </button>
            )
          }}
        </For>
      </div>
    </SettingsRowV2>
  )

  const section = (
    key: "identity" | "corrections" | "sampling" | "limits" | "reliability" | "capabilities" | "modalities",
  ) => <h3 class="settings-v2-section-title mt-1">{language.t(`settings.models.config.section.${key}`)}</h3>

  return (
    <Dialog size="content">
      <div class="model-config-dialog flex w-[min(34rem,calc(100vw-32px))] max-w-full flex-col gap-4 px-7 py-7">
        <div class="flex flex-col gap-1 text-center">
          <span class="text-[17px] font-semibold text-v2-text-text-base">
            {language.t("settings.models.config.title", { model: props.modelName })}
          </span>
          <span class="text-[13px] font-medium text-v2-text-text-muted">
            {language.t("settings.models.config.description")}
          </span>
        </div>

        <div class="model-config-dialog-scroll -mx-1 flex max-h-[62vh] flex-col gap-4 overflow-y-auto overflow-x-hidden px-1">
          {section("identity")}
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.models.config.providerName.name")}
              description={
                <>
                  {language.t("settings.models.config.providerName.desc")}
                  <SettingsExplainV2 label={language.t("settings.models.config.providerName.name")}>
                    {language.t("settings.models.config.providerName.desc.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <TextInputV2
                class="w-64 max-w-full"
                value={form.providerName}
                onInput={(event) => setForm("providerName", event.currentTarget.value)}
                placeholder={defaultProviderName()}
                aria-label={language.t("settings.models.config.providerName.name")}
              />
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.models.config.apiPath.name")}
              description={
                <>
                  {language.t("settings.models.config.apiPath.desc")}
                  <SettingsExplainV2 label={language.t("settings.models.config.apiPath.name")}>
                    {language.t("settings.models.config.apiPath.desc.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <TextInputV2
                class="w-64 max-w-full"
                value={form.apiPath}
                onInput={(event) => setForm("apiPath", event.currentTarget.value)}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                aria-label={language.t("settings.models.config.apiPath.name")}
              />
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.models.config.apiKey.name")}
              description={
                <>
                  {language.t("settings.models.config.apiKey.desc")}
                  <SettingsExplainV2 label={language.t("settings.models.config.apiKey.name")}>
                    {language.t("settings.models.config.apiKey.desc.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <div class="flex w-full min-w-0 items-center gap-2">
                <TextInputV2
                  class="min-w-0 flex-1"
                  type={revealKey() ? "text" : "password"}
                  value={form.apiKey}
                  onInput={(event) => setForm("apiKey", event.currentTarget.value)}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  aria-label={language.t("settings.models.config.apiKey.name")}
                />
                {/* Masked by DEFAULT and revealed on request: the ask was to see it, and a secret
                    that is legible to anyone glancing at a shared screen is a different promise.
                    An eye rather than a word — the control sits beside the field it acts on, so its
                    meaning is positional, and a text button made the row wrap on narrow dialogs. */}
                <IconButtonV2
                  variant="ghost-muted"
                  size="small"
                  onClick={() => setRevealKey(!revealKey())}
                  icon={<Icon name={revealKey() ? "eye-off" : "eye"} size="normal" />}
                  aria-label={language.t(
                    revealKey() ? "settings.models.config.apiKey.hide" : "settings.models.config.apiKey.reveal",
                  )}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.models.config.modelID.name")}
              description={language.t("settings.models.config.modelID.desc")}
            >
              <TextInputV2
                class="w-64 max-w-full"
                value={form.modelID}
                onInput={(event) => setForm("modelID", event.currentTarget.value)}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                aria-label={language.t("settings.models.config.modelID.name")}
              />
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.models.config.modelName.name")}
              description={language.t("settings.models.config.modelName.desc")}
            >
              <TextInputV2
                class="w-64 max-w-full"
                value={form.modelName}
                onInput={(event) => setForm("modelName", event.currentTarget.value)}
                aria-label={language.t("settings.models.config.modelName.name")}
              />
            </SettingsRowV2>
          </SettingsListV2>

          {section("corrections")}
          <div class="flex flex-col gap-1.5">
            <span class="text-[12px] text-v2-text-text-muted leading-snug">
              {language.t("settings.models.config.prePrompt.desc")}
              <SettingsExplainV2 label={language.t("settings.models.config.prePrompt.name")}>
                {language.t("settings.models.config.prePrompt.desc.more")}
              </SettingsExplainV2>
            </span>
            <TextareaV2
              rows={3}
              value={form.prePrompt}
              onInput={(event) => setForm("prePrompt", event.currentTarget.value)}
              placeholder={language.t("settings.models.config.prePrompt.placeholder")}
              aria-label={language.t("settings.models.config.prePrompt.name")}
            />
          </div>

          {section("sampling")}
          <SettingsListV2>
            <For each={SAMPLING}>{(k) => paramRow(k)}</For>
          </SettingsListV2>

          {section("limits")}
          <SettingsListV2>
            {paramRow("context")}
            {paramRow("maxTokens")}
            {/* Only for a model that declares image input — a picture cap on a text-only model is a
                row the reader has to read and then dismiss. */}
            <Show when={form.inImage}>{paramRow("images")}</Show>
            {paramRow(
              "thinkingBudget",
              <SettingsExplainV2 label={language.t("settings.models.config.thinkingBudget.name")}>
                {language.t("settings.models.config.thinkingBudget.desc.more")}
              </SettingsExplainV2>,
            )}
            {/* Endpoint support varies; the row explains the server-owned effort parameter. */}
            <SettingsRowV2
              title={language.t("settings.models.config.thinkingEffort.name")}
              description={
                <>
                  {language.t("settings.models.config.thinkingEffort.desc")}{" "}
                  <SettingsExplainV2 label={language.t("settings.models.config.thinkingEffort.name")}>
                    {language.t("settings.models.config.thinkingEffort.desc.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <SelectV2
                appearance="inline"
                data-action="settings-model-thinking-effort"
                options={["", ...THINKING_EFFORTS]}
                current={form.thinkingEffort}
                placement="bottom-end"
                gutter={6}
                value={(option) => option}
                label={(option) =>
                  option === ""
                    ? language.t("settings.models.config.thinkingEffort.unset")
                    : language.t(`settings.models.config.thinkingEffort.value.${option}` as never)
                }
                onSelect={(option) => setForm("thinkingEffort", option ?? "")}
              />
            </SettingsRowV2>
          </SettingsListV2>

          {section("reliability")}
          <SettingsListV2>{paramRow("retryAttempts")}</SettingsListV2>

          {section("capabilities")}
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.models.config.tool_call.name")}
              description={
                <>
                  {language.t("settings.models.config.tool_call.desc")}
                  <SettingsExplainV2 label={language.t("settings.models.config.tool_call.name")}>
                    {language.t("settings.models.config.tool_call.desc.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <Switch checked={form.tool_call} onChange={(v) => setForm("tool_call", v)} />
            </SettingsRowV2>
            {/*
              WHICH tool channel this model runs on, and WHO decided. When it is wrong the agent
              silently cannot act and the chat reads as a model refusing — so the decider is named
              here, next to the way to change it. Testing costs three generations, so it is a button
              and never something opening this dialog does.
            */}
            <SettingsRowV2
              title={language.t("settings.models.config.toolChannel.name")}
              description={language.t(`settings.models.config.toolChannel.${channelStatus().channel}`)}
            >
              <div class="flex flex-col items-end gap-1" data-tool-channel={channelStatus().channel}>
                <span class="text-[12px] text-v2-text-text-muted" data-tool-channel-source>
                  {language.t(`settings.models.config.toolChannel.source.${channelStatus().source}`)}
                </span>
                <Show when={channelStatus().rationale}>
                  {(why) => (
                    <span class="text-[11px] leading-4 text-right text-v2-text-text-faint" data-tool-channel-why>
                      {why()}
                    </span>
                  )}
                </Show>
                {/*
                  An override that contradicts a measurement is the most confusing state this screen
                  can be in — "I tested it and it still does the other thing". Both are shown, with
                  the winner named above.
                */}
                <Show when={channelStatus().overriddenMeasurement}>
                  {(over) => (
                    <span class="text-[11px] leading-4 text-right text-v2-text-text-faint" data-tool-channel-override>
                      {language.t("settings.models.config.toolChannel.overridden", { channel: over().channel })}
                    </span>
                  )}
                </Show>
                <Show when={channelStatus().movedFrom}>
                  {(from) => (
                    <span class="text-[11px] leading-4 text-right text-v2-text-text-faint" data-tool-channel-moved>
                      {language.t("settings.models.config.toolChannel.moved", { from: from() })}
                    </span>
                  )}
                </Show>
                <Show when={channelStatus().inconclusive}>
                  {(verdict) => (
                    <span
                      class="text-[11px] leading-4 text-right text-v2-text-text-faint"
                      data-tool-channel-inconclusive
                    >
                      {language.t(`settings.models.config.toolChannel.inconclusive.${verdict()}`)}
                    </span>
                  )}
                </Show>
                <button
                  type="button"
                  data-action="tool-channel-test"
                  class="text-[12px] text-v2-text-text-base underline decoration-dotted hover:text-v2-text-text-base disabled:opacity-50"
                  disabled={testing()}
                  onClick={() => void testChannel()}
                >
                  {language.t(
                    testing()
                      ? "settings.models.config.toolChannel.testing"
                      : "settings.models.config.toolChannel.test",
                  )}
                </button>
                <Show when={testError()}>
                  {(message) => (
                    <span class="text-[11px] leading-4 text-right text-v2-text-text-faint" data-tool-channel-error>
                      {message()}
                    </span>
                  )}
                </Show>
              </div>
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
          <ButtonV2
            size="normal"
            variant="gold"
            disabled={!form.modelID.trim() || !form.modelName.trim()}
            onClick={() => void save()}
          >
            {language.t("common.save")}
          </ButtonV2>
        </div>
      </div>
    </Dialog>
  )
}

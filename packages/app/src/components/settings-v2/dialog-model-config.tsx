import type {
  ConfigV2Model as ModelConfig,
  ConfigV2Provider as ProviderConfig,
  ProviderApi,
} from "@novaclaw/sdk/v2/client"
import { Component, For, type JSX, Show, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { Icon } from "@novaclaw/ui/v2/icon"
import { mergeProviderKey, type ProviderRequest } from "./provider-key"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { TextareaV2 } from "@novaclaw/ui/v2/textarea-v2"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { PresetFieldV2 } from "./parts/preset-field"
import { SAMPLING, type FieldKey, numFromText as num } from "./parts/preset-value"
import { SettingsRowV2 } from "./parts/row"
import { SettingsExplainV2 } from "./explain"
import { DEFAULT_TAXONOMY, TAXONOMIES, type Taxonomy, taxonomyLabel } from "../model-taxonomy"

// Use the HTTP contract directly: obsolete model fields must fail the typecheck, not vanish on Save.
const MODALITIES = ["text", "image", "audio"] as const
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

type DeviceConfig = {
  readonly endpoints: readonly string[]
  readonly concurrency?: number
  /** Cache-affinity window in ms; see ConfigDevice.Info.minRunMs. */
  readonly minRunMs?: number
  readonly locality?: "local" | "lan" | "remote"
}

type ExtendedModelConfig = ModelConfig & {
  prefixCache?: { enabled: boolean; ttlMinutes?: number }
}

const endpointOrigin = (url: string): string | undefined => {
  try {
    return new URL(url).origin.toLowerCase()
  } catch {
    return undefined
  }
}

/** The device row already governing this provider endpoint, if one exists. */
export const deviceForEndpoint = (devices: Readonly<Record<string, DeviceConfig>>, url: string) => {
  const wanted = endpointOrigin(url)
  if (wanted === undefined) return undefined
  for (const id of Object.keys(devices).sort()) {
    const device = devices[id]!
    if (device.endpoints.some((endpoint) => endpointOrigin(endpoint) === wanted)) return { id, device }
  }
  return undefined
}

/** A stable human-legible id for the first Device entry a provider creates. */
export const availableDeviceID = (providerID: string, devices: Readonly<Record<string, DeviceConfig>>) => {
  const stem = `${providerID.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "model"}-device`
  if (devices[stem] === undefined) return stem
  for (let suffix = 2; ; suffix++) if (devices[`${stem}-${suffix}`] === undefined) return `${stem}-${suffix}`
}

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

/**
 * ONE model's configuration, as a full-screen surface — the same shape as the officer's
 * `AgentConfigScreen` (and the file name is the same historical `…-dialog` as that one: it was a
 * pushed dialog until 2026-09-16).
 *
 * ⚠️ It takes the resolved facts as PROPS rather than reaching for `useSDK()`/`useProviders()`: a
 * route page resolves them, and a render harness can supply them directly. That is also why the
 * screen stays mountable outside the SDK/router context.
 */
export const ModelConfigScreen: Component<{
  providerID: string
  modelID: string
  modelName: string
  apiModelID: string
  /** The provider's API channel, when the catalog has one. A missing one is inert: `apiPath` seeds
   *  empty and nothing is written on save. */
  providerApi?: ProviderApi
  defaults?: Pick<ModelConfig, "capabilities">
  /** Leave the screen: back, Cancel, and a successful Save all land here. */
  onDismiss: () => void
}> = (props) => {
  const language = useLanguage()
  const serverSync = useServerSync()

  const providerCfg = (): ProviderConfig => serverSync().data.config?.providers?.[props.providerID] ?? {}
  const savedModel = (): ExtendedModelConfig => (providerCfg().models?.[props.modelID] ?? {}) as ExtendedModelConfig

  const init = savedModel()

  const initialDevices =
    (serverSync().data.config as { devices?: Record<string, DeviceConfig> } | undefined)?.devices ?? {}
  const initialDevice = deviceForEndpoint(initialDevices, providerCfg().api?.url ?? props.providerApi?.url ?? "")

  const d = props.defaults ?? {}
  const nstr = (v: unknown) => (typeof v === "number" ? String(v) : "")
  const optNum = (k: string) => nstr(init.request?.body?.[k])
  const inMod = init.capabilities?.input ?? d.capabilities?.input ?? ["text"]
  const outMod = init.capabilities?.output ?? d.capabilities?.output ?? ["text"]
  const defaultProviderName = () =>
    providerCfg().name === "local" ? "local" : (providerCfg().api?.url ?? props.providerApi?.url ?? props.providerID)
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
    apiPath: providerCfg().api?.url ?? props.providerApi?.url ?? "",
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
    deviceConcurrency: nstr(initialDevice?.device.concurrency),
    // Stored in ms (the scheduler's unit, like `maxToolTimeoutMs`); shown in SECONDS because that is
    // the unit a person thinks in (principle 12c). Blank means "no stickiness", same as 0.
    minRunSeconds:
      initialDevice?.device.minRunMs === undefined ? "" : String(Math.round(initialDevice.device.minRunMs / 1000)),
    // Defaults to Usual: that IS the documented default for an unrated model, and showing the
    // effective rating rather than an empty picker is what principle 12(d) asks for.
    taxonomy: (init.taxonomy ?? "usual") as Taxonomy,
    prefixCacheEnabled: init.prefixCache?.enabled ?? false,
    prefixCacheTtlMinutes: nstr(init.prefixCache?.ttlMinutes),
    tool_call: init.capabilities?.tools ?? d.capabilities?.tools ?? true,
    prePrompt: init.prePrompt ?? "",
    inText: inMod.includes("text"),
    inImage: inMod.includes("image"),
    inAudio: inMod.includes("audio"),
    outText: outMod.includes("text"),
    outImage: outMod.includes("image"),
    outAudio: outMod.includes("audio"),
  })

  /**
   * The Configure dialog is TABBED, the same shape as the officer's settings screen (`AgentConfigScreen`):
   * a horizontal, scrollable rail on phones and a vertical sidebar from `md` up. This dialog was one
   * long scroll where identity, sampling, limits and capabilities ran together, which is what the
   * owner called disorganized; the tabs give each family a home without hiding the whole surface in
   * nested disclosures. `Scheduler` is new here — it exposes the DEVICE's scheduling policy, which is
   * what the model runs on, not the model's own parameters.
   */
  type ConfigTab = "identity" | "sampling" | "capabilities" | "corrections" | "scheduler"
  const [tab, setTab] = createSignal<ConfigTab>("identity")
  const tabs = createMemo(() => [
    { id: "identity" as const, label: language.t("settings.models.config.tab.identity"), icon: "user" as const },
    { id: "sampling" as const, label: language.t("settings.models.config.tab.sampling"), icon: "sliders" as const },
    { id: "capabilities" as const, label: language.t("settings.models.config.tab.capabilities"), icon: "cpu" as const },
    {
      id: "corrections" as const,
      label: language.t("settings.models.config.tab.corrections"),
      icon: "prompt" as const,
    },
    { id: "scheduler" as const, label: language.t("settings.models.config.tab.scheduler"), icon: "share" as const },
  ])

  // 🔴 Make THIS the model a fresh session resolves to when nothing else names one.
  //
  // The instance default is config's `model` key ("Default model to use when no session or agent
  // model is selected"), and a write to it is pushed straight into the live catalog
  // (`config-store-write.ts`: `patch.model` → `catalog.setDefault`) — so this takes effect for the
  // next new session without a restart. Before this button existed the key had no writer anywhere in
  // the UI: `catalog.model.default()` silently fell back to the newest released model in the catalog,
  // which is a fact about upstream release dates, not a choice anybody made.
  const currentDefault = () => serverSync().data.config.model
  // The default names the LOCAL catalog key, not the upstream wire id edited by this form. A clone
  // intentionally has different values for those two; storing the wire id would create a dangling
  // default which silently falls back to another model.
  const defaultRef = () => `${props.providerID}/${props.modelID}`
  const isDefault = () => currentDefault() === defaultRef()

  const makeDefault = async () => {
    try {
      await serverSync().updateConfig({ model: defaultRef() } as never)
      await serverSync().refetchProviders()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.models.config.toast.defaultSet", {
          model: form.modelName.trim() || props.modelName,
        }),
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("settings.models.config.toast.defaultFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      })
    }
  }

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

    // Connection recovery is a kernel policy, not a model tuning knob. Strip legacy per-model
    // attempt counts and the retired capability vocabulary whenever this row is saved, so old config
    // cannot silently retain fields the runtime no longer reads.
    //
    // ⚠️ The loose intersection is deliberate: `ConfigV2.Model` no longer DECLARES `tier`/`benchmark`,
    // so reading them off the typed row would be a compile error even though a stored row may still
    // carry one. A leftover is a second, contradictory rating, and deleting it is not tidiness.
    const {
      retry: _retiredRetry,
      tier: _retiredSizeTier,
      benchmark: _retiredBenchmark,
      ...savedWithoutRetry
    } = saved as ExtendedModelConfig & { tier?: unknown; benchmark?: unknown }
    const prefixCacheTtlMinutes = num(form.prefixCacheTtlMinutes)
    if (prefixCacheTtlMinutes !== undefined && prefixCacheTtlMinutes <= 0) {
      showToast({ variant: "error", title: language.t("settings.models.config.prefixCache.ttl.invalid") })
      return
    }
    const model: ExtendedModelConfig = {
      ...savedWithoutRetry,
      name: form.modelName.trim() || props.modelName,
      api: { ...(saved.api ?? {}), id: form.modelID.trim() || props.apiModelID },
      limit,
      capabilities: { tools: form.tool_call, input, output },
      request: { ...(savedRequest ?? {}), body },
      taxonomy: form.taxonomy,
      prefixCache: {
        enabled: form.prefixCacheEnabled,
        ...(prefixCacheTtlMinutes === undefined ? {} : { ttlMinutes: prefixCacheTtlMinutes }),
      },
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
    const devices = (serverSync().data.config as { devices?: Record<string, DeviceConfig> } | undefined)?.devices ?? {}
    const bound = deviceForEndpoint(devices, providerCfg().api?.url ?? props.providerApi?.url ?? "")
    const concurrency = num(form.deviceConcurrency)
    const minRunSeconds = num(form.minRunSeconds)
    const minRunMs = minRunSeconds === undefined ? undefined : Math.max(0, Math.round(minRunSeconds * 1000))
    // A device row is created on the first scheduling setting, whichever it is. This used to key on
    // `concurrency` alone, so a min-run window with no explicit concurrency was silently dropped.
    const deviceID =
      bound?.id ??
      (concurrency === undefined && minRunMs === undefined ? undefined : availableDeviceID(props.providerID, devices))
    const endpoint = endpointOrigin(apiPath)
    const previousEndpoint = endpointOrigin(providerCfg().api?.url ?? props.providerApi?.url ?? "")
    const devicePatch =
      deviceID === undefined
        ? undefined
        : {
            [deviceID]: {
              ...(bound?.device ?? {}),
              endpoints:
                endpoint === undefined
                  ? (bound?.device.endpoints ?? [])
                  : bound === undefined
                    ? [endpoint]
                    : [
                        ...new Set(
                          bound.device.endpoints.map((item) =>
                            previousEndpoint !== undefined && endpointOrigin(item) === previousEndpoint
                              ? endpoint
                              : item,
                          ),
                        ),
                      ],
              ...(concurrency === undefined ? {} : { concurrency: Math.max(1, Math.floor(concurrency)) }),
              ...(minRunMs === undefined ? {} : { minRunMs }),
            },
          }
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
      ...(devicePatch === undefined ? {} : { devices: devicePatch }),
    }
    try {
      await serverSync().updateConfig(patch as never)
      // PATCH merges objects: omission alone keeps the old override. Remove only fields this form
      // owns, after the new values have been accepted; a failed deletion keeps the dialog open.
      const base = ["providers", props.providerID, "models", props.modelID]
      await serverSync().removeConfig([
        [...base, "retry"],
        // The retired capability vocabulary. Deleting is not tidiness: a leftover `benchmark` or
        // `tier` row is a second, contradictory rating that a later reader could still pick up.
        [...base, "tier"],
        [...base, "benchmark"],
        ...(prefixCacheTtlMinutes === undefined ? [[...base, "prefixCache", "ttlMinutes"]] : []),
        ...(deviceID !== undefined && concurrency === undefined ? [["devices", deviceID, "concurrency"]] : []),
        ...(deviceID !== undefined && minRunMs === undefined ? [["devices", deviceID, "minRunMs"]] : []),
        ...[...SAMPLING, "thinkingBudget", "reasoning_effort"]
          .filter((key) => body[key] === undefined)
          .map((key) => [...base, "request", "body", key]),
        ...(["context", "output", "images"] as const)
          .filter((key) => limit[key] === undefined)
          .map((key) => [...base, "limit", key]),
      ])
      showToast({ variant: "success", icon: "circle-check", title: language.t("settings.models.config.toast.saved") })
      props.onDismiss()
    } catch (error) {
      showToast({
        title: language.t("settings.models.config.toast.failed"),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 🔴 Owner, 2026-09-16: every field's explanation moves behind a `?` circle RIGHT OF THE NAME
  // (uix.md §1.4; AGENTS.md 12d). The inline paragraph used to sit under the title and competed with
  // the control for the same space — and the state a person needs before touching a control is what
  // the control already shows, so the prose was reading cost with no return.
  //
  // ⚠️ The `?` is passed in rather than derived from a `.desc.more` template key: a `.desc.more` key
  // would type-check for every field and render NOTHING for the ones that have no second half — a
  // miss resolves to the fallback, never to the key id (`i18n/resolve.ts`) — and a `?` with nothing
  // behind it is a dead control besides. Opt in per row instead.
  const paramRow = (field: FieldKey, more?: JSX.Element) => (
    <SettingsRowV2
      title={language.t(`settings.models.config.${field}.name`)}
      info={
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
      info={language.t(`settings.models.config.modalities.${dir}.desc`)}
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

  return (
    <div class="flex h-full w-full min-w-0 max-w-full flex-col overflow-hidden bg-v2-background-bg-base text-v2-text-text-base">
      {/* The officer-settings header shape: BACK (this is a place you came from the list), the model's
          identity, then Close. */}
      <div class="flex min-w-0 items-center gap-3 border-b border-v2-border-border-base px-3 py-3 sm:px-4">
        <button
          type="button"
          data-action="model-config-back"
          class="-ml-1 flex size-7 shrink-0 items-center justify-center rounded-md text-v2-text-text-muted hover:bg-v2-background-bg-layer-02"
          aria-label={language.t("agentConfig.back")}
          title={language.t("agentConfig.back")}
          onClick={() => props.onDismiss()}
        >
          <Icon name="chevron-left" size="normal" />
        </button>
        <Icon name="cpu" size="large" class="shrink-0 text-v2-text-text-muted" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-semibold">{props.modelName}</span>
          <span class="block truncate text-xs text-v2-text-text-muted">
            {providerCfg().name ?? props.providerApi?.url ?? props.providerID}
          </span>
        </span>
        <button
          type="button"
          class="shrink-0 text-xs text-v2-text-text-muted hover:underline"
          onClick={() => props.onDismiss()}
        >
          {language.t("common.close")}
        </button>
      </div>

      <div class="min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden md:flex-row">
        {/* Same responsive tab rail as the officer's settings screen (`AgentConfigScreen`): a
              scrollable strip on phones, a sidebar from `md` up. Configure used to be one long scroll
              with identity, sampling, limits and capabilities interleaved, which is what the owner
              called disorganized. */}
        <nav
          class="flex shrink-0 gap-1 overflow-x-auto border-b border-v2-border-border-base pb-2 md:w-48 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r md:pb-0 md:pr-3"
          aria-label={language.t("settings.models.config.title", { model: props.modelName })}
        >
          <For each={tabs()}>
            {(item) => (
              <button
                type="button"
                class={`flex min-h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-left text-[13px] transition-colors ${
                  tab() === item.id
                    ? "bg-v2-background-bg-layer-03 font-medium text-v2-text-text-base shadow-sm"
                    : "text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
                }`}
                aria-current={tab() === item.id ? "page" : undefined}
                onClick={() => setTab(item.id)}
              >
                <Icon name={item.icon} class="hidden size-4 shrink-0 sm:block" />
                <span>{item.label}</span>
              </button>
            )}
          </For>
        </nav>
        {/* Every panel stays MOUNTED and inactive ones are hidden by CSS — the same
              `data-active-tab`/`data-settings-tab` contract the officer settings screen uses, so a
              control is in the DOM (and a render harness can reach it) regardless of the open tab. */}
        <div
          class="model-settings-panels model-config-dialog-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-2 md:px-4"
          data-active-tab={tab()}
        >
          <div class="flex flex-col gap-4">
            <div data-settings-tab="identity">
              <SettingsListV2>
                <SettingsRowV2
                  title={language.t("settings.models.config.providerName.name")}
                  info={
                    <>
                      {language.t("settings.models.config.providerName.desc")}{" "}
                      {language.t("settings.models.config.providerName.desc.more")}
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
                  info={
                    <>
                      {language.t("settings.models.config.apiPath.desc")}{" "}
                      {language.t("settings.models.config.apiPath.desc.more")}
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
                  info={
                    <>
                      {language.t("settings.models.config.apiKey.desc")}{" "}
                      {language.t("settings.models.config.apiKey.desc.more")}
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
                  info={language.t("settings.models.config.modelID.desc")}
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
                  info={language.t("settings.models.config.modelName.desc")}
                >
                  <TextInputV2
                    class="w-64 max-w-full"
                    value={form.modelName}
                    onInput={(event) => setForm("modelName", event.currentTarget.value)}
                    aria-label={language.t("settings.models.config.modelName.name")}
                  />
                </SettingsRowV2>
                {/* 🔴 The rating, and the ONLY one: the retired Terminal-Bench percentage sat here. A
                normal user has no way to know a benchmark number (AGENTS.md principle 12), and the
                classes are the one vocabulary the harness and the person share. Defaults to Usual —
                an unrated model already reads as Usual (`ModelTaxonomy.of`), so the picker says what
                is in force rather than showing an empty control. */}
                <SettingsRowV2
                  title={language.t("settings.models.config.taxonomy.name")}
                  info={
                    <>
                      {language.t("settings.models.config.taxonomy.desc")}{" "}
                      {language.t("settings.models.config.taxonomy.desc.more")}
                    </>
                  }
                >
                  <SelectV2
                    data-action="settings-model-taxonomy"
                    options={TAXONOMIES}
                    current={form.taxonomy}
                    value={(option) => option}
                    label={(option) => taxonomyLabel(language.t, option)}
                    onSelect={(option) => setForm("taxonomy", (option ?? DEFAULT_TAXONOMY) as Taxonomy)}
                  />
                </SettingsRowV2>
              </SettingsListV2>
            </div>

            <div data-settings-tab="corrections">
              <div class="flex flex-col gap-1.5">
                <div class="flex items-center text-[12px] font-medium text-v2-text-text-base">
                  <span>{language.t("settings.models.config.prePrompt.name")}</span>
                  <SettingsExplainV2 label={language.t("settings.models.config.prePrompt.name")}>
                    {language.t("settings.models.config.prePrompt.desc")}{" "}
                    {language.t("settings.models.config.prePrompt.desc.more")}
                  </SettingsExplainV2>
                </div>
                <TextareaV2
                  rows={3}
                  value={form.prePrompt}
                  onInput={(event) => setForm("prePrompt", event.currentTarget.value)}
                  placeholder={language.t("settings.models.config.prePrompt.placeholder")}
                  aria-label={language.t("settings.models.config.prePrompt.name")}
                />
              </div>
            </div>

            <div data-settings-tab="sampling">
              <SettingsListV2>
                <For each={SAMPLING}>{(k) => paramRow(k)}</For>
              </SettingsListV2>
            </div>

            <div data-settings-tab="capabilities">
              <SettingsListV2>
                <SettingsRowV2
                  title={language.t("settings.models.config.tool_call.name")}
                  info={language.t("settings.models.config.tool_call.desc")}
                >
                  <Switch checked={form.tool_call} onChange={(v) => setForm("tool_call", v)} />
                </SettingsRowV2>
                <SettingsRowV2
                  title={language.t("settings.models.config.prefixCache.name")}
                  info={language.t("settings.models.config.prefixCache.desc")}
                >
                  <Switch
                    checked={form.prefixCacheEnabled}
                    onChange={(value) => setForm("prefixCacheEnabled", value)}
                  />
                </SettingsRowV2>
                <Show when={form.prefixCacheEnabled}>
                  <SettingsRowV2
                    title={language.t("settings.models.config.prefixCache.ttl.name")}
                    info={language.t("settings.models.config.prefixCache.ttl.desc")}
                  >
                    <TextInputV2
                      class="w-24 max-w-full"
                      value={form.prefixCacheTtlMinutes}
                      onInput={(event) => setForm("prefixCacheTtlMinutes", event.currentTarget.value)}
                      inputmode="decimal"
                      placeholder="5"
                      aria-label={language.t("settings.models.config.prefixCache.ttl.name")}
                    />
                  </SettingsRowV2>
                </Show>
                {modalityRow("in")}
                {modalityRow("out")}
                {paramRow("context")}
                {paramRow("maxTokens")}
                {/* Only for a model that declares image input — a picture cap on a text-only model is a
                row the reader has to read and then dismiss. */}
                <Show when={form.inImage}>{paramRow("images")}</Show>
                {paramRow("thinkingBudget", <> {language.t("settings.models.config.thinkingBudget.desc.more")}</>)}
                {/* Endpoint support varies; the row explains the server-owned effort parameter. */}
                <SettingsRowV2
                  title={language.t("settings.models.config.thinkingEffort.name")}
                  info={
                    <>
                      {language.t("settings.models.config.thinkingEffort.desc")}{" "}
                      {language.t("settings.models.config.thinkingEffort.desc.more")}
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
            </div>

            <div data-settings-tab="scheduler">
              <SettingsListV2>
                <SettingsRowV2
                  title={language.t("settings.models.config.deviceConcurrency.name")}
                  info={language.t("settings.models.config.deviceConcurrency.desc")}
                >
                  <TextInputV2
                    class="w-24 max-w-full"
                    value={form.deviceConcurrency}
                    onInput={(event) => setForm("deviceConcurrency", event.currentTarget.value)}
                    inputmode="numeric"
                    aria-label={language.t("settings.models.config.deviceConcurrency.name")}
                    placeholder={language.t("settings.models.config.defaultPlaceholder")}
                  />
                </SettingsRowV2>
                <SettingsRowV2
                  title={language.t("settings.models.config.minRun.name")}
                  info={
                    <>
                      {language.t("settings.models.config.minRun.desc")}{" "}
                      {language.t("settings.models.config.minRun.desc.more")}
                    </>
                  }
                >
                  <TextInputV2
                    class="w-24 max-w-full"
                    value={form.minRunSeconds}
                    onInput={(event) => setForm("minRunSeconds", event.currentTarget.value)}
                    inputmode="numeric"
                    aria-label={language.t("settings.models.config.minRun.name")}
                    placeholder={language.t("settings.models.config.defaultPlaceholder")}
                  />
                </SettingsRowV2>
              </SettingsListV2>
              <p class="mt-2 text-[11px] leading-relaxed text-v2-text-text-faint">
                {language.t("settings.models.config.scheduler.note")}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div class="flex items-center justify-end gap-2 border-t border-v2-border-border-base px-4 py-3">
        <ButtonV2 size="normal" variant="ghost-muted" disabled={isDefault()} onClick={() => void makeDefault()}>
          {isDefault()
            ? language.t("settings.models.config.default.isDefault")
            : language.t("settings.models.config.default.make")}
        </ButtonV2>
        <ButtonV2 size="normal" variant="ghost-muted" onClick={() => props.onDismiss()}>
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
  )
}

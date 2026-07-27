import { Popover as Kobalte } from "@kobalte/core/popover"
import { type Accessor, Component, ComponentProps, createMemo, JSX, onMount, Show, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useServer, type ServerConnection } from "@/context/server"
import { providerProbe, type ProbeResult } from "@/utils/fs-api"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { Button } from "@novaclaw/ui/button"
import { IconButton } from "@novaclaw/ui/icon-button"
import { Tag } from "@novaclaw/ui/tag"
import { Dialog } from "@novaclaw/ui/dialog"
import { List } from "@novaclaw/ui/list"
import { Tooltip } from "@novaclaw/ui/tooltip"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"
import { decode64 } from "@/utils/base64"
import { modelCost } from "@/utils/model-catalog"

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "novaclaw" && (!cost || cost.input === 0)

// T3/B15 — one lazy probe per provider:model per app run, shared by every picker instance.
// A successful probe renders the server's HONORED window as a chip (and, server-side, feeds the
// ProbeWindow cache the 1M context pack sizes from); unreachable/model-missing dims the row.
// "auth" does NOT dim: the probe can't see credential-store keys, so an auth failure may be a
// perfectly healthy connected provider.
const [probeCache, setProbeCache] = createStore<Record<string, ProbeResult | "probing">>({})
const probeKey = (providerID: string, modelID: string) => `${providerID}:${modelID}`
const PROBE_CAP = 16

const probeResult = (providerID: string, modelID: string): ProbeResult | undefined => {
  const entry = probeCache[probeKey(providerID, modelID)]
  return typeof entry === "object" ? entry : undefined
}

type ModelState = ReturnType<typeof useLocal>["model"]

// The model-picker "+" opens the Add-models flow (provider preset cards → key → model
// multi-select — settings-v2/dialog-new-model). Without a live server + directory to probe
// against there is nothing a picker dialog could save, so degrade to Settings → Models, which
// resolves its own instance routing robustly (the old DialogSelectProvider fallback is retired
// — provider-import P3).
function openAddModel(
  dialog: ReturnType<typeof useDialog>,
  http: ServerConnection.HttpBase | undefined,
  directory: Accessor<string | undefined>,
) {
  const dir = directory()
  if (http && dir) {
    void import("./settings-v2/dialog-new-model").then((x) => {
      dialog.show(() => <x.DialogNewModel http={http} directory={dir} />)
    })
    return
  }
  void import("./settings-v2").then((x) => {
    dialog.show(() => <x.DialogSettings defaultTab="models" />)
  })
}

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model?: ModelState
}> = (props) => {
  const local = useLocal()
  const server = useServer()
  const model = props.model ?? local.model
  const language = useLanguage()

  const models = createMemo(() =>
    model
      .list()
      .filter((m) => model.visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m) => (props.provider ? m.provider.id === props.provider : true)),
  )

  // Lazy liveness probe on first open per app run (T10 iii rides T3): fire-and-forget, capped,
  // cached at module level so reopening the picker (or the dialog twin) never re-probes.
  onMount(() => {
    const http = server.current?.http
    const dir = decode64(local.slug())
    if (!http || !dir) return
    // Filter BEFORE capping: each open probes the next batch of never-probed models, so a long
    // list fully covers across a few opens instead of stranding everything past the first slice.
    const unprobed = models().filter((m) => probeCache[probeKey(m.provider.id, m.id)] === undefined)
    for (const item of unprobed.slice(0, PROBE_CAP)) {
      const id = probeKey(item.provider.id, item.id)
      setProbeCache(id, "probing")
      void providerProbe(http, { directory: dir, providerID: item.provider.id, modelID: item.id })
        .then((result) => setProbeCache(id, result))
        .catch(() => setProbeCache(id, { status: "error" }))
    }
  })

  return (
    <List
      class={`flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={model.current()}
      // Models-primary (notes/entities.md / todo "no first-class providers"): a FLAT model list —
      // a provider is just where a model is served from, shown as the row's muted suffix, never a
      // grouping header. (The popularProviders group ordering was opencode cloud residue.)
      filterKeys={["provider.name", "name", "id"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      itemWrapper={(item, node) => {
        // The tooltip's context line shows the probed (honored) window when one is known —
        // same reuse of `model.tooltip.context`, no separate key.
        const window = probeResult(item.provider.id, item.id)?.window
        const tooltipModel = window === undefined ? item : { ...item, limit: { ...item.limit, context: window } }
        return (
          <Tooltip
            class="w-full"
            placement="right-start"
            gutter={12}
            openDelay={0}
            value={
              <ModelTooltip model={tooltipModel} latest={item.latest} free={isFree(item.provider.id, modelCost(item))} />
            }
          >
            {node}
          </Tooltip>
        )
      }}
      onSelect={(x) => {
        model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
        props.onSelect()
      }}
    >
      {(i) => {
        const probe = () => probeResult(i.provider.id, i.id)
        const window = () => (probe()?.status === "ok" ? probe()?.window : undefined)
        const stale = () => {
          const status = probe()?.status
          return status === "unreachable" || status === "model-missing"
        }
        return (
          <div class="w-full flex items-center gap-x-2 text-13-regular" classList={{ "opacity-50": stale() }}>
            <span class="truncate">{i.name}</span>
            <Show when={isFree(i.provider.id, modelCost(i))}>
              <Tag>{language.t("model.tag.free")}</Tag>
            </Show>
            <Show when={i.latest}>
              <Tag>{language.t("model.tag.latest")}</Tag>
            </Show>
            <Show when={window()}>{(w) => <Tag>{`${Math.round(w() / 1024)}k`}</Tag>}</Show>
            <span class="ml-auto shrink-0 truncate text-11-regular text-text-weak-base">{i.provider.name}</span>
          </div>
        )
      }}
    </List>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">
type Dismiss = "escape" | "outside" | "select" | "manage" | "provider"

export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelState
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  onClose?: (cause: "escape" | "select") => void
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: Dismiss | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()
  const local = useLocal()
  const server = useServer()
  const directory = () => decode64(local.slug())

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  // "Manage models" is Settings → Models now (owner, 2026-07-27). The old DialogManageModels was a
  // per-provider visibility switchboard from the cloud-catalog era — it grouped by provider, which the
  // models-primary model rejects, and it could do strictly less than the Models tab (which adds, edits,
  // clones, tiers and configures). Two surfaces for one job, one of them worse; this is the good one.
  const handleManage = () => {
    close("manage")
    void import("./settings-v2").then((x) => {
      dialog.show(() => <x.DialogSettings defaultTab="models" />)
    })
  }

  const handleConnectProvider = () => {
    close("provider")
    openAddModel(dialog, server.current?.http, directory)
  }
  /** True when this instance has no models configured at all — see the onOpenChange note below. */
  const noModels = () => (props.model ?? local.model).list().length === 0
  const language = useLanguage()

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        // With nothing configured, the picker can only show an empty list — a dead end one click deep.
        // Go straight to "add a model" instead (owner, 2026-07-27). Deliberately keyed on models
        // CONFIGURED, not models VISIBLE: if models exist but are all hidden, the empty list plus its
        // Manage-models button IS the fix, and hijacking the click would hide it.
        if (next && noModels()) {
          handleConnectProvider()
          return
        }
        if (next) setStore("dismiss", null)
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          class="w-72 h-80 flex flex-col p-2 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none overflow-hidden"
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            model={props.model}
            onSelect={() => close("select")}
            class="p-1"
            action={
              <div class="flex items-center gap-1">
                <Tooltip placement="top" value={language.t("command.provider.connect")}>
                  <IconButton
                    icon="plus-small"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("command.provider.connect")}
                    onClick={handleConnectProvider}
                  />
                </Tooltip>
                <Tooltip placement="top" value={language.t("dialog.model.manage")}>
                  <IconButton
                    icon="sliders"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("dialog.model.manage")}
                    onClick={handleManage}
                  />
                </Tooltip>
              </div>
            }
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export const DialogSelectModel: Component<{ provider?: string; model?: ModelState }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const local = useLocal()
  const server = useServer()
  const directory = () => decode64(local.slug())

  const provider = () => {
    openAddModel(dialog, server.current?.http, directory)
  }

  // The dialog twin of the popover's empty-state redirect: the composer's /model command opens THIS,
  // so it has to behave the same way rather than presenting an empty list. Done on mount (the dialog
  // is already showing by the time it renders) — replace it with the add-model flow instead.
  onMount(() => {
    if ((props.model ?? local.model).list().length > 0) return
    dialog.close()
    openAddModel(dialog, server.current?.http, directory)
  })

  // Same destination as the popover's sliders button — see handleManage above.
  const manage = () => {
    void import("./settings-v2").then((x) => {
      dialog.show(() => <x.DialogSettings defaultTab="models" />)
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={provider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <ModelList provider={props.provider} model={props.model} onSelect={() => dialog.close()} />
      <Button variant="ghost" class="ml-3 mt-5 mb-6 text-text-base self-start" onClick={manage}>
        {language.t("dialog.model.manage")}
      </Button>
    </Dialog>
  )
}

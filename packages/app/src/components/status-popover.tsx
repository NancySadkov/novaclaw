import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@novaclaw/ui/v2/icon"
import { Popover } from "@novaclaw/ui/popover"
import { Suspense, createMemo, createSignal, lazy, Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import { useGlobal } from "@/context/global"
import { STATUS_DOT_CLASS, statusDotTone } from "./status-popover-dot"

const Body = lazy(() => import("./status-popover-body").then((x) => ({ default: x.StatusPopoverBody })))
const ServerBody = lazy(() => import("./status-popover-body").then((x) => ({ default: x.StatusPopoverServerBody })))

export function StatusPopoverV2(props: { scope?: "server" }) {
  if (props.scope === "server") return <ServerStatusPopover />
  return <DirectoryStatusPopover />
}

/**
 * The two facts the directory-scoped status is made of, shared by the popover and by the caller
 * that decides whether to show it at all — one derivation, so the dot and the visibility rule can
 * never disagree about whether anything is wrong.
 */
function useDirectoryStatusFacts() {
  const server = useServerSDK()
  const global = useGlobal()
  const sync = useSync()
  const serverHealth = () => global.servers.health[ServerConnection.key(server().server)]?.healthy
  const mcpIssue = createMemo(() => {
    const mcp = Object.values(sync().data.mcp ?? {})
    const failed = mcp.some((item) => item.status === "failed" || item.status === "needs_client_registration")
    const warn = mcp.some((item) => item.status === "needs_auth")
    if (failed) return "critical" as const
    if (warn) return "warning" as const
  })
  const ready = createMemo(() => serverHealth() === false || sync().data.mcp_ready)
  return { serverHealth, mcpIssue, ready }
}

/**
 * Is there anything worth interrupting someone for?
 *
 * The titlebar used to carry this indicator permanently, and a permanently-green light is
 * furniture: it costs a slot in the one strip a person reads constantly and tells them nothing
 * they did not assume. It earns its place only when the server is down or an MCP server needs
 * attention — which is also the one time its popover has a repair path to offer.
 */
export function useDirectoryStatusAttention() {
  const { serverHealth, mcpIssue } = useDirectoryStatusFacts()
  return createMemo(() => serverHealth() === false || mcpIssue() !== undefined)
}

function DirectoryStatusPopover() {
  const language = useLanguage()
  const [shown, setShown] = createSignal(false)
  const { serverHealth, mcpIssue, ready } = useDirectoryStatusFacts()
  const state = createMemo<StatusPopoverState>(() => ({
    shown: shown(),
    ready: ready(),
    serverHealth: serverHealth(),
    issue: mcpIssue(),
    label: language.t("status.popover.trigger"),
    onOpenChange: setShown,
    body: () => (
      <StatusPopoverBody shown={shown()}>
        <Body shown={shown} />
      </StatusPopoverBody>
    ),
  }))

  return <StatusPopoverView state={state()} />
}

function ServerStatusPopover() {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const [shown, setShown] = createSignal(false)
  const serverHealth = () => global.servers.health[server.key]?.healthy
  const state = createMemo<StatusPopoverState>(() => ({
    shown: shown(),
    ready: serverHealth() !== undefined,
    serverHealth: serverHealth(),
    label: language.t("status.popover.trigger"),
    onOpenChange: setShown,
    body: () => (
      <StatusPopoverBody shown={shown()}>
        <ServerBody />
      </StatusPopoverBody>
    ),
  }))

  return <StatusPopoverView state={state()} />
}

type StatusPopoverState = {
  shown: boolean
  ready: boolean
  serverHealth: boolean | undefined
  issue?: "critical" | "warning"
  label: string
  onOpenChange: (value: boolean) => void
  body: () => JSX.Element
}

function StatusPopoverBody(props: { shown: boolean; children: JSX.Element }) {
  return (
    <Show when={props.shown}>
      <Suspense
        fallback={<div class="w-[360px] h-14 rounded-xl bg-background-strong shadow-[var(--shadow-lg-border-base)]" />}
      >
        {props.children}
      </Suspense>
    </Show>
  )
}

function StatusPopoverView(props: { state: StatusPopoverState }) {
  const tone = () =>
    statusDotTone({ serverHealth: props.state.serverHealth, ready: props.state.ready, issue: props.state.issue })

  const popoverProps = {
    class:
      "[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-xl",
    gutter: 4,
    placement: "bottom-end" as const,
    shift: -168,
  }

  return (
    <Popover
      open={props.state.shown}
      onOpenChange={props.state.onOpenChange}
      triggerAs={IconButtonV2}
      triggerProps={{
        variant: "ghost-muted",
        size: "large",
        class: "!w-9 shrink-0",
        state: props.state.shown ? "pressed" : undefined,
        "aria-label": props.state.label,
      }}
      trigger={
        <div class="relative size-4">
          <IconV2 name={props.state.shown ? "status-active" : "status"} />
          <div
            data-status={tone()}
            class={`absolute rounded-full -top-1 -right-1 size-2 border border-[var(--v2-background-bg-deep)] ${STATUS_DOT_CLASS[tone()]}`}
          />
        </div>
      }
      {...popoverProps}
    >
      {props.state.body()}
    </Popover>
  )
}

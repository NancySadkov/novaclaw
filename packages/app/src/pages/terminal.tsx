import { Navigate } from "@solidjs/router"
import { Tabs } from "@novaclaw/ui/tabs"
import { IconButton } from "@novaclaw/ui/icon-button"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Terminal } from "@/components/terminal"
import { terminalWorkspaceShortcut } from "@/components/terminal-keyboard"
import {
  shouldCloneTerminal,
  terminalConnectFailureMessage,
  type TerminalConnectFailure,
} from "@/components/terminal-connection"
import { RequiresLevel } from "@/context/expertise"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useConfirm } from "@/components/dialog-confirm"
import { SDKProvider } from "@/context/sdk"
import { serverName, useServer } from "@/context/server"
import { TerminalProvider, useTerminal } from "@/context/terminal"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { showToast } from "@/utils/toast"

/** A terminal belongs to the selected NovaClaw instance, not to the renderer machine. Resolve that
 * instance's home as the PTY working directory, then reuse the exact directory-scoped PTY transport
 * used by chat terminals. This keeps remote/P2P operation honest. */
export function TerminalPage() {
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()
  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const selected = conn()
    return selected ? global.ensureServerCtx(selected) : undefined
  })
  const [directory] = createResource(ctx, async (selected) => {
    const known = selected.sync.data.path
    if (known && (known.home || known.directory)) return known.home || known.directory
    const fetched = await selected.sdk.client.path
      .get()
      .then((response) => response.data)
      .catch(() => undefined)
    return fetched?.home || fetched?.directory || ""
  })

  return (
    <RequiresLevel min="advanced" fallback={<Navigate href="/" />}>
      <Show
        when={directory()}
        keyed
        fallback={
          <div class="flex h-full w-full flex-1 self-stretch items-center justify-center text-text-weak">
            {language.t("terminal.loading")}
          </div>
        }
      >
        {(resolved) => (
          <SDKProvider directory={resolved}>
            <TerminalProvider>
              <TerminalWorkspace serverName={conn() ? serverName(conn()!) : "NovaClaw"} />
            </TerminalProvider>
          </SDKProvider>
        )}
      </Show>
    </RequiresLevel>
  )
}

function TerminalWorkspace(props: { serverName: string }) {
  const terminal = useTerminal()
  const language = useLanguage()
  const confirm = useConfirm()
  const [created, setCreated] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)
  const [error, setError] = createSignal<{ id: string; message: string } | undefined>()

  createEffect(() => {
    if (!terminal.ready() || terminal.all().length !== 0 || created()) return
    setCreated(true)
    terminal.new()
  })

  onMount(() => {
    const keydown = (event: KeyboardEvent) => {
      const shortcut = terminalWorkspaceShortcut(event)
      if (!shortcut) return
      event.preventDefault()
      // Capture before Ghostty's hidden textarea can encode the shortcut as terminal input.
      event.stopPropagation()
      if (shortcut === "new") {
        terminal.new()
        return
      }
      if (shortcut === "close") {
        const id = terminal.active()
        if (!id) return
        void terminal.close(id)
        return
      }
      if (shortcut === "next") {
        terminal.next()
        return
      }
      terminal.previous()
    }
    window.addEventListener("keydown", keydown, true)
    onCleanup(() => window.removeEventListener("keydown", keydown, true))
  })

  const active = createMemo(() => terminal.all().find((item) => item.id === terminal.active()))
  const rename = (item: { id: string; title: string }) => {
    const title = window.prompt(language.t("terminal.title"), item.title)?.trim()
    if (title && title !== item.title) terminal.update({ id: item.id, title })
  }
  const connectError = (failure: TerminalConnectFailure, id: string) => {
    const ops = terminal.bind()
    if (shouldCloneTerminal(failure)) {
      void ops.clone(id)
      return
    }
    setError({
      id,
      message: terminalConnectFailureMessage(failure, language.t("terminal.connectionLost.description")),
    })
  }
  const stopAll = async () => {
    const accepted = await confirm({
      title: language.t("terminal.stopAll.title"),
      description: language.t("terminal.stopAll.description", { server: props.serverName }),
      confirmLabel: language.t("terminal.stopAll.action"),
      destructive: true,
    })
    if (!accepted) return
    setStopping(true)
    try {
      const removed = await terminal.stopAll()
      setError(undefined)
      showToast({
        title: language.t("terminal.stopAll.done"),
        description: language.t("terminal.stopAll.doneDescription", { count: removed }),
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("terminal.stopAll.failed"),
        description: String(error),
      })
    } finally {
      setStopping(false)
    }
  }

  return (
    <section
      class="flex h-full min-h-0 w-full min-w-0 flex-1 self-stretch flex-col bg-background-stronger"
      aria-label={language.t("terminal.title")}
    >
      <header class="flex h-14 shrink-0 items-center gap-3 border-b border-border-weaker-base px-4">
        <div class="min-w-0 flex-1">
          <h1 class="text-16-medium text-text-strong">{language.t("terminal.title")}</h1>
          <p class="truncate text-12-regular text-text-weak">{props.serverName}</p>
        </div>
        <ButtonV2 size="small" variant="ghost-muted" disabled={stopping()} onClick={() => void stopAll()}>
          {stopping() ? language.t("terminal.stopAll.stopping") : language.t("terminal.stopAll.action")}
        </ButtonV2>
      </header>
      <Show
        when={terminal.ready()}
        fallback={
          <div class="flex flex-1 items-center justify-center text-text-weak">{language.t("terminal.loading")}</div>
        }
      >
        <Tabs value={terminal.active()} onChange={terminal.open} variant="alt" class="!h-auto !flex-none">
          <Tabs.List class="h-10 border-b border-border-weaker-base">
            <For each={terminal.all()}>
              {(item) => (
                <Tabs.Trigger
                  value={item.id}
                  onDblClick={() => rename(item)}
                  onAuxClick={(event: MouseEvent) => {
                    if (event.button !== 1) return
                    event.preventDefault()
                    void terminal.close(item.id)
                  }}
                  closeButton={
                    <IconButton
                      icon="close"
                      variant="ghost"
                      aria-label={language.t("terminal.close")}
                      onClick={(event) => {
                        event.stopPropagation()
                        void terminal.close(item.id)
                      }}
                    />
                  }
                >
                  {terminalTabLabel({ title: item.title, titleNumber: item.titleNumber, t: language.t })}
                </Tabs.Trigger>
              )}
            </For>
            <div class="flex h-full items-center">
              <IconButton
                icon="plus-small"
                variant="ghost"
                iconSize="large"
                aria-label={language.t("command.terminal.new")}
                onClick={terminal.new}
              />
            </div>
          </Tabs.List>
        </Tabs>
        <div class="relative min-h-0 flex-1">
          <Show
            when={active()}
            keyed
            fallback={
              <button
                type="button"
                class="absolute inset-0 m-auto h-fit w-fit rounded-md bg-surface-raised-base px-4 py-2 text-14-medium text-text-strong"
                onClick={terminal.new}
              >
                {language.t("command.terminal.new")}
              </button>
            }
          >
            {(item) => {
              const ops = terminal.bind()
              return (
                <Show
                  when={error()?.id !== item.id}
                  fallback={
                    <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                      <div class="text-14-medium text-text-strong">{language.t("terminal.connectionLost.title")}</div>
                      <div class="max-w-md text-13-regular text-text-weak">{error()?.message}</div>
                      <button
                        type="button"
                        class="rounded-md bg-surface-raised-base px-3 py-1.5 text-13-medium text-text-strong"
                        onClick={() => setError(undefined)}
                      >
                        {language.t("terminal.connectionLost.retry")}
                      </button>
                    </div>
                  }
                >
                  <div id={`terminal-wrapper-${item.id}`} class="absolute inset-0">
                    <Terminal
                      pty={item}
                      autoFocus
                      onConnect={() => {
                        setError(undefined)
                        ops.trim(item.id)
                      }}
                      onCleanup={ops.update}
                      onConnectError={(failure) => connectError(failure, item.id)}
                    />
                  </div>
                </Show>
              )
            }}
          </Show>
        </div>
      </Show>
    </section>
  )
}

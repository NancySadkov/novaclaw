import { Icon as IconV2 } from "@novaclaw/ui/v2/icon"
import { TabsV2 } from "@novaclaw/ui/v2/tabs-v2"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { Terminal, type TerminalHandle } from "@/components/terminal"
import { terminalWorkspaceShortcut } from "@/components/terminal-keyboard"
import {
  shouldCloneTerminal,
  terminalConnectFailureMessage,
  type TerminalConnectFailure,
} from "@/components/terminal-connection"
import { ExpertiseGate } from "@/components/expertise-gate"
import { RequiresLevel } from "@/context/expertise"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useConfirm } from "@/components/dialog-confirm"
import { SDKProvider } from "@/context/sdk"
import { serverName, useServer } from "@/context/server"
import { TerminalProvider, useTerminal } from "@/context/terminal"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { shellName, terminalTargetLine } from "@/pages/terminal-target"
import { terminalDiagnosis } from "@/pages/terminal-diagnosis"
import { findMatches, stepMatch } from "@/pages/terminal-search"
import { InstallationVersion } from "@novaclaw/core/installation/version"
import { showToast } from "@/utils/toast"
import { resolveInstanceGlobalDirectory } from "@/utils/routing-directory"
import { answeredNothing, createSettledResource } from "@/utils/settled-resource"

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
  // A pty is instance-global; `directory` is only request routing. The read is
  // `utils/routing-directory.ts`, shared verbatim with trash.tsx and registry.tsx.
  const [directory, directoryActions] = createSettledResource(ctx, resolveInstanceGlobalDirectory)

  /**
   * 🔴 **The permanent spinner, and why it needed a type to fix.** This page used to hold the read
   * in a bare `createResource` whose fetcher folded a failed `GET /path` into `""`, and then gated
   * on `<Show when={directory()}>`. `""` is falsy, so the fallback rendered — and the resource had
   * already SETTLED, so nothing would ever re-run it. The screen said *"Loading terminal…"* forever,
   * with no error, no retry and no route out but the titlebar; `TerminalProvider` and `SDKProvider`
   * never mounted, so nothing downstream could report the fault either. A spinner that will never
   * resolve is the same false claim as an empty list, wearing a different animation (ruling 2).
   *
   * Two distinct faults reach the same dead end and both belong here: the read REJECTED
   * (`.failed`), or it answered and the instance has no folder to route to (`answeredNothing`).
   * Neither is "still loading", and the difference between them is not something a person can act
   * on differently, so they share one sentence and one **Try again**.
   */
  const directoryFailed = createMemo(() => directory.failed || answeredNothing(directory))

  return (
    <RequiresLevel
      min="advanced"
      fallback={
        <ExpertiseGate
          glyph="terminal"
          title={language.t("terminal.title")}
          description={language.t("terminal.gate.description")}
        />
      }
    >
      <Switch
        fallback={
          <div class="flex h-full w-full flex-1 self-stretch items-center justify-center text-text-weak">
            {language.t("terminal.loading")}
          </div>
        }
      >
        <Match when={directoryFailed()}>
          <div
            data-slot="terminal-directory-failed"
            class="flex h-full w-full flex-1 flex-col items-center justify-center gap-3 self-stretch px-6 text-center"
          >
            <div class="text-sm font-semibold text-v2-text-text-base">{language.t("terminal.unavailable.title")}</div>
            <div class="max-w-md text-[13px] text-v2-text-text-muted">
              {language.t("terminal.unavailable.description")}
            </div>
            <ButtonV2 size="small" variant="ghost-muted" onClick={() => void directoryActions.refetch()}>
              {language.t("terminal.unavailable.retry")}
            </ButtonV2>
          </div>
        </Match>
        <Match when={directory()} keyed>
          {(resolved) => (
            <SDKProvider directory={resolved}>
              <TerminalProvider>
                <TerminalWorkspace serverName={conn() ? serverName(conn()!) : "NovaClaw"} />
              </TerminalProvider>
            </SDKProvider>
          )}
        </Match>
      </Switch>
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
      if (shortcut === "find") {
        setFinding(true)
        return
      }
      if (shortcut === "next") {
        terminal.next()
        return
      }
      if (shortcut === "move-next" || shortcut === "move-previous") {
        const id = terminal.active()
        if (!id) return
        const all = terminal.all()
        const from = all.findIndex((item) => item.id === id)
        if (from === -1) return
        // Clamped rather than wrapping: dragging past the end drops at the end, so the keyboard
        // equivalent must too, or the two affordances disagree about what "move right" means.
        const to = Math.min(all.length - 1, Math.max(0, from + (shortcut === "move-next" ? 1 : -1)))
        if (to !== from) terminal.move(id, to)
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
      void ops.clone(id, { confirmedGone: true })
      return
    }
    ops.disconnected(id)
    setError({
      id,
      message: terminalConnectFailureMessage(failure, language.t("terminal.connectionLost.description")),
    })
  }
  // One handle per live tab, withdrawn by the component itself on teardown (see TerminalHandle) — so
  // an action can never fire into a terminal that has already gone.
  const handles = new Map<string, TerminalHandle>()
  const [menu, setMenu] = createSignal<{ id: string; x: number; y: number } | undefined>()
  const [finding, setFinding] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [matchCount, setMatchCount] = createSignal(0)
  const [matchIndex, setMatchIndex] = createSignal<number | undefined>()

  const runSearch = (direction: "next" | "previous") => {
    const id = terminal.active()
    const handle = id ? handles.get(id) : undefined
    if (!handle) return
    // Lines are re-read per step rather than cached: a live shell appends while the bar is open, and
    // searching a stale snapshot would step to coordinates the buffer no longer has.
    const matches = findMatches(handle.readLines(), query())
    setMatchCount(matches.length)
    const next = stepMatch(matches.length, matchIndex(), direction)
    if (next < 0) {
      setMatchIndex(undefined)
      return
    }
    setMatchIndex(next)
    const match = matches[next]
    if (match) handle.reveal(match)
  }

  const closeFind = () => {
    for (const handle of handles.values()) handle.clearReveal()
    setFinding(false)
    setQuery("")
    setMatchCount(0)
    setMatchIndex(undefined)
  }
  const [dragging, setDragging] = createSignal<string | undefined>()
  const [copied, setCopied] = createSignal<string | undefined>()
  const copyDiagnosis = async (item: {
    id: string
    ptyID?: string
    shell?: string
    cwd?: string
    exitCode?: number
  }) => {
    const text = terminalDiagnosis({
      // The same words the panel is showing, so a forwarded copy cannot describe a different fault
      // from the one the user was looking at.
      headline:
        item.exitCode === undefined ? language.t("terminal.connectionLost.title") : language.t("terminal.exited.title"),
      server: props.serverName,
      detail:
        item.exitCode === undefined
          ? (error()?.message ?? language.t("terminal.connectionLost.description"))
          : language.t("terminal.exited.description", { code: item.exitCode }),
      ptyID: item.ptyID ?? "not-created",
      shell: shellName(item.shell),
      cwd: item.cwd,
      version: InstallationVersion,
    })
    // The banner is model-free by requirement, and so is this: plain clipboard, no round-trip. If the
    // clipboard is unavailable the label simply does not change — a failed copy must not throw a
    // stack trace onto the one screen a user reaches when things are already broken.
    await navigator.clipboard?.writeText?.(text).then(
      () => {
        setCopied(item.id)
        setTimeout(() => setCopied(undefined), 2_000)
      },
      () => undefined,
    )
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
      <Show when={finding()}>
        <div class="flex shrink-0 items-center gap-2 border-b border-border-weaker-base px-4 py-2">
          <input
            type="text"
            autofocus
            aria-label={language.t("terminal.find.label")}
            placeholder={language.t("terminal.find.label")}
            class="min-w-0 flex-1 rounded-md bg-surface-raised-base px-2 py-1 text-13-regular text-text-strong outline-none"
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              // A fresh query restarts the walk; keeping the old index would step from a position
              // that belongs to a different set of matches.
              setMatchIndex(undefined)
              setMatchCount(
                findMatches(handles.get(terminal.active() ?? "")?.readLines() ?? [], event.currentTarget.value).length,
              )
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                closeFind()
                return
              }
              if (event.key !== "Enter") return
              event.preventDefault()
              runSearch(event.shiftKey ? "previous" : "next")
            }}
          />
          <span class="shrink-0 text-12-regular text-text-weak">
            {/* Stated rather than implied: "no matches" and "not searched yet" look identical on a
                bar that only highlights, and the difference is the whole answer to "is it there?" */}
            {query() === ""
              ? ""
              : matchCount() === 0
                ? language.t("terminal.find.none")
                : language.t("terminal.find.count", { index: (matchIndex() ?? 0) + 1, total: matchCount() })}
          </span>
          <IconButtonV2
            icon={<IconV2 name="close" />}
            variant="ghost-muted"
            aria-label={language.t("terminal.find.close")}
            onClick={closeFind}
          />
        </div>
      </Show>
      <header class="flex h-14 shrink-0 items-center gap-3 border-b border-border-weaker-base px-4">
        <div class="min-w-0 flex-1">
          <h1 class="text-16-medium text-text-strong">{language.t("terminal.title")}</h1>
          <p class="truncate text-12-regular text-text-weak">
            {terminalTargetLine({ server: props.serverName, shell: active()?.shell, cwd: active()?.cwd })}
          </p>
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
        {/* v2 design system. ⚠️ Deliberately NOT v1's `variant="alt"`: porting that variant's CSS
            across would settle a brand question by copying the v1 app, which AGENTS.md forbids —
            `visual.md` is the spec and v2's own variants are its expression. The tab strip keeps its
            layout classes and takes v2's default. */}
        <TabsV2 value={terminal.active()} onChange={terminal.open} class="!h-auto !flex-none">
          <TabsV2.List class="h-10 border-b border-border-weaker-base">
            <For each={terminal.all()}>
              {(item) => (
                <TabsV2.Trigger
                  value={item.id}
                  onDblClick={() => rename(item)}
                  // v2 owns middle-click, so the hand-rolled onAuxClick guard this file used to
                  // carry is gone rather than duplicated.
                  onMiddleClick={() => void terminal.close(item.id)}
                  // Drag-reorder rides `rest` straight through TabsV2.Trigger onto the button, so
                  // there is no fork of the design-system component to add it (ruling 13). The
                  // reducer already existed; only the gesture was missing.
                  draggable={true}
                  onDragStart={(event: DragEvent) => {
                    setDragging(item.id)
                    // `move` is required or Firefox refuses to start the drag at all.
                    event.dataTransfer?.setData("text/plain", item.id)
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
                  }}
                  onDragEnd={() => setDragging(undefined)}
                  onDragOver={(event: DragEvent) => {
                    if (!dragging() || dragging() === item.id) return
                    // Without preventDefault the browser treats this as a non-drop target and the
                    // cursor says "no" over every tab.
                    event.preventDefault()
                    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
                  }}
                  onDrop={(event: DragEvent) => {
                    event.preventDefault()
                    const source = dragging() ?? event.dataTransfer?.getData("text/plain")
                    setDragging(undefined)
                    if (!source || source === item.id) return
                    const to = terminal.all().findIndex((entry) => entry.id === item.id)
                    if (to !== -1) terminal.move(source, to)
                  }}
                  closeButton={
                    <IconButtonV2
                      icon={<IconV2 name="close" />}
                      variant="ghost-muted"
                      aria-label={language.t("terminal.close")}
                      onClick={(event) => {
                        event.stopPropagation()
                        void terminal.close(item.id)
                      }}
                    />
                  }
                >
                  {terminalTabLabel({ title: item.title, titleNumber: item.titleNumber, t: language.t })}
                </TabsV2.Trigger>
              )}
            </For>
            <div class="flex h-full items-center">
              <IconButtonV2
                icon={<IconV2 name="plus-small" />}
                variant="ghost-muted"
                aria-label={language.t("command.terminal.new")}
                onClick={terminal.new}
              />
            </div>
          </TabsV2.List>
        </TabsV2>
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
                  when={error()?.id !== item.id && item.status === "running" && item.ptyID !== undefined}
                  fallback={
                    <Show
                      when={item.status !== "starting"}
                      fallback={
                        <div class="absolute inset-0 flex items-center justify-center text-13-regular text-text-weak">
                          {language.t("terminal.loading")}
                        </div>
                      }
                    >
                      <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                        <div class="text-14-medium text-text-strong">
                          {item.status === "exited"
                            ? language.t("terminal.exited.title")
                            : language.t("terminal.connectionLost.title")}
                        </div>
                        <div class="max-w-md text-13-regular text-text-weak">
                          {item.status === "exited"
                            ? language.t("terminal.exited.description", { code: item.exitCode ?? "unknown" })
                            : (error()?.message ?? language.t("terminal.connectionLost.description"))}
                        </div>
                        {/* T3: every action here is MODEL-FREE by requirement — this banner is what a
                          user meets when the instance is already unwell, so nothing on it may depend
                          on a working agent, provider or network round-trip beyond the one being
                          retried. Retry/New shell differ by cause; Copy details and Stop are shared. */}
                        <div class="flex items-center gap-2">
                          <button
                            type="button"
                            class="rounded-md bg-surface-raised-base px-3 py-1.5 text-13-medium text-text-strong"
                            onClick={() => {
                              if (item.status === "exited" || item.ptyID === undefined) {
                                void ops.clone(item.id)
                                return
                              }
                              setError(undefined)
                              ops.retry(item.id)
                            }}
                          >
                            {item.status !== "exited" && item.ptyID !== undefined
                              ? language.t("terminal.connectionLost.retry")
                              : language.t("terminal.exited.newShell")}
                          </button>
                          <Show when={item.status === "disconnected" && item.ptyID !== undefined}>
                            <button
                              type="button"
                              class="rounded-md px-3 py-1.5 text-13-medium text-text-weak"
                              onClick={() => void ops.clone(item.id)}
                            >
                              {language.t("terminal.exited.newShell")}
                            </button>
                          </Show>
                          <button
                            type="button"
                            class="rounded-md px-3 py-1.5 text-13-medium text-text-weak"
                            onClick={() => void copyDiagnosis(item)}
                          >
                            {copied() === item.id
                              ? language.t("terminal.connectionLost.copied")
                              : language.t("terminal.connectionLost.copy")}
                          </button>
                          <button
                            type="button"
                            class="rounded-md px-3 py-1.5 text-13-medium text-text-weak"
                            onClick={() => void terminal.close(item.id)}
                          >
                            {language.t("terminal.close")}
                          </button>
                        </div>
                      </div>
                    </Show>
                  }
                >
                  <div
                    id={`terminal-wrapper-${item.id}`}
                    class="absolute inset-0"
                    onContextMenu={(event) => {
                      // Right-click opens OUR menu rather than the browser's, because the browser's
                      // offers Back/Reload/View source — none of which mean anything over a shell,
                      // and one of which throws away the session.
                      event.preventDefault()
                      setMenu({ id: item.id, x: event.clientX, y: event.clientY })
                    }}
                  >
                    <Terminal
                      pty={item}
                      autoFocus
                      onConnect={() => {
                        setError(undefined)
                        ops.connected(item.id)
                        ops.trim(item.id)
                      }}
                      onCleanup={(update) => ops.update(update)}
                      onConnectError={(failure) => connectError(failure, item.id)}
                      onHandle={(handle) => {
                        if (handle) handles.set(item.id, handle)
                        else handles.delete(item.id)
                      }}
                    />
                  </div>
                </Show>
              )
            }}
          </Show>
        </div>
      </Show>
      <Show when={menu()}>
        {(open) => (
          <>
            {/* A full-surface backdrop so the next click anywhere dismisses — including a click that
                lands on the terminal, which would otherwise both close the menu and be typed into
                the shell. */}
            <div
              class="fixed inset-0 z-40"
              onClick={() => setMenu(undefined)}
              onContextMenu={() => setMenu(undefined)}
            />
            <div
              role="menu"
              aria-label={language.t("terminal.title")}
              class="fixed z-50 min-w-40 rounded-md border border-border-weaker-base bg-surface-raised-base py-1 shadow-lg"
              style={{ left: `${Math.min(open().x, window.innerWidth - 176)}px`, top: `${open().y}px` }}
            >
              <button
                type="button"
                role="menuitem"
                class="block w-full px-3 py-1.5 text-left text-13-regular text-text-strong hover:bg-surface-hover-base"
                onClick={() => {
                  setFinding(true)
                  setMenu(undefined)
                }}
              >
                {language.t("terminal.find.label")}
              </button>
              <button
                type="button"
                role="menuitem"
                class="block w-full px-3 py-1.5 text-left text-13-regular text-text-strong hover:bg-surface-hover-base"
                onClick={() => {
                  handles.get(open().id)?.clear()
                  setMenu(undefined)
                }}
              >
                {language.t("terminal.clear")}
              </button>
              <button
                type="button"
                role="menuitem"
                class="block w-full px-3 py-1.5 text-left text-13-regular text-text-strong hover:bg-surface-hover-base"
                onClick={() => {
                  void terminal.close(open().id)
                  setMenu(undefined)
                }}
              >
                {language.t("terminal.close")}
              </button>
            </div>
          </>
        )}
      </Show>
    </section>
  )
}

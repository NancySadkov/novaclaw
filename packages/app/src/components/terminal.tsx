import { withAlpha } from "@novaclaw/ui/theme/color"
import { UnsupportedRequestError } from "@novaclaw/sdk/v2/client"
import { useTheme } from "@novaclaw/ui/theme/context"
import { resolveThemeVariant } from "@novaclaw/ui/theme/resolve"
import type { HexColor } from "@novaclaw/ui/theme/types"
import { showToast } from "@/utils/toast"
import type { FitAddon, Ghostty, Terminal as Term } from "ghostty-web"
import {
  type ComponentProps,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  splitProps,
} from "solid-js"
import { SerializeAddon } from "@/addons/serialize"
import { matchKeybind, parseKeybind } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { terminalFontFamily, useSettings } from "@/context/settings"
import type { LocalPTY } from "@/context/terminal"
import { disposeIfDisposable, getHoveredLinkText, setOptionIfSupported } from "@/utils/runtime-adapters"
import { terminalWriter } from "@/utils/terminal-writer"
import { terminalWebSocketURL } from "@/utils/terminal-websocket-url"
import { terminalPresenceFromStatus, type TerminalConnectFailure } from "./terminal-connection"
import { restartTerminalCursorBlink, terminalClipboardShortcut } from "./terminal-keyboard"
import { terminalRevealPosition } from "./terminal-reveal"

const TOGGLE_TERMINAL_ID = "terminal.toggle"
const DEFAULT_TOGGLE_TERMINAL_KEYBIND = "ctrl+`"
/** What a CALLER may do to a live terminal.
 *
 * ⚠️ Deliberately narrow, and it is not an oversight that the ghostty `Terminal` is not handed over.
 * Every method here is one the product needs by name; exposing the renderer itself would spread
 * ghostty's API across the app and make the engine a thing we can no longer swap. Add a method when a
 * feature needs one, not in anticipation. */
export interface TerminalHandle {
  /** Wipe the screen AND the scrollback — what a terminal's "Clear" has always meant. Local to the
   * renderer: it deliberately does not send anything to the shell, so it cannot disturb a running
   * job or land a stray line in the user's shell history. */
  clear: () => void
  /** Every buffer line as text, scrollback THROUGH the active screen. Read on demand rather than
   * cached: a live shell appends while a find bar is open, and a cached snapshot would search a
   * buffer the user is no longer looking at. */
  readLines: () => string[]
  /** Highlight a match and scroll it into view. Input rows are absolute `readLines` coordinates; the
   * renderer owns conversion to Ghostty's bottom-relative scroll and viewport-relative highlight. */
  reveal: (match: { row: number; column: number; length: number }) => void
  /** Remove Search's highlight without disturbing a selection the user made in the terminal. */
  clearReveal: () => void
}

export interface TerminalProps extends ComponentProps<"div"> {
  pty: LocalPTY
  autoFocus?: boolean
  onSubmit?: () => void
  onCleanup?: (pty: Partial<LocalPTY> & { id: string }) => void
  onConnect?: () => void
  onConnectError?: (failure: TerminalConnectFailure) => void
  /** Called once the renderer exists, and again with `undefined` when it goes away — so a caller
   * holding the handle cannot keep a disposed terminal alive or call into it after teardown. */
  onHandle?: (handle: TerminalHandle | undefined) => void
}

let shared: Promise<{ mod: typeof import("ghostty-web"); ghostty: Ghostty }> | undefined

const loadGhostty = () => {
  if (shared) return shared
  shared = import("ghostty-web")
    .then(async (mod) => ({ mod, ghostty: await mod.Ghostty.load() }))
    .catch((err) => {
      shared = undefined
      throw err
    })
  return shared
}

type TerminalColors = {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

const DEFAULT_TERMINAL_COLORS: Record<"light" | "dark", TerminalColors> = {
  light: {
    background: "#fcfcfc",
    foreground: "#211e1e",
    cursor: "#211e1e",
    selectionBackground: withAlpha("#211e1e", 0.2),
  },
  dark: {
    background: "#191515",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: withAlpha("#d4d4d4", 0.25),
  },
}

const debugTerminal = (...values: unknown[]) => {
  if (!import.meta.env.DEV) return
  console.debug("[terminal]", ...values)
}

const useTerminalUiBindings = (input: {
  container: HTMLDivElement
  term: Term
  cleanups: VoidFunction[]
  handlePointerDown: () => void
  handleLinkClick: (event: MouseEvent) => void
}) => {
  const handleCopy = (event: ClipboardEvent) => {
    const selection = input.term.getSelection()
    if (!selection) return

    const clipboard = event.clipboardData
    if (!clipboard) return

    event.preventDefault()
    clipboard.setData("text/plain", selection)
  }

  const handlePaste = (event: ClipboardEvent) => {
    const clipboard = event.clipboardData
    const text = clipboard?.getData("text/plain") ?? clipboard?.getData("text") ?? ""
    if (!text) return

    event.preventDefault()
    event.stopPropagation()
    input.term.paste(text)
  }

  const handleTextareaFocus = () => {
    restartTerminalCursorBlink(input.term.options)
  }
  const handleTextareaBlur = () => {
    input.term.options.cursorBlink = false
  }

  input.container.addEventListener("copy", handleCopy, true)
  input.cleanups.push(() => input.container.removeEventListener("copy", handleCopy, true))

  input.container.addEventListener("paste", handlePaste, true)
  input.cleanups.push(() => input.container.removeEventListener("paste", handlePaste, true))

  input.container.addEventListener("pointerdown", input.handlePointerDown)
  input.cleanups.push(() => input.container.removeEventListener("pointerdown", input.handlePointerDown))

  input.container.addEventListener("click", input.handleLinkClick, {
    capture: true,
  })
  input.cleanups.push(() =>
    input.container.removeEventListener("click", input.handleLinkClick, {
      capture: true,
    }),
  )

  input.term.textarea?.addEventListener("focus", handleTextareaFocus)
  input.term.textarea?.addEventListener("blur", handleTextareaBlur)
  input.cleanups.push(() => input.term.textarea?.removeEventListener("focus", handleTextareaFocus))
  input.cleanups.push(() => input.term.textarea?.removeEventListener("blur", handleTextareaBlur))
}

const persistTerminal = (input: {
  term: Term | undefined
  addon: SerializeAddon | undefined
  cursor: number
  id: string
  onCleanup?: (pty: Partial<LocalPTY> & { id: string }) => void
}) => {
  if (!input.addon || !input.onCleanup || !input.term) return
  const buffer = (() => {
    try {
      return input.addon.serialize()
    } catch {
      debugTerminal("failed to serialize terminal buffer")
      return ""
    }
  })()

  input.onCleanup({
    id: input.id,
    buffer,
    cursor: input.cursor,
    rows: input.term.rows,
    cols: input.term.cols,
    scrollY: input.term.getViewportY(),
  })
}

export const Terminal = (props: TerminalProps) => {
  const platform = usePlatform()
  const sdk = useSDK()
  const settings = useSettings()
  const theme = useTheme()
  const language = useLanguage()
  // Terminal captures its connection for the PTY lifetime, so callers must key it per server/session.
  const connection = useServerSDK()().server
  const directory = sdk().directory
  const client = sdk().client
  const url = sdk().url
  const auth = connection.http
  const username = auth?.username ?? "novaclaw"
  const password = auth?.password ?? ""
  const authToken = connection.type === "http" ? connection.authToken : false
  const sameOrigin = new URL(url, location.href).origin === location.origin
  let container!: HTMLDivElement
  const [revealHighlight, setRevealHighlight] = createSignal<{
    left: number
    top: number
    width: number
    height: number
  }>()
  const [local, others] = splitProps(props, [
    "pty",
    "class",
    "classList",
    "autoFocus",
    "onConnect",
    "onConnectError",
    "onHandle",
  ])
  const ptyLocation = { directory, workspace: local.pty.workspaceID }
  const clientID = local.pty.id
  const id = local.pty.ptyID
  if (!id) throw new Error("A terminal renderer requires a server PTY id")
  const restore = typeof local.pty.buffer === "string" ? local.pty.buffer : ""
  const restoreSize =
    restore &&
    typeof local.pty.cols === "number" &&
    Number.isSafeInteger(local.pty.cols) &&
    local.pty.cols > 0 &&
    typeof local.pty.rows === "number" &&
    Number.isSafeInteger(local.pty.rows) &&
    local.pty.rows > 0
      ? { cols: local.pty.cols, rows: local.pty.rows }
      : undefined
  const scrollY = typeof local.pty.scrollY === "number" ? local.pty.scrollY : undefined
  let ws: WebSocket | undefined
  let term: Term | undefined
  let _ghostty: Ghostty
  let serializeAddon: SerializeAddon
  let fitAddon: FitAddon
  let handleResize: () => void
  let fitFrame: number | undefined
  let sizeTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSize: { cols: number; rows: number } | undefined
  let lastSize: { cols: number; rows: number } | undefined
  let disposed = false
  const cleanups: VoidFunction[] = []
  const start =
    typeof local.pty.cursor === "number" && Number.isSafeInteger(local.pty.cursor) ? local.pty.cursor : undefined
  let cursor = start ?? 0
  let seek = start !== undefined ? start : restore ? -1 : 0
  let output: ReturnType<typeof terminalWriter> | undefined
  let drop: VoidFunction | undefined
  let reconn: ReturnType<typeof setTimeout> | undefined
  let tries = 0

  const cleanup = () => {
    if (!cleanups.length) return
    const fns = cleanups.splice(0).reverse()
    for (const fn of fns) {
      try {
        fn()
      } catch (err) {
        debugTerminal("cleanup failed", err)
      }
    }
  }

  const pushSize = (cols: number, rows: number) => {
    return client.v2.pty
      .update({
        ptyID: id,
        location: ptyLocation,
        size: { cols, rows },
      })
      .catch((err) => {
        debugTerminal("failed to sync terminal size", err)
      })
  }

  const getTerminalColors = (): TerminalColors => {
    const mode = theme.mode() === "dark" ? "dark" : "light"
    const fallback = DEFAULT_TERMINAL_COLORS[mode]
    const currentTheme = theme.themes()[theme.themeId()]
    if (!currentTheme) return fallback
    const variant = mode === "dark" ? currentTheme.dark : currentTheme.light
    if (!variant?.seeds && !variant?.palette) return fallback
    const resolved = resolveThemeVariant(variant, mode === "dark")
    const text = resolved["text-stronger"] ?? fallback.foreground
    const background = resolved["background-stronger"] ?? fallback.background
    const alpha = mode === "dark" ? 0.25 : 0.2
    const base = text.startsWith("#") ? (text as HexColor) : (fallback.foreground as HexColor)
    const selectionBackground = withAlpha(base, alpha)
    return {
      background,
      foreground: text,
      cursor: text,
      selectionBackground,
    }
  }

  const terminalColors = createMemo(getTerminalColors)

  const scheduleFit = () => {
    if (disposed) return
    if (!fitAddon) return
    if (fitFrame !== undefined) return

    fitFrame = requestAnimationFrame(() => {
      fitFrame = undefined
      if (disposed) return
      fitAddon.fit()
    })
  }

  const scheduleSize = (cols: number, rows: number) => {
    if (disposed) return
    if (lastSize?.cols === cols && lastSize?.rows === rows) return

    pendingSize = { cols, rows }

    if (!lastSize) {
      lastSize = pendingSize
      void pushSize(cols, rows)
      return
    }

    if (sizeTimer !== undefined) return
    sizeTimer = setTimeout(() => {
      sizeTimer = undefined
      const next = pendingSize
      if (!next) return
      pendingSize = undefined
      if (disposed) return
      if (lastSize?.cols === next.cols && lastSize?.rows === next.rows) return
      lastSize = next
      void pushSize(next.cols, next.rows)
    }, 100)
  }

  createEffect(() => {
    const colors = terminalColors()
    if (!term) return
    setOptionIfSupported(term, "theme", colors)
  })

  createEffect(() => {
    const font = terminalFontFamily(settings.appearance.terminalFont())
    if (!term) return
    setOptionIfSupported(term, "fontFamily", font)
    scheduleFit()
  })

  let zoom = platform.webviewZoom?.()
  createEffect(() => {
    const next = platform.webviewZoom?.()
    if (next === undefined) return
    if (next === zoom) return
    zoom = next
    scheduleFit()
  })

  const focusTerminal = () => {
    const t = term
    if (!t) return
    t.focus()
    t.textarea?.focus()
    setTimeout(() => t.textarea?.focus(), 0)
  }
  const handlePointerDown = () => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && activeElement !== container && !container.contains(activeElement)) {
      activeElement.blur()
    }
    focusTerminal()
  }

  const handleLinkClick = (event: MouseEvent) => {
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return
    if (event.altKey) return
    if (event.button !== 0) return

    const t = term
    if (!t) return

    const text = getHoveredLinkText(t)
    if (!text) return

    event.preventDefault()
    event.stopImmediatePropagation()
    platform.openLink(text)
  }

  onMount(() => {
    const run = async () => {
      const loaded = await loadGhostty()
      if (disposed) return

      const mod = loaded.mod
      const g = loaded.ghostty

      const t = new mod.Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        cols: restoreSize?.cols,
        rows: restoreSize?.rows,
        fontSize: 14,
        fontFamily: terminalFontFamily(settings.appearance.terminalFont()),
        allowTransparency: false,
        convertEol: false,
        theme: terminalColors(),
        scrollback: 10_000,
        ghostty: g,
      })
      cleanups.push(() => t.dispose())
      if (disposed) {
        cleanup()
        return
      }
      // Handed out AFTER the disposed check, and withdrawn in the same cleanup that disposes the
      // renderer, so the page can never hold a handle onto a terminal that is already gone.
      local.onHandle?.({
        clear: () => t.clear(),
        readLines: () => {
          // `buffer.active`, NOT `getScrollbackLine()`. The latter is history only, by its own doc
          // comment, so a search built on it cannot find what is on screen — which is the most likely
          // thing anyone is searching for.
          const buffer = t.buffer.active
          const lines: string[] = []
          for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? "")
          return lines
        },
        reveal: (match) => {
          const position = terminalRevealPosition(match.row, t.buffer.active.length, t.rows)
          t.scrollToLine(position.viewportY)
          // ghostty-web 0.4.0's `select(column, viewportRow, length)` translates viewport rows in
          // the opposite direction from its own renderer. Keep Search's highlight product-owned:
          // that makes the exact match visible without corrupting the user's copy selection.
          const canvas = container.querySelector("canvas")
          if (!(canvas instanceof HTMLCanvasElement) || t.cols < 1 || t.rows < 1) return
          const root = container.getBoundingClientRect()
          const surface = canvas.getBoundingClientRect()
          const cellWidth = surface.width / t.cols
          const cellHeight = surface.height / t.rows
          setRevealHighlight({
            left: surface.left - root.left + match.column * cellWidth,
            top: surface.top - root.top + position.viewportRow * cellHeight,
            width: Math.max(cellWidth, match.length * cellWidth),
            height: cellHeight,
          })
        },
        clearReveal: () => setRevealHighlight(undefined),
      })
      cleanups.push(() => local.onHandle?.(undefined))
      _ghostty = g
      term = t
      output = terminalWriter((data, done) =>
        t.write(data, () => {
          done?.()
        }),
      )

      t.attachCustomKeyEventHandler((event) => {
        const clipboardShortcut = terminalClipboardShortcut(event)
        if (clipboardShortcut === "copy") {
          const selection = t.getSelection()
          if (selection) {
            const write = platform.writeClipboardText ?? navigator.clipboard?.writeText.bind(navigator.clipboard)
            if (write) void write(selection).catch((error) => debugTerminal("failed to copy terminal selection", error))
          }
          return true
        }
        if (clipboardShortcut === "paste") {
          const read = platform.readClipboardText?.() ?? navigator.clipboard?.readText?.()
          if (!read) return true
          void read
            .then((text) => {
              if (text) t.paste(text)
            })
            .catch((error) => debugTerminal("failed to paste into terminal", error))
          return true
        }

        // allow for toggle terminal keybinds in parent
        const config = settings.keybinds.get(TOGGLE_TERMINAL_ID) ?? DEFAULT_TOGGLE_TERMINAL_KEYBIND
        const keybinds = parseKeybind(config)

        return matchKeybind(keybinds, event)
      })

      const fit = new mod.FitAddon()
      const serializer = new SerializeAddon()
      cleanups.push(() => disposeIfDisposable(fit))
      t.loadAddon(serializer)
      t.loadAddon(fit)
      fitAddon = fit
      serializeAddon = serializer

      t.open(container)
      useTerminalUiBindings({
        container,
        term: t,
        cleanups,
        handlePointerDown,
        handleLinkClick,
      })

      if (local.autoFocus !== false) focusTerminal()

      if (typeof document !== "undefined" && document.fonts) {
        void document.fonts.ready.then(scheduleFit)
      }

      const onResize = t.onResize((size) => {
        setRevealHighlight(undefined)
        scheduleSize(size.cols, size.rows)
      })
      cleanups.push(() => disposeIfDisposable(onResize))
      const onData = t.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(data)
      })
      cleanups.push(() => disposeIfDisposable(onData))
      const onKey = t.onKey((key) => {
        restartTerminalCursorBlink(t.options)
        if (key.key == "Enter") {
          props.onSubmit?.()
        }
      })
      cleanups.push(() => disposeIfDisposable(onKey))

      const startResize = () => {
        fit.observeResize()
        handleResize = scheduleFit
        window.addEventListener("resize", handleResize)
        cleanups.push(() => window.removeEventListener("resize", handleResize))
      }

      const write = (data: string) =>
        new Promise<void>((resolve) => {
          if (!output) {
            resolve()
            return
          }
          output.push(data)
          output.flush(resolve)
        })

      if (restore && restoreSize) {
        await write(restore)
        fit.fit()
        scheduleSize(t.cols, t.rows)
        if (scrollY !== undefined) t.scrollToLine(scrollY)
        startResize()
      } else {
        fit.fit()
        scheduleSize(t.cols, t.rows)
        if (restore) {
          await write(restore)
          if (scrollY !== undefined) t.scrollToLine(scrollY)
        }
        startResize()
      }

      const once = { value: false }
      const decoder = new TextDecoder()

      const fail = (failure: TerminalConnectFailure) => {
        if (disposed) return
        if (once.value) return
        once.value = true
        local.onConnectError?.(failure)
      }

      const presence = () =>
        client.v2.pty
          .get({ ptyID: id, location: ptyLocation }, { throwOnError: false })
          .then((result) => terminalPresenceFromStatus(result.response.status))
          .catch((err) => {
            debugTerminal("failed to inspect terminal session", err)
            return terminalPresenceFromStatus(undefined)
          })

      const connectToken = async () => {
        const result = await client.v2.pty
          .connectToken(
            { ptyID: id, location: ptyLocation },
            {
              throwOnError: false,
              headers: { "x-novaclaw-ticket": "1" },
            },
          )
          .catch((err: unknown) => {
            if (err instanceof UnsupportedRequestError) return
            throw err
          })
        if (!result) return
        if (result.response.status === 200 && result.data?.data.ticket) return result.data.data.ticket
        if (result.response.status === 404 || result.response.status === 405) return
        if (result.response.status === 403)
          throw new Error("PTY connect ticket rejected by origin or CSRF checks. Check the server CORS config.")
        throw new Error(`PTY connect ticket failed with ${result.response.status}`)
      }

      const retry = (err: unknown) => {
        if (disposed) return
        if (reconn !== undefined) return

        const ms = Math.min(250 * 2 ** Math.min(tries, 4), 4_000)
        reconn = setTimeout(async () => {
          reconn = undefined
          if (disposed) return
          const state = await presence()
          if (state === "gone") {
            if (disposed) return
            fail({ kind: "gone", error: err })
            return
          }
          if (state === "unavailable") {
            if (disposed) return
            fail({ kind: "unavailable", error: err })
            return
          }
          if (disposed) return
          tries += 1
          open()
        }, ms)
      }

      const open = async () => {
        if (disposed) return
        drop?.()

        const ticket = await connectToken().catch((err) => {
          fail({ kind: "blocked", error: err })
          return undefined
        })
        if (once.value) return
        if (disposed) return

        const socket = new WebSocket(
          terminalWebSocketURL({
            url,
            id,
            directory,
            workspaceID: local.pty.workspaceID,
            cursor: seek,
            ticket,
            sameOrigin,
            username,
            password,
            authToken,
          }),
        )
        socket.binaryType = "arraybuffer"
        ws = socket

        const handleOpen = () => {
          if (disposed) return
          tries = 0
          local.onConnect?.()
          scheduleSize(t.cols, t.rows)
        }

        const handleMessage = (event: MessageEvent) => {
          if (disposed) return
          if (event.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(event.data)
            if (bytes[0] !== 0) return
            const json = decoder.decode(bytes.subarray(1))
            try {
              const meta = JSON.parse(json) as { cursor?: unknown }
              const next = meta?.cursor
              if (typeof next === "number" && Number.isSafeInteger(next) && next >= 0) {
                cursor = next
                seek = next
              }
            } catch (err) {
              debugTerminal("invalid websocket control frame", err)
            }
            return
          }

          const data = typeof event.data === "string" ? event.data : ""
          if (!data) return
          setRevealHighlight(undefined)
          output?.push(data)
          cursor += data.length
          seek = cursor
        }

        const handleError = (error: Event) => {
          if (disposed) return
          debugTerminal("websocket error", error)
        }

        const stop = () => {
          socket.removeEventListener("open", handleOpen)
          socket.removeEventListener("message", handleMessage)
          socket.removeEventListener("error", handleError)
          socket.removeEventListener("close", handleClose)
          if (ws === socket) ws = undefined
          if (drop === stop) drop = undefined
          if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close(1000)
        }

        const handleClose = (event: CloseEvent) => {
          if (ws === socket) ws = undefined
          if (drop === stop) drop = undefined
          socket.removeEventListener("open", handleOpen)
          socket.removeEventListener("message", handleMessage)
          socket.removeEventListener("error", handleError)
          socket.removeEventListener("close", handleClose)
          if (disposed) return
          if (event.code === 1000) return
          retry(new Error(language.t("terminal.connectionLost.abnormalClose", { code: event.code })))
        }

        drop = stop
        socket.addEventListener("open", handleOpen)
        socket.addEventListener("message", handleMessage)
        socket.addEventListener("error", handleError)
        socket.addEventListener("close", handleClose)
      }

      open()
    }

    void run().catch((err) => {
      if (disposed) return
      showToast({
        variant: "error",
        title: language.t("terminal.connectionLost.title"),
        description: err instanceof Error ? err.message : language.t("terminal.connectionLost.description"),
      })
      local.onConnectError?.({ kind: "unavailable", error: err })
    })
  })

  onCleanup(() => {
    disposed = true
    if (fitFrame !== undefined) cancelAnimationFrame(fitFrame)
    if (sizeTimer !== undefined) clearTimeout(sizeTimer)
    if (reconn !== undefined) clearTimeout(reconn)
    drop?.()
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) ws.close(1000)

    const finalize = () => {
      persistTerminal({ term, addon: serializeAddon, cursor, id: clientID, onCleanup: props.onCleanup })
      cleanup()
    }

    if (!output) {
      finalize()
      return
    }

    output.flush(finalize)
  })

  return (
    <div
      ref={container}
      data-component="terminal"
      data-prevent-autofocus
      tabIndex={-1}
      style={{ "background-color": terminalColors().background }}
      classList={{
        ...local.classList,
        "select-text": true,
        "size-full px-6 py-3 font-mono relative overflow-hidden": true,
        [local.class ?? ""]: !!local.class,
      }}
      {...others}
    >
      <Show when={revealHighlight()}>
        {(highlight) => (
          <div
            aria-hidden="true"
            class="pointer-events-none absolute z-10 rounded-[2px]"
            style={{
              left: `${highlight().left}px`,
              top: `${highlight().top}px`,
              width: `${highlight().width}px`,
              height: `${highlight().height}px`,
              "background-color": terminalColors().selectionBackground,
              outline: `1px solid ${terminalColors().foreground}`,
            }}
          />
        )}
      </Show>
    </div>
  )
}

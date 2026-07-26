import "@pierre/trees/web-components"
import { FileTree } from "@pierre/trees"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { Icon } from "@novaclaw/ui/icon"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import {
  absoluteTreePath,
  activeTreeNavigation,
  advanceTreePreload,
  nextSuggestionIndex,
  nextTreeScrollTop,
  pickerFileSearchQuery,
  pickerAbsoluteInput,
  pickerMode,
  preloadTreeDirectories,
  cleanPickerInput,
  createPriorityTaskQueue,
  createDirectorySearch,
  currentPickerSuggestions,
  displayPickerPath,
  pickerParent,
  pickerRoot,
} from "./directory-picker-domain"
import "./dialog-select-directory-v2.css"
import { DividerV2 } from "@novaclaw/ui/v2/divider-v2"

interface DialogSelectDirectoryV2Props {
  title?: string
  multiple?: boolean
  filename?: { initial: string; onFilename: (name: string) => void }
  onSelect: (result: string | string[] | null) => void
  server: ServerConnection.Any
  mode?: "directory" | "file"
  start?: string
}

export function DialogSelectDirectoryV2(props: DialogSelectDirectoryV2Props) {
  const global = useGlobal()
  const { sync, sdk } = global.ensureServerCtx(props.server)
  const dialog = useDialog()
  const language = useLanguage()
  const policy = pickerMode(props.mode ?? "directory", props.start)
  const action = {
    file: language.t("dialog.directory.action.selectFile"),
    directory: language.t("dialog.directory.action.selectFolder"),
  }
  const [root, setRoot] = createSignal("")
  const [input, setInput] = createSignal("")
  const [selected, setSelected] = createSignal("")
  const [suggestionsOpen, setSuggestionsOpen] = createSignal(false)
  const [activeSuggestion, setActiveSuggestion] = createSignal(-1)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  const [rootValid, setRootValid] = createSignal(false)
  const listings = new Map<string, Promise<Array<{ name: string; type: "file" | "directory" }> | undefined>>()
  const loads = createPriorityTaskQueue<Array<{ name: string; type: "file" | "directory" }> | undefined>(3)
  const advanced = new Set<string>()
  let tree: FileTree | undefined
  let container: HTMLDivElement | undefined
  let pathArea: HTMLDivElement | undefined
  let navigation = 0

  const missingBase = createMemo(() => !(sync.data.path.home || sync.data.path.directory))
  const [fallbackPath] = createResource(
    () => (missingBase() ? true : undefined),
    () =>
      sdk.client.path
        .get()
        .then((result) => result.data)
        .catch(() => undefined),
    { initialValue: undefined },
  )
  // FS-3: when the host has no browsable FS, the server reports `virtual` + `virtualRoot`
  // (an app-private directory); the picker starts there and skips host-drive roots.
  const virtualRoot = createMemo(() => {
    const p = sync.data.path as { virtual?: boolean; virtualRoot?: string }
    const f = fallbackPath() as { virtual?: boolean; virtualRoot?: string } | undefined
    return p.virtual && p.virtualRoot ? p.virtualRoot : f?.virtual && f.virtualRoot ? f.virtualRoot : undefined
  })
  const home = createMemo(() => virtualRoot() || sync.data.path.home || fallbackPath()?.home || "")
  // Host filesystem roots (drives on Windows) — `roots` postdates the generated SDK type, hence the
  // cast; an older server just yields no buttons. Suppressed in virtual mode (no host drives to jump to).
  const hostRoots = createMemo(() => {
    if (virtualRoot()) return []
    const fromSync = (sync.data.path as { roots?: readonly string[] }).roots
    const fromFallback = (fallbackPath() as { roots?: readonly string[] } | undefined)?.roots
    return fromSync ?? fromFallback ?? []
  })
  const start = createMemo(
    () =>
      props.start ||
      virtualRoot() ||
      sync.data.path.home ||
      sync.data.path.directory ||
      fallbackPath()?.home ||
      fallbackPath()?.directory,
  )
  // The Places rail: the instance host's existing well-known folders (server-probed) + the
  // user's pinned bookmarks (the `folder_bookmarks` config key — instance-wide, exported with
  // config, agent-editable per the self-healing law).
  const places = createMemo(() => {
    if (virtualRoot()) return []
    const fromSync = (sync.data.path as { places?: readonly { name: string; path: string }[] }).places
    const fromFallback = (fallbackPath() as { places?: readonly { name: string; path: string }[] } | undefined)
      ?.places
    return fromSync ?? fromFallback ?? []
  })
  const bookmarks = createMemo(
    () => ((sync.data.config as { folder_bookmarks?: readonly string[] }).folder_bookmarks ?? []) as string[],
  )
  const baseName = (value: string) => {
    const parts = value.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] ?? value
  }
  // One canonical key for pin compares/writes: forward slashes, no trailing separator — the
  // picker's root() is forward-slashed while server places are OS-style, and mixing the two
  // silently broke equality on Windows.
  const pinKey = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const normalizedRoot = createMemo(() => pinKey(root()))
  const isPinned = (target: string) => bookmarks().some((entry) => pinKey(entry) === pinKey(target))
  const rootPinned = createMemo(() => isPinned(normalizedRoot()))
  const writeBookmarks = (next: string[]) =>
    // Whole-value settings key: the array replaces wholesale (the updateConfig contract).
    (sync.updateConfig({ folder_bookmarks: next } as never) as Promise<unknown>).catch(() => undefined)
  const togglePinFor = (target: string) => {
    const key = pinKey(target)
    if (!key) return
    void writeBookmarks(
      isPinned(key) ? bookmarks().filter((entry) => pinKey(entry) !== key) : [...bookmarks(), key],
    )
  }
  const togglePin = () => {
    if (!normalizedRoot() || !rootValid()) return
    togglePinFor(normalizedRoot())
  }
  const removePin = (target: string) => void writeBookmarks(bookmarks().filter((entry) => pinKey(entry) !== pinKey(target)))
  // Right-click bookmarking (the discoverable path): tree rows expose their tree-relative path
  // as `data-item-path` through the shadow DOM (composedPath sees into it); rail rows pass
  // their absolute path directly. One cursor-anchored menu, one action.
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; path: string } | undefined>()
  const openTreeContextMenu = (event: MouseEvent) => {
    const row = event
      .composedPath()
      .find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.dataset?.itemPath !== undefined,
      )
    if (row && row.dataset.itemType !== "folder") return
    event.preventDefault()
    const target = row
      ? absoluteTreePath(root(), row.dataset.itemPath!.replace(/\/+$/, ""))
      : rootValid()
        ? root()
        : undefined
    if (!target) return
    setContextMenu({ x: event.clientX, y: event.clientY, path: target })
  }
  const openRailContextMenu = (event: MouseEvent, target: string) => {
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY, path: target })
  }

  const search = createDirectorySearch({ sdk, home, base: () => root() || start() })
  const [suggestions] = createResource(input, async (value) => {
    const typed = cleanPickerInput(value).replace(/\/+$/, "")
    const current = displayPickerPath(root(), value, home()).replace(/\/+$/, "")
    if (!typed || typed === current) return { query: value, items: [] }
    const directories = (await search(value)).map((absolute) => ({ absolute, type: "directory" as const }))
    if (!policy.includeFiles) return { query: value, items: directories.slice(0, 5) }
    const files = await sdk.client.find
      .files({ directory: root(), query: pickerFileSearchQuery(root(), value, home()), type: "file", limit: 20 })
      .then((result) => result.data ?? [])
      .catch(() => [])
    const results = [
      ...directories,
      ...files.map((path) => ({ absolute: absoluteTreePath(root(), path), type: "file" as const })),
    ]
    return {
      query: value,
      items: Array.from(new Map(results.map((result) => [result.absolute, result])).values()).slice(0, 8),
    }
  })
  const currentSuggestions = createMemo(() => currentPickerSuggestions(suggestions(), input()))

  async function load(path: string, generation: number, eager = false) {
    const key = path.replace(/\/+$/, "")
    setError(false)
    const absolute = absoluteTreePath(root(), key)
    const existing = listings.get(key)
    if (existing && !eager) loads.promote(`${generation}:${key}`)
    const request =
      existing ??
      loads.schedule(`${generation}:${key}`, eager ? "background" : "user", () => {
        if (!activeTreeNavigation(generation, navigation)) return Promise.resolve(undefined)
        return sdk.client.file
          .list({ directory: absolute, path: "" })
          .then((result) => result.data ?? [])
          .catch(() => undefined)
      })
    listings.set(key, request)
    const nodes = await request
    if (!activeTreeNavigation(generation, navigation)) return false
    if (!nodes) {
      listings.delete(key)
      if (!key) setError(true)
      return false
    }
    tree?.batch(policy.entries(key, nodes).map((item) => ({ type: "add", path: item })))
    if (!eager && advanceTreePreload(advanced, key)) {
      for (const directory of preloadTreeDirectories(key, nodes)) void load(directory, generation, true)
    }
    return true
  }

  async function navigate(path: string) {
    const value = policy.navigation(pickerAbsoluteInput(cleanPickerInput(path), home(), root() || start() || home()))
    if (!value) return
    const token = ++navigation
    setLoading(true)
    setRootValid(false)
    setSelected("")
    setSuggestionsOpen(false)
    setActiveSuggestion(-1)
    setRoot(value)
    setInput(displayPickerPath(value, value, home()))
    listings.clear()
    advanced.clear()
    tree?.resetPaths([])
    const valid = await load("", token)
    if (!activeTreeNavigation(token, navigation)) return
    setRootValid(valid)
    setLoading(false)
  }

  function complete() {
    const items = currentSuggestions()
    const match = items[activeSuggestion()] ?? items[0]
    if (!match) return
    const value = displayPickerPath(match.absolute, input(), home())
    setInput(match.type === "directory" && !value.endsWith("/") ? value + "/" : value)
    if (match.type === "file") {
      setSelected(policy.selection(root(), pickerFileSearchQuery(root(), match.absolute, home())) ?? "")
      setSuggestionsOpen(false)
      setActiveSuggestion(-1)
    }
  }

  function chooseSuggestion(suggestion: { absolute: string; type: "file" | "directory" }) {
    if (suggestion.type === "directory") {
      void navigate(suggestion.absolute)
      return
    }
    setInput(displayPickerPath(suggestion.absolute, input(), home()))
    setSelected(policy.selection(root(), pickerFileSearchQuery(root(), suggestion.absolute, home())) ?? "")
    setSuggestionsOpen(false)
    setActiveSuggestion(-1)
  }

  function moveSuggestion(delta: -1 | 1) {
    setSuggestionsOpen(true)
    setActiveSuggestion((current) => nextSuggestionIndex(current, delta, currentSuggestions().length))
  }

  const keyActions: Partial<Record<string, () => void>> = {
    ArrowDown: () => moveSuggestion(1),
    ArrowUp: () => moveSuggestion(-1),
    Enter: () => {
      // Enter goes to the TYPED path unless the user arrow-highlighted a suggestion — the
      // `?? items[0]` fallback used to hijack an exactly-typed absolute path onto the first
      // fuzzy match (the "Select folder moved my chat to the wrong place" trap; Tab still
      // completes with the top suggestion).
      const items = currentSuggestions()
      const highlighted = activeSuggestion() >= 0 ? items[activeSuggestion()] : undefined
      if (highlighted) chooseSuggestion(highlighted)
      else void navigate(input())
    },
    Tab: complete,
  }

  function handleInputKey(event: KeyboardEvent) {
    const action = keyActions[event.key]
    if (!action) return
    if (event.key === "Tab" && event.shiftKey) return
    event.preventDefault()
    action()
  }

  // Save-As name, when the caller asked for one. Seeded from `filename.initial` so the common case is
  // "accept the suggested name and press Save".
  const [saveAsName, setSaveAsName] = createSignal(props.filename?.initial ?? "")

  function resolve() {
    const path = policy.result(root(), selected(), rootValid())
    if (!path) return
    // Report the chosen name BEFORE the path: the caller reads it synchronously inside onSelect.
    if (props.filename) props.filename.onFilename(saveAsName().trim() || props.filename.initial)
    props.onSelect(props.multiple ? [path] : path)
    dialog.close()
  }

  onMount(() => {
    const closeSuggestions = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.(".directory-picker-v2-context-menu") == null)
        setContextMenu(undefined)
      if (pathArea?.contains(event.target as Node)) return
      setSuggestionsOpen(false)
      setActiveSuggestion(-1)
    }
    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && contextMenu()) {
        event.stopPropagation()
        setContextMenu(undefined)
      }
    }
    document.addEventListener("pointerdown", closeSuggestions)
    document.addEventListener("keydown", closeMenuOnEscape, true)
    onCleanup(() => {
      document.removeEventListener("pointerdown", closeSuggestions)
      document.removeEventListener("keydown", closeMenuOnEscape, true)
    })
    tree = new FileTree({
      paths: [],
      flattenEmptyDirectories: false,
      initialExpansion: "closed",
      stickyFolders: true,
      unsafeCSS: `
        button[data-type="item"] {
          background: transparent !important;
          box-shadow: none !important;
        }
        button[data-type="item"]:hover {
          background: var(--v2-overlay-simple-overlay-hover) !important;
        }
        button[data-type="item"]:focus-visible {
          outline: none !important;
          box-shadow: none !important;
        }
        [data-file-tree-virtualized-scroll] {
          overscroll-behavior: contain;
          scrollbar-width: thin;
        }
      `,
      onExpansionChange(change) {
        if (change.expanded) void load(change.path, navigation)
      },
      onSelectionChange(paths) {
        const path = paths.at(-1)
        setSelected(path ? (policy.selection(root(), path) ?? "") : "")
      },
    })
    if (!container) return
    tree.render({ containerWrapper: container })
    tree.getFileTreeContainer()?.classList.add("directory-picker-v2-tree")
  })

  createEffect(() => {
    const path = start()
    if (!path || root()) return
    void navigate(path)
  })

  onCleanup(() => tree?.cleanUp())

  return (
    <Dialog size="large" class="directory-picker-v2">
      <DialogHeader>
        <DialogTitle>{props.title ?? language.t("command.project.open")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="directory-picker-v2-body pt-4!">
        <div class="directory-picker-v2-path" ref={pathArea}>
          <TextInputV2
            value={input()}
            autofocus
            autocomplete="off"
            spellcheck={false}
            class="!w-full"
            onInput={(event) => {
              setInput(cleanPickerInput(event.currentTarget.value))
              setSelected("")
              setSuggestionsOpen(true)
              setActiveSuggestion(-1)
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestionsOpen()}
            aria-controls="directory-picker-v2-suggestions"
            aria-activedescendant={
              activeSuggestion() >= 0 ? `directory-picker-v2-suggestion-${activeSuggestion()}` : undefined
            }
            onKeyDown={handleInputKey}
          />
          <div class="directory-picker-v2-actions">
            <ButtonV2 size="small" variant="ghost" onClick={() => void navigate(home())}>
              ~
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={() => void navigate(pickerRoot(root()) || root())}>
              {language.t("dialog.directory.root")}
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={() => void navigate(pickerParent(root()))}>
              {language.t("dialog.directory.parent")}
            </ButtonV2>
            <Show when={hostRoots().length > 1}>
              <For each={hostRoots()}>
                {(hostRoot) => (
                  <ButtonV2 size="small" variant="ghost" onClick={() => void navigate(hostRoot)}>
                    {hostRoot.replace(/\\$/, "")}
                  </ButtonV2>
                )}
              </For>
            </Show>
            <TooltipV2
              placement="top"
              gutter={4}
              value={language.t(rootPinned() ? "dialog.directory.unpin" : "dialog.directory.pin")}
            >
              <ButtonV2
                size="small"
                variant="ghost"
                disabled={!normalizedRoot() || !rootValid()}
                aria-pressed={rootPinned()}
                onClick={togglePin}
              >
                <Icon
                  name="folder-add-left"
                  size="small"
                  class={rootPinned() ? "text-v2-icon-icon-accent" : undefined}
                />
                {language.t(rootPinned() ? "dialog.directory.pinnedShort" : "dialog.directory.pinShort")}
              </ButtonV2>
            </TooltipV2>
          </div>
          <Show when={suggestionsOpen() && currentSuggestions().length > 0}>
            <div id="directory-picker-v2-suggestions" role="listbox" class="directory-picker-v2-suggestions">
              <For each={currentSuggestions()}>
                {(suggestion, index) => (
                  <button
                    id={`directory-picker-v2-suggestion-${index()}`}
                    role="option"
                    aria-selected={index() === activeSuggestion()}
                    data-active={index() === activeSuggestion() ? "" : undefined}
                    onPointerMove={() => setActiveSuggestion(index())}
                    onClick={() => chooseSuggestion(suggestion)}
                  >
                    {displayPickerPath(suggestion.absolute, input(), home())}
                    {suggestion.type === "directory" ? "/" : ""}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
        <div class="directory-picker-v2-main">
          <div class="directory-picker-v2-rail">
            <Show when={bookmarks().length > 0}>
              <div class="directory-picker-v2-rail-title">{language.t("dialog.directory.bookmarks")}</div>
              <For each={bookmarks()}>
                {(pin) => (
                  <div
                    class="directory-picker-v2-rail-item"
                    data-active={normalizedRoot() === pinKey(pin) ? "" : undefined}
                    title={pin}
                    onContextMenu={(event) => openRailContextMenu(event, pin)}
                  >
                    <button type="button" class="directory-picker-v2-rail-nav" onClick={() => void navigate(pin)}>
                      <Icon name="folder" size="small" />
                      <span>{baseName(pin)}</span>
                    </button>
                    <button
                      type="button"
                      class="directory-picker-v2-rail-remove"
                      aria-label={language.t("dialog.directory.unpin")}
                      onClick={() => removePin(pin)}
                    >
                      <Icon name="close-small" size="small" />
                    </button>
                  </div>
                )}
              </For>
            </Show>
            <div class="directory-picker-v2-rail-title">{language.t("dialog.directory.places")}</div>
            <div
              class="directory-picker-v2-rail-item"
              data-active={normalizedRoot() === pinKey(home()) ? "" : undefined}
              title={home()}
              onContextMenu={(event) => openRailContextMenu(event, home())}
            >
              <button type="button" class="directory-picker-v2-rail-nav" onClick={() => void navigate(home())}>
                <Icon name="folder" size="small" />
                <span>{language.t("dialog.directory.homePlace")}</span>
              </button>
            </div>
            <For each={places()}>
              {(place) => (
                <div
                  class="directory-picker-v2-rail-item"
                  data-active={normalizedRoot() === pinKey(place.path) ? "" : undefined}
                  title={place.path}
                  onContextMenu={(event) => openRailContextMenu(event, place.path)}
                >
                  <button type="button" class="directory-picker-v2-rail-nav" onClick={() => void navigate(place.path)}>
                    <Icon name="folder" size="small" />
                    <span>{place.name}</span>
                  </button>
                </div>
              )}
            </For>
          </div>
          <div
            class="directory-picker-v2-browser"
            ref={container}
            onContextMenu={openTreeContextMenu}
          onWheel={(event) => {
            const scroller = tree
              ?.getFileTreeContainer()
              ?.shadowRoot?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]")
            if (!scroller) return
            const next = nextTreeScrollTop(
              scroller.scrollTop,
              event.deltaY,
              scroller.scrollHeight,
              scroller.clientHeight,
            )
            if (next === scroller.scrollTop) return
            event.preventDefault()
            scroller.scrollTop = next
            scroller.dispatchEvent(new Event("scroll"))
          }}
        >
            <Show when={loading()}>
              <div class="directory-picker-v2-state">{language.t("common.loading")}</div>
            </Show>
            <Show when={!loading() && error()}>
              <div class="directory-picker-v2-state">{language.t("dialog.directory.readError")}</div>
            </Show>
          </div>
        </div>
        <Show when={props.filename}>
          <label class="directory-picker-v2-filename">
            <span>{language.t("dialog.directory.filename")}</span>
            <input
              type="text"
              value={saveAsName()}
              spellcheck={false}
              onInput={(event) => setSaveAsName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  resolve()
                }
              }}
            />
          </label>
        </Show>
        <div class="directory-picker-v2-selection">{policy.result(root(), selected(), rootValid())}</div>
        <Show when={contextMenu()}>
          {(menu) => (
            <div
              class="directory-picker-v2-context-menu"
              style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
              role="menu"
            >
              <div class="directory-picker-v2-context-menu-path" title={menu().path}>
                {baseName(menu().path)}
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  togglePinFor(menu().path)
                  setContextMenu(undefined)
                }}
              >
                <Icon name="folder-add-left" size="small" />
                {language.t(isPinned(menu().path) ? "dialog.directory.unpin" : "dialog.directory.pin")}
              </button>
            </div>
          )}
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={!policy.result(root(), selected(), rootValid())} onClick={resolve}>
          {action[policy.action]}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

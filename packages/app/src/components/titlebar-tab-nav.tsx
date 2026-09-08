import { createEffect, createMemo, createSignal, onCleanup, Show, type Ref } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@novaclaw/ui/v2/icon"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { projectForSession } from "@/pages/layout/helpers"
import { SessionTabAvatar } from "@/pages/layout/session-tab-avatar"
import { showToast } from "@/utils/toast"
import type { SessionV2Info as Session } from "@novaclaw/sdk/v2"
import { tabLabel } from "@/apps/session-tab-label"
import { canOpenTabRename, forwardTabRef } from "./titlebar-tab-gesture"

export function TabNavItem(props: {
  ref?: Ref<HTMLDivElement>
  href: string
  server: ServerConnection.Key
  session: () => Session | undefined
  onTitleChange?: (title: string) => void
  onTitleChangeFailed?: (title: string) => void
  onNavigate: () => void
  active?: boolean
  activeServer: boolean
  forceTruncate?: boolean
  suppressNavigation?: () => boolean
  dragging?: boolean
  pressed?: boolean
  hidden?: boolean
}) {
  const language = useLanguage()
  const [editing, setEditing] = createSignal(false)
  const [titleOverflowing, setTitleOverflowing] = createSignal(false)
  let tabRoot!: HTMLDivElement
  let titleEl!: HTMLSpanElement
  let committing = false
  let measureFrame: number | undefined

  const global = useGlobal()
  const serverCtx = createMemo(() => {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.server)
    if (conn) return global.ensureServerCtx(conn)
  })
  const project = createMemo(() => {
    const session = props.session()
    if (!session) return
    return projectForSession(session, serverCtx()?.projects.list() ?? [])
  })

  /**
   * 🔴 The tab says WHO, not what (owner, 2026-08-23). Reasoning and the fallbacks live in
   * `@/apps/session-tab-label`, where `bun test` can reach them — this file is a `.tsx` the unit
   * tier cannot load, which is exactly how defects in the tab strip have survived before.
   *
   * ⚠️ The roster is read from THIS TAB'S OWN server context, not from an ambient one: a tab strip
   * mixes tabs from more than one instance, and resolving a colleague's name against the wrong
   * instance's roster is a confident falsehood rather than a missing one. That roster is the one
   * shared fetch (`createServerCtx`), so a strip of ten tabs costs zero extra requests.
   */
  const label = createMemo(() => {
    const session = props.session()
    return tabLabel({
      agent: session?.agent,
      title: session?.title,
      agents: serverCtx()?.agents.list() ?? [],
    })
  })

  const measureTitleOverflow = () => {
    if (!titleEl || editing()) {
      setTitleOverflowing(false)
      return
    }
    setTitleOverflowing(titleEl.scrollWidth > titleEl.clientWidth)
  }

  const scheduleTitleOverflow = () => {
    if (measureFrame !== undefined) return
    measureFrame = requestAnimationFrame(() => {
      measureFrame = undefined
      measureTitleOverflow()
    })
  }

  createEffect(() => {
    label().text
    props.forceTruncate
    editing()
    scheduleTitleOverflow()
  })

  createResizeObserver(() => tabRoot, scheduleTitleOverflow)
  onCleanup(() => {
    if (measureFrame !== undefined) cancelAnimationFrame(measureFrame)
  })

  const selectTitle = () => {
    const range = document.createRange()
    range.selectNodeContents(titleEl)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  const rename = async (title: string) => {
    const ctx = serverCtx()
    const session = props.session()
    if (!ctx || !session) return
    const client = ctx.sdk.createClient({ directory: session.location.directory, throwOnError: true })
    await client.v2.session.update({ sessionID: session.id, title })
  }

  const closeRename = async (save: boolean) => {
    if (committing || !editing()) return
    committing = true

    const original = props.session()?.title ?? ""
    const next = (titleEl.textContent ?? "").trim()

    titleEl.scrollLeft = 0
    if (save && next && next !== original) props.onTitleChange?.(next)
    setEditing(false)

    if (!save || !next || next === original) {
      committing = false
      return
    }

    try {
      await rename(next)
    } catch (err) {
      props.onTitleChangeFailed?.(original)
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : undefined,
      })
    }

    committing = false
  }

  createEffect(() => {
    if (editing()) return
    if (!titleEl) return
    titleEl.textContent = label().text
  })

  const openRename = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!canOpenTabRename(props.dragging, editing(), committing)) return
    // ⚠️ A tab showing a COLLEAGUE is not renameable here — this gesture writes the session title,
    // so on such a tab the user would type a new name, press Enter and watch it snap back to the
    // colleague's. Renaming a colleague is done in its own config, which is the one place that
    // write belongs.
    if (!label().renameable) return
    const session = props.session()
    if (!session) return
    titleEl.textContent = label().text
    setEditing(true)

    requestAnimationFrame(() => {
      titleEl.focus()
      selectTitle()
    })
  }

  createEffect(() => {
    if (!editing()) return

    const cleanup = makeEventListener(
      document,
      "pointerdown",
      (event) => {
        const target = event.target
        if (!(target instanceof Node)) return
        if (tabRoot.contains(target)) return
        void closeRename(true)
      },
      { capture: true },
    )

    onCleanup(cleanup)
  })

  return (
    <div
      ref={(el) => {
        tabRoot = el
        forwardTabRef(props.ref, el)
      }}
      data-titlebar-tab
      data-slot="titlebar-tab-item"
      data-title-overflow={titleOverflowing()}
      data-editing={editing()}
      class="group relative flex h-7 w-full min-w-0 select-none flex-row items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[6px] bg-[var(--tab-bg)] px-1.5 [container-type:inline-size] [--tab-bg:var(--v2-background-bg-deep)] hover:[--tab-bg:var(--v2-background-bg-layer-02)] has-[>a:focus-visible]:[--tab-bg:var(--v2-background-bg-layer-02)] data-[active='true']:[--tab-bg:var(--v2-background-bg-layer-02)] data-[dragging='true']:[--tab-bg:var(--v2-background-bg-layer-02)] data-[pressed='true']:[--tab-bg:var(--v2-background-bg-layer-02)] data-[editing='true']:[--tab-bg:var(--v2-background-bg-layer-02)]"
      classList={{ invisible: props.hidden }}
      data-active={props.active}
      data-dragging={props.dragging}
      data-pressed={props.pressed}
    >
      <Show when={props.session()}>
        {(session) => {
          return (
            <a
              data-slot="tab-link"
              data-titlebar-tab-link
              href={props.href}
              draggable={false}
              onDragStart={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.preventDefault()
                if (editing()) return
                if (props.suppressNavigation?.()) return
                props.onNavigate()
              }}
              class="flex h-full min-w-0 flex-1 flex-row items-center gap-1.5 text-[13px] font-medium text-v2-text-text-faint group-data-[active='true']:text-v2-text-text-base group-data-[editing='true']:text-v2-text-text-base [-webkit-user-drag:none]"
            >
              <span data-slot="project-avatar-slot">
                <SessionTabAvatar
                  project={project()}
                  directory={session()?.location?.directory ?? ""}
                  sessionId={session().id}
                  activeServer={props.activeServer}
                />
              </span>
              <span
                ref={(el) => {
                  titleEl = el
                  titleEl.textContent = label().text
                }}
                data-slot="tab-title"
                data-titlebar-tab-title
                // The chat's own topic, kept where it costs nothing until it is wanted.
                title={label().tooltip}
                class="min-w-0 flex-1 outline-none leading-4"
                classList={{
                  "overflow-hidden text-clip whitespace-nowrap": !editing(),
                  "select-text": editing(),
                }}
                contenteditable={editing() ? true : undefined}
                onDblClick={openRename}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.key === "Enter") {
                    event.preventDefault()
                    void closeRename(true)
                    return
                  }
                  if (event.key !== "Escape") return
                  event.preventDefault()
                  titleEl.textContent = label().text
                  void closeRename(false)
                }}
                onBlur={() => void closeRename(true)}
                onPointerDown={(event) => {
                  if (!editing()) return
                  event.stopPropagation()
                }}
                onClick={(event) => {
                  if (!editing()) return
                  event.preventDefault()
                }}
              />
            </a>
          )
        }}
      </Show>
    </div>
  )
}

export function DraftTabItem(props: {
  ref?: Ref<HTMLDivElement>
  href: string
  title: string
  active?: boolean
  onNavigate: () => void
  suppressNavigation?: () => boolean
  dragging?: boolean
  pressed?: boolean
  hidden?: boolean
}) {
  return (
    <div
      ref={(el) => forwardTabRef(props.ref, el)}
      data-titlebar-tab
      data-slot="titlebar-tab-item"
      data-active={props.active}
      data-dragging={props.dragging}
      data-pressed={props.pressed}
      class="group relative flex h-7 w-full min-w-0 flex-row items-center gap-1.5 overflow-hidden rounded-[6px] bg-[var(--tab-bg)] px-1.5 [container-type:inline-size] whitespace-nowrap [--tab-bg:var(--v2-background-bg-deep)] hover:[--tab-bg:var(--v2-background-bg-layer-02)] has-[>a:focus-visible]:[--tab-bg:var(--v2-background-bg-layer-02)] data-[active='true']:[--tab-bg:var(--v2-background-bg-layer-02)] data-[dragging='true']:[--tab-bg:var(--v2-background-bg-layer-02)] data-[pressed='true']:[--tab-bg:var(--v2-background-bg-layer-02)] data-[editing='true']:[--tab-bg:var(--v2-background-bg-layer-02)]"
      classList={{ invisible: props.hidden }}
    >
      <a
        data-slot="tab-link"
        data-titlebar-tab-link
        href={props.href}
        draggable={false}
        onDragStart={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onClick={(event) => {
          event.preventDefault()
          if (props.suppressNavigation?.()) return
          props.onNavigate()
        }}
        class="flex h-full min-w-0 flex-1 flex-row items-center gap-1.5 text-[13px] font-medium text-v2-text-text-faint group-data-[active='true']:text-v2-text-text-base [-webkit-user-drag:none]"
      >
        <span class="flex size-4 shrink-0 items-center justify-center">
          <IconV2 name="edit" />
        </span>
        <span
          data-titlebar-tab-title
          class="min-w-0 flex-1 overflow-hidden text-clip whitespace-nowrap outline-none leading-4"
        >
          {props.title}
        </span>
      </a>
    </div>
  )
}

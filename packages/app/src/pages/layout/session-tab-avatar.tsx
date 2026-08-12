import type { LocalProject } from "@/context/layout"
import { getProjectAvatarVariant } from "@/context/layout"
import { displayName, getProjectAvatarSource } from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { ProjectAvatar } from "@novaclaw/ui/v2/project-avatar-v2"
import { SessionProgressIndicatorV2 } from "@novaclaw/session-ui/v2/session-progress-indicator-v2"
import { Show } from "solid-js"

export function SessionTabAvatar(props: {
  project?: LocalProject
  directory: string
  sessionId: string
  activeServer: boolean
  revealProjectOnHover?: boolean
}) {
  const directory = () => props.directory
  const sessionId = () => props.sessionId
  const state = useSessionTabAvatarState(directory, sessionId, () => props.activeServer)
  /**
   * A CUSTOM project icon still identifies its tab, so it is kept. What is dropped is the monogram
   * FALLBACK — the project name's first letter, identical for every session in the same folder, so
   * it told the tabs apart from nothing.
   */
  const hasCustomIcon = () => Boolean(getProjectAvatarSource(props.project?.id, props.project?.icon))
  const projectAvatar = () => (
    <ProjectAvatar
      fallback={displayName(props.project ?? { worktree: props.directory })}
      src={getProjectAvatarSource(props.project?.id, props.project?.icon)}
      variant={getProjectAvatarVariant(props.project?.icon?.color)}
      unread={state.unread()}
    />
  )
  /** Status without identity: an unread session must still announce itself with no icon to hang on. */
  const unreadDot = () => (
    <Show when={state.unread()}>
      <span class="relative block size-4 shrink-0" data-slot="session-tab-unread">
        <span class="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-v2-background-bg-accent" />
      </span>
    </Show>
  )
  return (
    <Show when={state.loading()} fallback={<Show when={hasCustomIcon()} fallback={unreadDot()}>{projectAvatar()}</Show>}>
      <span class="relative block size-4 shrink-0">
        <SessionProgressIndicatorV2
          class={`absolute inset-0 ${props.revealProjectOnHover === false ? "" : "group-hover:invisible"}`}
        />
        <Show when={props.revealProjectOnHover !== false && hasCustomIcon()}>
          <span class="invisible absolute inset-0 group-hover:visible">{projectAvatar()}</span>
        </Show>
      </span>
    </Show>
  )
}

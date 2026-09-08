// The composer controls row (ui-arch P4b): the per-CHAT chips — the model and Tune. Posture,
// permission mode and Strict moved into the agent's configuration on 2026-08-21; the folder chip
// became the agent identity chip. Each control is a dumb view over a plain state object the
// composer builds — no controller context reaches in here.
import { Show } from "solid-js"
import { useTunePanelOpener, type ComposerFeaturesControlState } from "./features-control"
import { ComposerAgentControl } from "./agent-control"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import type { ComposerAgentControlState } from "./agent-option"
import { GOVERNING_ID } from "@/apps/contacts"

export type ComposerControlsRowState = {
  /** New-session composer OR an active session id — gates the per-chat controls cluster (1K). */
  sessionControls: boolean
  /** The agent chip only renders mid-session (agent.visible). */
  agentVisible: boolean
  features: ComposerFeaturesControlState
  agent: ComposerAgentControlState
}

export function ComposerControlsRow(props: { state: ComposerControlsRowState }) {
  const tune = useTunePanelOpener(() => props.state.features)
  const language = useLanguage()
  const pickDirectory = useDirectoryPicker()
  const server = useServer()
  const global = useGlobal()
  const sync = useServerSync()

  /**
   * Assign this colleague a project, from the composer.
   *
   * ⚠️ It WRITES immediately, unlike Tune's copy of this control which stages a draft until Save.
   * The difference is deliberate: a chip has no Save button, so a picker that only staged would
   * silently discard the choice the moment the user carried on typing — a control that reports
   * success and changes nothing, which is the defect this session has already fixed twice elsewhere.
   */
  const pickProject = () => {
    const conn = server.current
    const agentID = props.state.features.agent
    // Nova's folder is part of its compiled charter. Keep the forbidden config patch unreachable
    // here as well as in the full profile: this composer shortcut was the one sibling write surface
    // found by the governing-agent sweep.
    if (!conn || !agentID || agentID === GOVERNING_ID) return
    pickDirectory({
      server: conn,
      title: language.t("prompt.agent.project.pick"),
      onSelect: (result) => {
        const picked = Array.isArray(result) ? result[0] : result
        if (!picked) return
        void sync()
          .updateConfig({ agents: { [agentID]: { directory: picked } } } as never)
          /**
           * 🔴 **The WRITE is not the update** (owner, 2026-08-28: *"picking a new project folder by
           * clicking project button in the chat windows doesn't change the current project: it still
           * says 'No project'"*). The chip reads the shared roster resource, and a config PATCH does
           * not touch it — so the folder changed on the server and the control that changed it went
           * on reporting the old value. A picker that reports success and shows no change is
           * indistinguishable from one that is broken.
           *
           * ⚠️ The same two lines Tune runs after a save, for the same reason and against the same
           * resource. That is the tell: this was a THIRD writer of a value two other writers already
           * knew had to be re-read.
           */
          .then(() => {
            const current = server.current
            if (current) global.ensureServerCtx(current).agents.refetch()
          })
          .catch((error: unknown) => {
            // Said, never swallowed: a project that silently fails to change leaves the colleague
            // working somewhere the chip now claims it is not.
            showToast({ variant: "error", title: language.t("agentConfig.saveFailed"), description: String(error) })
          })
      },
    })
  }
  return (
    <>
      {/* ⚠️ Gated on `sessionControls` ALONE, not on `agentVisible`. The two differ on the
          NEW-SESSION composer — `agentVisible` is `!!sessionID()` while `sessionControls` is
          "new-session OR active session" — so requiring both would have removed the tuning panel from
          the composer where a chat is about to START, which is exactly where its per-chat switches are
          worth setting in advance. Retiring the Tune button made that gap possible, and it is the kind
          a diff does not show: the control simply stops being rendered. The chip carries its own
          `options.length > 0` guard, so it still shows nothing when no colleague has resolved. */}
      <Show when={props.state.sessionControls}>
        {/* WHOSE chat this is — the folder chip's replacement. A chat's folder is its colleague's
            folder now, so the question the composer can still usefully answer is who owns this work. */}
        <ComposerAgentControl
          state={{
            ...props.state.agent,
            onOpenConfig: tune.open,
            onPickProject: props.state.features.agent === GOVERNING_ID ? undefined : pickProject,
            modeSuffix: tune.modeSuffix,
            unattended: tune.unattended,
          }}
        />
      </Show>
    </>
  )
}

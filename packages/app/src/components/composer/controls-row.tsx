// The composer controls row (ui-arch P4b): the per-CHAT chips — the model and Tune. Posture,
// permission mode and Strict moved into the agent's configuration on 2026-08-21; the folder chip
// became the agent identity chip. Each control is a dumb view over a plain state object the
// composer builds — no controller context reaches in here.
import { Show } from "solid-js"
import { useTunePanelOpener, type ComposerFeaturesControlState } from "./features-control"
import { ComposerAgentControl } from "./agent-control"
import type { ComposerAgentControlState } from "./agent-option"

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
  return (
    <>
      {/* 🔴 The model chip LEFT this row on 2026-08-21 (owner: *"move model picker into the agents
          configuration, where by default all agents use Default model"*). A colleague has one mind:
          picking a model per chat made the same colleague clever in one conversation and poor in the
          next, for reasons the user could not see. It is chosen in the colleague's configuration and
          defaults to the instance model set in Settings → Models. */}
      {/* 1K: the permission-mode droplist shows on the new-session composer AND
          mid-session (an active session id) — mid-session selection calls switchMode. */}
      {/* 🔴 Posture, permission mode and Strict LEFT this row on 2026-08-21 (owner: they "should be
          part of the agent too"). They are standing choices about how a colleague works, so they live
          in its configuration — re-choosing them per chat asked the user again for a decision that
          never changes. What stays here is per-CHAT: the model this turn uses, and Tune. */}
      {/* 🔴 **The "Tune" button is GONE and the colleague chip opens its panel instead** (owner,
          2026-08-27). Two controls stood side by side: one named WHO the chat was for and did
          nothing when pressed, the other was a verb with no visible subject. One chip answers both —
          it says whose desk this is, and pressing it opens that colleague's configuration, with this
          chat's own controls as the section inside it they already were.
          ⚠️ The tuning panel itself is unchanged; only its trigger moved. T1's ruling still holds
          (owner 2026-07-14: per-chat helpers stay discoverable rather than behind an expertise
          level) — the door is now labelled with a name instead of a verb, which is more
          discoverable, not less. */}
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
            modeSuffix: tune.modeSuffix,
            unattended: tune.unattended,
          }}
        />
      </Show>
    </>
  )
}

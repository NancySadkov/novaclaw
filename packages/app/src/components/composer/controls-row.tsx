// The composer controls row (ui-arch P4b): the per-CHAT chips — the model and Tune. Posture,
// permission mode and Strict moved into the agent's configuration on 2026-08-21; the folder chip
// became the agent identity chip. Each control is a dumb view over a plain state object the
// composer builds — no controller context reaches in here.
import { Show } from "solid-js"
import { ComposerModelControl, type ComposerModelControlState } from "./model-control"
import { ComposerFeaturesControl, type ComposerFeaturesControlState } from "./features-control"
import { ComposerAgentControl } from "./agent-control"
import type { ComposerAgentControlState } from "./agent-option"

export type ComposerControlsRowState = {
  /** New-session composer OR an active session id — gates the per-chat controls cluster (1K). */
  sessionControls: boolean
  /** The agent chip only renders mid-session (agent.visible). */
  agentVisible: boolean
  model: ComposerModelControlState
  features: ComposerFeaturesControlState
  agent: ComposerAgentControlState
}

export function ComposerControlsRow(props: { state: ComposerControlsRowState }) {
  return (
    <>
      <ComposerModelControl state={props.state.model} />
      {/* 1K: the permission-mode droplist shows on the new-session composer AND
          mid-session (an active session id) — mid-session selection calls switchMode. */}
      {/* 🔴 Posture, permission mode and Strict LEFT this row on 2026-08-21 (owner: they "should be
          part of the agent too"). They are standing choices about how a colleague works, so they live
          in its configuration — re-choosing them per chat asked the user again for a decision that
          never changes. What stays here is per-CHAT: the model this turn uses, and Tune. */}
      <Show when={props.state.sessionControls}>
        {/* T1: the Tuning toggles — ungated like the Strict switch (owner call
            2026-07-14: per-chat helpers must be discoverable, not hidden behind an
            expertise level; the helpers' INTERNALS stay in Settings). */}
        <ComposerFeaturesControl state={props.state.features} />
        {/* WHOSE chat this is — the folder chip's replacement. A chat's folder is its colleague's
            folder now, so the question the composer can still usefully answer is who owns this work. */}
        <Show when={props.state.agentVisible}>
          <ComposerAgentControl state={props.state.agent} />
        </Show>
      </Show>
    </>
  )
}

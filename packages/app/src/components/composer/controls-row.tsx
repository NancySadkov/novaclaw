// The composer controls row (ui-arch P4b): the model/permission/strict/tuning/folder chips,
// extracted from prompt-input.tsx. Each control is a dumb view over a plain state object the
// composer builds — no controller context reaches in here.
import { Show } from "solid-js"
import { ComposerModelControl, type ComposerModelControlState } from "./model-control"
import {
  ComposerPermissionModeControl,
  type ComposerPermissionModeControlState,
} from "./permission-mode-control"
import { ComposerStrictControl, type ComposerStrictControlState } from "./strict-control"
import { ComposerFeaturesControl, type ComposerFeaturesControlState } from "./features-control"
import { ComposerFolderControl, type ComposerFolderControlState } from "./folder-control"

export type ComposerControlsRowState = {
  /** New-session composer OR an active session id — gates the per-chat controls cluster (1K). */
  sessionControls: boolean
  /** The folder chip only renders mid-session (folder.visible). */
  folderVisible: boolean
  model: ComposerModelControlState
  permissionMode: ComposerPermissionModeControlState
  strict: ComposerStrictControlState
  features: ComposerFeaturesControlState
  folder: ComposerFolderControlState
}

export function ComposerControlsRow(props: { state: ComposerControlsRowState }) {
  return (
    <>
      <ComposerModelControl state={props.state.model} />
      {/* 1K: the permission-mode droplist shows on the new-session composer AND
          mid-session (an active session id) — mid-session selection calls switchMode. */}
      <Show when={props.state.sessionControls}>
        <ComposerPermissionModeControl state={props.state.permissionMode} />
        <ComposerStrictControl state={props.state.strict} />
        {/* T1: the Tuning toggles — ungated like the Strict switch (owner call
            2026-07-14: per-chat helpers must be discoverable, not hidden behind an
            expertise level; the helpers' INTERNALS stay in Settings). */}
        <ComposerFeaturesControl state={props.state.features} />
        <Show when={props.state.folderVisible}>
          <ComposerFolderControl state={props.state.folder} />
        </Show>
      </Show>
    </>
  )
}

// components/composer — the composer controls row and its chips (ui-arch P4b).
export { ComposerControlsRow, type ComposerControlsRowState } from "./controls-row"
export { ComposerModelControl, type ComposerModelControlState } from "./model-control"
export { ComposerPermissionModeControl, type ComposerPermissionModeControlState } from "./permission-mode-control"
export { ComposerPostureControl, type ComposerPosture, type ComposerPostureControlState } from "./posture-control"
export { ComposerStrictControl, type ComposerStrictControlState } from "./strict-control"
export {
  // The "Tune" button was retired 2026-08-27 — the colleague chip opens its panel now, so what
  // this module exports is the OPENER rather than a control of its own.
  useTunePanelOpener,
  type ComposerFeature,
  type ComposerFeatureOrigin,
  type ComposerFeaturesControlState,
  type ComposerMakeDefaultReceipt,
  type ComposerMakeDefaultState,
  type ComposerProjectLayer,
  type ComposerRemoteChatState,
  type ComposerRemoteTrust,
} from "./features-control"
export { ComposerVariantControl, type ComposerVariantControlState } from "./variant-control"
export { ComposerAttachmentsTray, type ComposerAttachmentsTrayState } from "./attachments-tray"
export { ComposerEditorSurface, type ComposerEditorSurfaceState } from "./editor-surface"
export { ComposerAgentControl } from "./agent-control"
export type { ComposerAgentControlState, ComposerAgentOption } from "./agent-option"

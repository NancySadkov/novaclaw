export * as SessionFeature from "./session-feature"

import { Schema } from "effect"

// The per-session harness-feature toggles (the composer's Tuning control). Each is a tri-state
// override on the session row: true/false = this chat's explicit stance, absent (NULL) = inherit
// (parent chain, then the matching global config block's `enabled`). The feature INTERNALS
// (cadence, commands, mood engine tuning, …) stay global-only — per-session we surface exactly
// the on/off a user tunes per task, like the Strict switch (session-strict.ts).
// `thinkingBudget` is the odd one out and deliberately so: OFF does not disable thinking, it removes the
// CAP on it (the reasoning-budget controller stops monitoring and the model reasons to its own stop).
// It exists so a budget change can be A/B'd in one chat without touching the instance default.
// `surgicalEdits` and `askBeforeChanges` are the two former permission MODES, demoted to switches so the
// mode picker can stay three plain postures (Analyze · Build · YOLO). Both default OFF: they NARROW the
// active mode (deny a full-file overwrite / turn changes into consent) and never widen it.
// `safeMode` is the third of that kind and the opt-in half of the owner's 2026-07-30 directive
// (*"unattended bash should be allowed by default, unless the user have enabled safe mode in tuning"*):
// ON puts an UNATTENDED chain's host execution back behind sandbox confinement, and refuses on a host
// with no backend. Also default OFF, and also narrowing-only — see `session/config-resolve.ts`
// §SAFE MODE for the three things it deliberately is NOT.
// ⚠️ Every member of this union carries `prompt.features.<name>.title`/`.description` in the `en`
// bundle, and every feature the composer RENDERS is a member (the reverse does not hold — the panel
// deliberately omits `thinkingBudget`, which moved to Settings → Models). Both directions are pinned
// by `packages/core/test/session-safe-mode.test.ts`, because a switch the kernel accepts while no
// surface offers it is the ruling-2 shape safe mode itself was caught in.
export const Name = Schema.Literals([
  "introspection",
  "quality",
  "affective",
  "thinkingBudget",
  "surgicalEdits",
  "askBeforeChanges",
  "safeMode",
  "contextBudget",
])
export type Name = typeof Name.Type

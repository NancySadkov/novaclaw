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
export const Name = Schema.Literals(["introspection", "quality", "affective", "thinkingBudget"])
export type Name = typeof Name.Type

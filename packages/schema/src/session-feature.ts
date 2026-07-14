export * as SessionFeature from "./session-feature"

import { Schema } from "effect"

// The per-session harness-feature toggles (the composer's Tuning control). Each is a tri-state
// override on the session row: true/false = this chat's explicit stance, absent (NULL) = inherit
// (parent chain, then the matching global config block's `enabled`). The feature INTERNALS
// (cadence, commands, mood engine tuning, …) stay global-only — per-session we surface exactly
// the on/off a user tunes per task, like the Strict switch (session-strict.ts).
export const Name = Schema.Literals(["introspection", "quality", "affective"])
export type Name = typeof Name.Type

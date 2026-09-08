import type { SkillDraft } from "../effect/skill.js"
import type { SkillV2Source } from "@novaclaw/sdk/v2/types"
import type { Declarative, Hooks } from "./registration.js"

export type { SkillDraft }

export type SkillHooks = Hooks<{
  transform: SkillDraft
}> &
  /** The marshallable form — see the effect SDK's `declaration.ts`. */
  Declarative<SkillV2Source>

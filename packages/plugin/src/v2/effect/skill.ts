import type { SkillV2Source } from "@novaclaw/sdk/v2/types"
import type { Effect, Scope } from "effect"
import type { Registration } from "./registration.js"
import type { Hooks } from "./registration.js"

export interface SkillDraft {
  source(source: SkillV2Source): void
  list(): readonly SkillV2Source[]
}

export type SkillHooks = Hooks<{
  transform: SkillDraft
}> & {
  /**
   * The marshallable form — see `declaration.ts`. Skills are an append-only list of SOURCES with no
   * id to patch or remove by, so the declaration is the list itself: there is no op vocabulary to
   * invent here, and inventing one would describe a domain that does not exist.
   */
  readonly declare: (sources: readonly SkillV2Source[]) => Effect.Effect<Registration, never, Scope.Scope>
}

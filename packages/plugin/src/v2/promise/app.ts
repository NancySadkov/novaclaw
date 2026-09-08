import type { Registration } from "./registration.js"
import type { AppDeclaration } from "../effect/app.js"

export type { AppDeclaration, AppOpen } from "../effect/app.js"

export interface AppHooks {
  readonly declare: (items: readonly AppDeclaration[]) => Promise<Registration>
}

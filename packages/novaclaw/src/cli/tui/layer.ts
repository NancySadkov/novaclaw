import { run as runTui, type TuiInput } from "@novaclaw/tui"
import { Global } from "@novaclaw/core/global"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(Global.defaultLayer))
}

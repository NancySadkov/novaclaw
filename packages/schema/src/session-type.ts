export * as SessionType from "./session-type"

import { Schema } from "effect"

// The kernel thread-model session TYPE (K1 / the Vision's typed threads): how a session decides
// whether to keep running. interactive = blocks on user input · sub-agent = blocks on its
// supervising agent · auto-prompting = runs itself until exit() · goal-oriented = loops until
// state == goal (must carry budget caps). Undefined on a record means "interactive" (the default
// for user-created sessions); the spawner defaults its children to "sub-agent".
export const Info = Schema.Literals(["interactive", "sub-agent", "auto-prompting", "goal-oriented"])
export type Info = typeof Info.Type

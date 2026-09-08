export * as AppEvent from "./app-event"

import { Schema } from "effect"
import { Event } from "./event"

// The B14 home-app registry event: a manifest was registered/updated (by the agent tool or the
// HTTP endpoint). Clients refetch the persisted-manifest list when they see it.
export const Registered = Event.define({
  type: "app.registered",
  schema: {
    id: Schema.String,
    title: Schema.String,
  },
})

export const Definitions = Event.inventory(Registered)

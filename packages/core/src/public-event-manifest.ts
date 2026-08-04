export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@novaclaw/schema/event"
import { EventManifest } from "@novaclaw/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)

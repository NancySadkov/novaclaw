import { Model } from "@novaclaw/schema/model"

// WHICH MODEL a colleague thinks with.
//
// 🔴 **The model belongs to the COLLEAGUE, not to the chat** (owner: the picker moves into the
// agent's configuration). A chat-scoped model was coherent when a chat was the unit; under the
// roster it means the same colleague answers cleverly in one conversation and poorly in the next,
// for reasons the user cannot see. A colleague has one mind.
//
// How the model is written in config: `providerID/id`. Both directions live in @novaclaw/schema next to
// Model.Ref — this file's copies spelled the key `modelID`, so every call site had to rename `id` to
// `modelID` on the way in and back on the way out, and the runner's identical parser could not be reused.
export const modelRef = Model.formatRef
export const parseModelRef = Model.parseRef

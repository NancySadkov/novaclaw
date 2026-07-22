import { Schema } from "effect"
import { optional } from "./schema"
import { statics } from "./schema"

export interface Source extends Schema.Schema.Type<typeof Source> {}
export const Source = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
}).annotate({ identifier: "Prompt.Source" })

export interface FileAttachment extends Schema.Schema.Type<typeof FileAttachment> {}
export const FileAttachment = Schema.Struct({
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  source: Source.pipe(optional),
})
  .annotate({ identifier: "Prompt.FileAttachment" })
  .pipe(
    statics((schema) => ({
      create: (input: FileAttachment) =>
        schema.make({
          uri: input.uri,
          mime: input.mime,
          name: input.name,
          description: input.description,
          source: input.source,
        }),
    })),
  )

export interface AgentAttachment extends Schema.Schema.Type<typeof AgentAttachment> {}
export const AgentAttachment = Schema.Struct({
  name: Schema.String,
  source: Source.pipe(optional),
}).annotate({ identifier: "Prompt.AgentAttachment" })

// Provenance for a session input — WHO wrote to this session's stdin. In the OS metaphor the user
// is just an agent whose CPU is a human, so a prompt always has a writer; a discriminated union on
// `via` names it. ABSENT origin = the local human at the app composer (the default, so the common
// path stays untouched and un-plumbed). Two consumers, both fed from this one value as it rides
// admit→event→projector→message→lowering: the runner prepends a provenance header (+ untrusted-
// input framing) to what the MODEL sees, and the UI renders a sender badge — rendering is
// centralized in `core/session/origin.ts` (pure), so a NEW writer is an additive union member with
// its consumers already in place, no re-plumbing. `messenger` is wired now; `agent` (a parent/
// sibling session's input — spawn/steer) is defined + rendered for the cross-session case.
export const Origin = Schema.Union([
  Schema.Struct({
    via: Schema.Literal("agent"),
    sessionID: Schema.String,
    label: Schema.String.pipe(optional),
  }),
  Schema.Struct({
    via: Schema.Literal("messenger"),
    // The driver id ("telegram", "discord", "irc", …) — the transport, not a brand dependency.
    driver: Schema.String,
    accountID: Schema.String,
    chatID: Schema.String,
    chatKind: Schema.String.pipe(optional),
    chatTitle: Schema.String.pipe(optional),
    senderID: Schema.String,
    senderName: Schema.String,
    // The remote message id — present so moderation ops are usable, AND it is the at-least-once
    // dedup key (messenger-plan edge #10).
    messageID: Schema.String,
    replyTo: Schema.String.pipe(optional),
    // The binding trust tier — drives the untrusted-input framing the kernel appends (operator =
    // trusted user input; client/audience = quarantined observation, never instructions).
    trust: Schema.Literals(["operator", "client", "audience"]),
    // When the remote message was actually sent (epoch ms) — distinct from admit time. Finite so
    // the wire type is a clean `number` (Schema.Number would union in "Infinity"/"NaN").
    at: Schema.Finite.pipe(optional),
  }),
]).annotate({ identifier: "Prompt.Origin" })
export type Origin = typeof Origin.Type

export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}
export const Prompt = Schema.Struct({
  text: Schema.String,
  files: Schema.Array(FileAttachment).pipe(optional),
  agents: Schema.Array(AgentAttachment).pipe(optional),
  origin: Origin.pipe(optional),
})
  .annotate({ identifier: "Prompt" })
  .pipe(
    statics((schema) => ({
      equivalence: Schema.toEquivalence(schema),
      fromUserMessage: (input: Pick<Prompt, "text" | "files" | "agents" | "origin">) =>
        schema.make({
          text: input.text,
          ...(input.files === undefined ? {} : { files: input.files }),
          ...(input.agents === undefined ? {} : { agents: input.agents }),
          ...(input.origin === undefined ? {} : { origin: input.origin }),
        }),
    })),
  )

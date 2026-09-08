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
  /**
   * The attachment's ORIGINAL local identity, when `uri` carries materialized bytes instead of a
   * path. The CLI inlines small files as a bounded `data:` URI so the provider payload is
   * self-contained; without this field that inlining silently destroys the only evidence that the
   * bytes came from a file on disk, and the agent may then overwrite the user's own source without
   * being asked. Optional because a genuinely sourceless attachment (a paste, a screenshot) has no
   * local identity to record.
   */
  sourceUri: Schema.String.pipe(optional),
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
          sourceUri: input.sourceUri,
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
    /**
     * HOW the sender stands to the receiver (AGENTS.md — the structural metaphor).
     *
     * 🔴 `parent` is a delegation: a sub-agent's work was assigned to it, and its own turn ends by
     * handing a result back up. `peer` is a colleague asking a colleague — nobody is above anybody,
     * and the receiver answers in its own chat on its own terms. The distinction is not cosmetic:
     * the rendered header tells the receiving MODEL which it is, and this attribution is durable in
     * the transcript. Calling a peer a parent teaches the receiver that the sender outranks it —
     * the same class of misattribution `compaction.ts`'s STEER_LABEL exists to prevent.
     *
     * Absent means `parent`, which is what every writer meant before officers could talk to each
     * other.
     */
    relation: Schema.Literals(["parent", "peer"]).pipe(optional),
    /**
     * How many colleague hand-offs deep this message is, with nobody outside the chain.
     *
     * 🔴 The loop bound's carrier (`session/colleague-bound.ts`). It rides HERE rather than in a side
     * table for the same reason `relation` does: the transcript is the record, one stream per agent,
     * and a counter kept anywhere else can disagree with what actually happened. A receiver reading
     * its own inbox can therefore always answer "how far from a person am I?"
     *
     * Absent means zero — a first hand-off, or any message a writer that predates the bound produced.
     *
     * ⚠️ `Finite`, not `Number`: the plain form encodes as `number | "NaN" | "Infinity" | "-Infinity"`
     * on the wire (seen in the regenerated SDK types), and a hop count that can arrive as `Infinity`
     * is a bound with a hole in it. Matches `SpawnResultMessage.depth`, which is the same kind of
     * number for the same reason.
     */
    hops: Schema.Finite.pipe(optional),
    /**
     * The agent ids this chain has passed through, in order, each sender appended at its own hop.
     *
     * 🔴 **`hops` is a NUMBER, so `A→B→C→A` is indistinguishable from `A→B→C→D`.** A cycle is caught
     * only when the cap fires — roughly two laps late — and nobody is ever told it WAS a cycle, so
     * the refusal reads as "too deep" and the loop looks like ordinary depth. A path makes the
     * difference decidable at the hop that would close it, which is the standard answer everywhere
     * else: BGP drops a route whose `AS_PATH` already contains its own AS, SIP loop-detects from
     * `Via`, mail counts `Received:`.
     *
     * ⚠️ **Absent means EMPTY, exactly as `hops` absent means zero.** Every message written before
     * this field existed then reads as a fresh chain rather than an unknown one, which is the
     * permissive direction — a bound must not refuse a hand-off because it could not see the path.
     *
     * ⚠️ **Across P2P this is UNTRUSTED and the check is best-effort.** A peer strips or forges it
     * for free (A2A carries no hop or depth field at all), so between instances the rate window and
     * the hop cap remain the real bound. Saying so is the honest description of what this delivers.
     */
    path: Schema.Array(Schema.String).pipe(optional),
    /**
     * The GROUP EXCHANGE this message belongs to, if it is one.
     *
     * 🔴 A conference has no session of its own, and that is the design rather than an omission.
     * Agents and sessions are the same first-class entity (owner, 2026-08-23), so a session with no
     * personality would re-introduce the split the merge exists to remove — and giving a participant
     * a second stream is the very thing *"maintaining the agent's ego and consciousness instead of
     * splitting it among several streams"* forbids. A group is therefore a FAN-OUT: the same message
     * lands in each participant's own chat, and this id is what makes those copies one conversation.
     *
     * It rides HERE for the reason `hops` does: the transcript is the record, one stream per agent,
     * and membership kept in a side table can disagree with what actually happened. It also means a
     * receiver reading its own inbox can answer "who else heard this?" without querying a chat it
     * does not own — which, under one-stream-per-agent, it cannot do.
     *
     * Absent means an ordinary 1:1 hand-off.
     */
    conversation: Schema.String.pipe(optional),
    /**
     * Everyone in the conference, by agent id, INCLUDING the sender.
     *
     * A receiver answers the group by fanning out to this set minus itself. Carrying the sender is
     * deliberate: the reply has to reach them too, and reconstructing "the set plus whoever wrote to
     * me" from two fields is how one of them ends up wrong.
     *
     * ⚠️ This is a BOUND-BEARING field, not a display list. A broadcast charges the colleague loop
     * bound once per recipient (`session/colleague-bound.ts`); a group of six that charged once would
     * turn one lap into six for the price of one.
     */
    participants: Schema.Array(Schema.String).pipe(optional),
    /**
     * This copy INFORMS the reader; it does not ask them anything.
     *
     * 🔴 A conference reply is copied to every bystander so the room stays a room. Those copies used
     * to be byte-identical to an ask — same `via`, same `relation: "peer"`, same label — with the
     * difference living only in the NOTE's wording. So `colleague-stall.ts`, which finds an ask by
     * looking for a peer message nobody answered, read every announce copy as an unanswered
     * question: each bystander who (correctly) said nothing minted a false stall notice back at the
     * replier, whose *"ask again"* then woke the room — the exact amplification the announce
     * discipline exists to remove. And a stall notice that fires on healthy traffic teaches models to
     * ignore stall notices, which `ColleagueStall.AFTER_MS`'s own comment calls the fatal outcome.
     *
     * ⚠️ Absent means "a real hand-off", so every 1:1 exchange stays byte-identical to before.
     */
    announce: Schema.Boolean.pipe(optional),
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

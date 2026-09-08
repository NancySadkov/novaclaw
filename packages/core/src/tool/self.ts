export * as SelfTool from "./self"

import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Avatar } from "../agent/avatar"
import { PermissionV2 } from "../permission"
import { AgentWorkspace } from "../agent/workspace"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// A colleague reading its OWN configuration (owner, 2026-08-21: *"each agent should have an
// introspection tool, which would allow it to see their configuration — outside of name and folder,
// which are part of system prompt"*).
//
// 🔴 **Why an officer needs this at all.** Under the roster a colleague is a role record someone
// else edits: the user changes its model in a dialog, turns its memory off, gives it a step budget.
// The agent is never told. So a model asked "why did you forget that?" or "can you take on something
// bigger?" is guessing about its own constitution — and a guess about yourself reads to a user as a
// lie rather than as missing information.
//
// ⚠️ **Name and folder are NOT here**, and that is the owner's line, not an oversight: both are
// already in the system prompt, so repeating them through a tool would create two answers to one
// question — and the day the two disagree, the model has no way to know which is current.

export const name = "self"

export const description = `Look up your own configuration on this NovaClaw's roster — the model you think with, whether you keep memories, your step budget, your job title and personality, your portrait, and whether you may hand work to colleagues. Call this when a question is about YOU rather than about the work: why you did or did not remember something, whether you can take on a longer task, what you look like, or what you are set up to do. Your name and working folder are already in your prompt and are not repeated here.`

/** No arguments: a colleague's own profile is small, and there is nothing to filter on. */
export const Input = Schema.Struct({})

const PortraitImage = Schema.Struct({
  mime: Schema.String,
  data: Schema.String,
  hash: Schema.String,
})

const ModelOutput = Schema.Struct({
  title: Schema.optional(Schema.String),
  personality: Schema.optional(Schema.String),
  portrait: Schema.optional(PortraitImage),
  portraitGlyph: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  pinnedModel: Schema.optional(Schema.String),
  memory: Schema.optional(Schema.String),
  archiveChats: Schema.optional(Schema.Boolean),
  steps: Schema.optional(Schema.Number),
  canAddressColleagues: Schema.Boolean,
  workingInOwnScratch: Schema.Boolean,
})

export const Output = Schema.Struct({
  title: Schema.optional(Schema.String),
  personality: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  pinnedModel: Schema.optional(Schema.String),
  memory: Schema.optional(Schema.String),
  archiveChats: Schema.optional(Schema.Boolean),
  steps: Schema.optional(Schema.Number),
  canAddressColleagues: Schema.Boolean,
  workingInOwnScratch: Schema.Boolean,
})
export type Output = typeof Output.Type
type ModelOutput = typeof ModelOutput.Type

/**
 * The lines a model reads. Prose rather than JSON: this answers a question about the agent ITSELF,
 * and the sentence a model can quote back to its user is worth more than a struct it has to
 * describe. Every line states the consequence, not just the value — `memory: none` means nothing to
 * a model that has not been told what `none` does to it.
 */
export const toModelOutput = (output: Output): string => {
  const lines: string[] = []
  if (output.title) lines.push(`Your job here: ${output.title}.`)
  if (output.personality) lines.push(`How you are meant to come across: ${output.personality}`)
  const modelPortrait = output as Output & { readonly portraitGlyph?: string; readonly portrait?: unknown }
  if (modelPortrait.portraitGlyph) lines.push(`Your portrait is the glyph ${modelPortrait.portraitGlyph}.`)
  else if (modelPortrait.portrait) lines.push("Your instance-owned portrait is attached below.")
  if (output.model) {
    if (output.pinnedModel === output.model)
      lines.push(`You currently think with ${output.model}; your roster pins this model to you.`)
    else if (output.pinnedModel)
      lines.push(
        `You currently think with ${output.model}. Your roster pins ${output.pinnedModel}, so this turn resolved to a different model.`,
      )
    else
      lines.push(
        `You currently think with ${output.model}. Your roster has no model pin; this is the instance's current default model as resolved for this turn.`,
      )
  } else lines.push(`NovaClaw could not identify the model running this turn.`)
  lines.push(
    output.memory === "none"
      ? `You are a THROWAWAY: you remember nothing between chats and nothing you are told is kept. Say so if you are asked to remember something.`
      : `You keep your own memories, private to you — no other colleague reads them.` +
          (output.archiveChats === false
            ? ` Your compacted conversations are NOT archived, so anything that scrolls out of this chat is gone.`
            : ` Compacted conversations are archived into your memory, so you can search them later.`),
  )
  if (output.steps !== undefined) lines.push(`You may take up to ${output.steps} steps in one turn.`)
  lines.push(
    output.canAddressColleagues
      ? `You may hand work to colleagues with the \`colleague\` tool.`
      : `You cannot address other colleagues; work that is not yours goes back to the user.`,
  )
  if (output.workingInOwnScratch)
    lines.push(`You are working in your own scratch folder — the user has not pointed you at a project.`)
  return lines.join("\n")
}

export const toModelContent = (output: ModelOutput) => [
  {
    type: "text" as const,
    text: toModelOutput(output),
  },
  ...(output.portrait === undefined
    ? []
    : [{ type: "file" as const, data: output.portrait.data, mime: output.portrait.mime, name: "your-portrait" }]),
]

/**
 * May this colleague address ANY of its colleagues right now?
 *
 * ⚠️ ANY, not "all". A rule may name one colleague — *"may ask the bookkeeper, not the trader"* — and
 * the field this feeds decides whether the model is told about delegation at all. Evaluating against
 * `resource: "*"` would answer "may address EVERY colleague" and report `false` for a colleague that
 * can perfectly well address one, which is the same lie in the other direction.
 *
 * ⚠️ The resource is the COLLEAGUE'S ID, matching what `tool/colleague.ts` actually asserts. Asking a
 * different question here than the call asks is how this field drifted from the truth in the first
 * place.
 *
 * 🔴 It asks what a REAL CALL would answer, through `PermissionV2.ask` — which composes everything:
 * the agent ruleset, the mode overlay, saved answers, the project file. An earlier version evaluated
 * the agent's rules alone and said so, on the belief that `ask` records a pending request and so a
 * capability REPORT could not use it. That was STALE: `ask` stopped creating pending records when
 * `evaluateInput` lost its "ask" outcome (owner ruling 2026-08-20), and its own comment says so. It
 * is a read-only evaluation now, so the report and the call cannot disagree.
 */
export const addressableByMe = (input: {
  readonly own: { readonly paused?: boolean | undefined }
  readonly selfID: string
  readonly roster: ReadonlyArray<{ readonly id: string; readonly mode?: string | undefined; readonly hidden?: boolean }>
  /** What a REAL call would answer for this colleague — see the note above. */
  readonly verdict: (colleague: string) => Effect.Effect<boolean>
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    // A paused colleague is answered deny-`*` by the evaluator whatever its rules say. Asking per
    // colleague would reach the same answer, but short-circuiting says why in one line.
    if (input.own.paused === true) return false
    for (const peer of input.roster) {
      if (String(peer.id) === input.selfID || !AgentV2.isColleague(peer)) continue
      if (yield* input.verdict(String(peer.id))) return true
    }
    return false
  })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const agents = yield* AgentV2.Service
    const permission = yield* PermissionV2.Service

    // `.orDie` like every other builtin: a tool that cannot REGISTER is a boot-time defect, not a
    // condition a turn can handle. Without it the registration error rides the layer's error channel
    // into the location graph and surfaces somewhere unrelated — it landed on `V2Session.spawn`.
    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: ModelOutput,
          structured: Output,
          toStructuredOutput: ({ output }) => {
            const { portrait: _portrait, portraitGlyph: _portraitGlyph, ...structured } = output
            return structured
          },
          toModelOutput: ({ output }) => toModelContent(output),
          // Read through to the LIVE roster on every call (ruling 3): a colleague reconfigured mid-chat
          // must answer with what it is now, not with a snapshot taken when the tool was registered.
          // That is the whole point — the user edits the dialog and the agent is not otherwise told.
          execute: (_input, context) =>
            Effect.gen(function* () {
              const id = String(context.agent ?? "")
              const modelRef = context.model ? `${context.model.providerID}/${context.model.id}` : undefined
              const model = context.model
                ? context.model.name && context.model.name !== context.model.id
                  ? `${context.model.name} (${modelRef})`
                  : modelRef
                : undefined
              const own = id === "" ? undefined : yield* agents.get(AgentV2.ID.make(id))
              const roster = yield* agents.all()
              if (own === undefined)
                return {
                  ...(model === undefined ? {} : { model }),
                  canAddressColleagues: false,
                  workingInOwnScratch: false,
                } satisfies Output
              const record = own as unknown as Record<string, unknown>
              const pinnedModelRef = own.model ? `${own.model.providerID}/${own.model.id}` : undefined
              const pinnedModel = pinnedModelRef === modelRef ? model : pinnedModelRef
              const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : undefined)
              const portrait = yield* Effect.promise(() => Avatar.portrait(id, text("avatar"), text("name")))
              return {
                ...(text("title") === undefined ? {} : { title: text("title")! }),
                ...(text("personality") === undefined ? {} : { personality: text("personality")! }),
                ...(model === undefined ? {} : { model }),
                ...(pinnedModel === undefined ? {} : { pinnedModel }),
                ...(text("memory") === undefined ? {} : { memory: text("memory")! }),
                ...(typeof record["archiveChats"] === "boolean" ? { archiveChats: record["archiveChats"] } : {}),
                ...(typeof record["steps"] === "number" ? { steps: record["steps"] } : {}),
                ...(portrait.kind === "glyph"
                  ? { portraitGlyph: portrait.text }
                  : portrait.kind === "placeholder"
                    ? {
                        portraitGlyph: `server-owned placeholder portrait marked ${Avatar.placeholderLabel(id, text("name"))}`,
                      }
                    : {
                        portrait: {
                          mime: portrait.mime,
                          data: Buffer.from(portrait.bytes).toString("base64"),
                          hash: portrait.hash,
                        },
                      }),
                // Read from the RULESET rather than from the agent's id: "may this colleague delegate"
                // is a permission question, and answering it from a name would go stale the moment the
                // floor changes (it did, twice, on 2026-08-21).
                //
                // 🔴 …and answered by the EVALUATOR, not by `some(effect === "allow")`. That scan got
                // three things wrong at once, all in the direction of promising what a call then
                // refuses: it ignored rule ORDER (a later deny never won, though `evaluate` is
                // `findLast` precisely so it does), it ignored WILDCARDS (an `action: "*"` deny was
                // invisible to an `=== "colleague"` test), and it ignored the PAUSED deny-all
                // (`permission.ts` answers deny-`*` for a set-aside colleague, which no configured
                // rule reflects).
                canAddressColleagues: yield* addressableByMe({
                  own,
                  selfID: id,
                  roster,
                  verdict: (colleague) =>
                    permission
                      .ask({
                        action: "colleague",
                        resources: [colleague],
                        save: ["*"],
                        sessionID: context.sessionID,
                        agent: context.agent,
                        source: {
                          type: "tool" as const,
                          messageID: context.assistantMessageID,
                          callID: context.toolCallID,
                        },
                      })
                      .pipe(
                        Effect.map((result) => result.effect === "allow"),
                        // A capability REPORT must not fail a turn. An unanswerable question reads as
                        // "no", which is the direction that cannot mislead: the model tries, and the
                        // real call gives it the real answer.
                        //
                        // ⚠️ DEFECTS too, not only failures. In a session worker `permission.ask` is
                        // `Effect.die("permission request inspection is host-only…")`, which sails
                        // straight past `orElseSucceed` — so this guard read as present while the tool
                        // crashed, and the internal sentence reached the model, which relayed it to the
                        // user as its own refusal. Measured 2026-09-02 against a live instance.
                        Effect.catchDefect(() => Effect.succeed(false)),
                        Effect.orElseSucceed(() => false),
                      ),
                }),
                workingInOwnScratch: AgentWorkspace.isOwnScratch({ agentID: id, directory: text("directory") }),
              } satisfies Output
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/self",
  layer,
  deps: [ToolRegistry.node, AgentV2.node, PermissionV2.node],
})

/**
 * `permission` — Auto mode: the agent sets its own permission level, in writing, and OWNS it.
 *
 * todo/permissions.md, in the owner's framing: *a mode where the model itself raises and lowers its
 * permissions explicitly, acknowledging that it now owns them — so it is grounded to be extra
 * careful, because the commitment is on a page it wrote itself.*
 *
 * AGENTS.md pitfall #1 states the law: **informational levers engage, mechanical ones convert.**
 * The required written justification is the informational half and it is the *point*; the ceiling is
 * the mechanical half and it is what makes the feature safe. Both ship here, or this would be
 * `yolo` with extra prose.
 *
 * ── AUTO IS NOT A SIXTH RUNG ───────────────────────────────────────────────────────────────────
 *
 * `MODE_RANK` gains no member and `MODE_RULES` gains no entry. This tool moves a session inside a
 * `[floor, ceiling]`; the ladder and `moreRestrictive` stay king. The algebra, and the argument for
 * why a self-grant cannot widen anything, live in `session/config-resolve.ts` §AUTO MODE — read that
 * before changing a line here.
 *
 * ── WHERE THE CEILING IS, AND WHY A SESSION CANNOT MOVE IT ─────────────────────────────────────
 *
 * The ceiling is **not stored anywhere new**. It is
 *
 *     min( this session's chain-RESOLVED `permissionMode` · the attendance cap · every ancestor's
 *          own self-grant )
 *
 * and the first term is the `session.permission_mode` column, whose only writers are the user's own
 * surfaces — `SessionV2.switchMode` (the composer's mode picker), session create, `spawn`, `fork`.
 * **This tool never writes that column**, which is the whole reason it is a separate store: an agent
 * that can raise its own ceiling has no ceiling.
 *
 * ⚠️ And the guarantee does not rest on this file being correct. `PermissionV2`'s evaluator folds the
 * grant in with `moreRestrictive`, so even a grant of `yolo` forged into the map leaves an `ask`
 * session at `ask`. This file decides what is *reported* and what is *asked about*; the boundary
 * itself is one `moreRestrictive` call one layer down.
 *
 * ── THE CONSENT PATH — one, and it is the existing one ─────────────────────────────────────────
 *
 * *"above a configured rung it routes through the existing permission ask — do not invent a second
 * consent path."* The configured rung is `ASSERT_ABOVE` (`bypass`), so exactly one raise asserts: a
 * return to **`yolo`**, the one level that reaches outside the working folder. It spends
 * `permission_privileged`, a SEPARATE action from the tool's own `permission` — the `configure`
 * precedent (`tool/configure.ts`), and for the same reason: a user (or an agent ruleset) can allow
 * self-management with one rule while granting no path back to `yolo`.
 *
 * ⚠️ **Why the other raises deliberately do NOT ask, which is a correction to the item's own
 * sizing.** A raise can never exceed what the user picked for this chat, so every raise below
 * `yolo` returns the session to a level the user had already granted — there is nothing left to
 * consent to. Putting a card there would be worse than redundant: an UNATTENDED chain has nobody to
 * answer it (`evaluateInput`'s `unattended-unanswerable` arm refuses it outright), so an unattended
 * agent that dropped itself to `plan` for a read phase could never climb back and would spend the
 * rest of the run refused. That is the *"it will raise and then fail"* pathology, built in on
 * purpose. The card is spent where it buys something.
 *
 * ── AND THE MODEL IS THE INJECTABLE PARTY ──────────────────────────────────────────────────────
 *
 * A skill description, a web page, a messenger correspondent or a file in the repo can all ask the
 * agent to raise itself. The three mitigations, and their honest status here:
 *  · **the ceiling** — mechanical, above; an injected raise gets at most the mode the user picked;
 *  · **the written justification** — required, refused when blank or perfunctory, and it lands in
 *    the transcript as this tool call's own input;
 *  · **the visible record** — the tool call and this tool's returned text are both durable session
 *    message parts, so the move and its reason are in the chat. ⚠️ The item asks for a *first-class
 *    card* rather than a tool blob; that needs a `SessionEvent` variant, a projector arm and a
 *    renderer, which is a different unit. Named here rather than quietly skipped.
 */
export * as PermissionTool from "./permission"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import {
  attendedRoot,
  autoCeiling,
  AUTO_UNATTENDED_CEILING,
  autoResolvedMode,
  chainAutoGrant,
  EFFECTIVE_CONFIG_DEFAULTS,
  modeRank,
  moreRestrictive,
  resolveSessionConfig,
  rootAttendance,
  type PermissionMode,
} from "../session/config-resolve"
import type { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "permission"

/** The action a raise above `ASSERT_ABOVE` spends. Separate from the tool's own `permission` action
 *  so one allow-rule can permit self-management without permitting a return to `yolo`. */
export const PRIVILEGED_ACTION = `${name}_privileged`

/** Raising to a rung ABOVE this one routes through the existing permission ask. See the header for
 *  why it sits at `bypass` and not lower. A constant so the test can flip it and watch the card
 *  appear (and disappear) rather than asserting a hardcoded verdict. */
export const ASSERT_ABOVE: PermissionMode = "bypass"

/** A justification shorter than this is not a justification. Empty is refused unconditionally; this
 *  is the floor under "and it must actually say something". */
export const MIN_JUSTIFICATION_CHARS = 12

/** What the user sees in the composer for each rung. Kept beside the internal value in every message
 *  this tool emits, because the transcript is read by the USER, for whom `bypass` is called "Build"
 *  (`app/src/i18n/en.ts` — the mapping lives there and nowhere else, so this quotes it rather than
 *  importing across the package boundary). */
export const MODE_LABEL: Readonly<Record<PermissionMode, string>> = {
  plan: "Analyze",
  ask: "Ask",
  surgical: "Surgical",
  bypass: "Build",
  yolo: "YOLO",
}

/** One line per rung, in the model's own operational terms. */
export const MODE_MEANING: Readonly<Record<PermissionMode, string>> = {
  plan: "read and search only — no edits, no new files, no shell, no js",
  ask: "every change and every shell command stops for the user's approval first",
  surgical: "precise edits and new files, but no whole-file overwrites",
  bypass: "act freely INSIDE this chat's working folder; outside it is still refused",
  yolo: "act freely anywhere on this computer, including outside the working folder",
}

const named = (mode: PermissionMode) => `${mode} ("${MODE_LABEL[mode]}")`

/** Whether a raise to `target` has to route through the permission ask. */
export const needsApproval = (target: PermissionMode): boolean => modeRank(target) > modeRank(ASSERT_ABOVE)

/**
 * Why this justification is not one, or `undefined` when it is. Blank is the hard rule the item
 * names; the length floor is what stops `"ok"` from buying a level.
 */
export const justificationProblem = (justification: string): string | undefined => {
  const trimmed = justification.trim()
  if (trimmed.length === 0)
    return "`justification` was empty. This tool exists so the reason is on the record in your own words — a level nobody can explain is a level you should not take."
  if (trimmed.length < MIN_JUSTIFICATION_CHARS)
    return `\`justification\` is too short (${trimmed.length} characters; at least ${MIN_JUSTIFICATION_CHARS} are required). Say what you are about to do and why this level is needed for it.`
  return undefined
}

// ── the decision (pure; unit-tested) ──────────────────────────────────────────────────────────

export type Op = "raise" | "lower"

export interface State {
  /** The mode the session runs at right now, self-grants included. */
  readonly current: PermissionMode
  /** The most this session may grant ITSELF. */
  readonly ceiling: PermissionMode
  /** The chain-resolved mode from the session rows — what the USER picked. */
  readonly resolvedMode: PermissionMode
  /** The chain ROOT's attendance answer, already collapsed. `"unknown"` counts as NOT attended. */
  readonly attended: boolean
}

export type Decision =
  /** Nothing was granted and nothing changed. `message` is the whole refusal. */
  | { readonly kind: "refused"; readonly message: string }
  /** The session already holds exactly this level. No write, and no false claim of one. */
  | { readonly kind: "unchanged"; readonly message: string }
  /** Grant it. `approval` means "assert first, and only write if the user says yes". */
  | { readonly kind: "granted"; readonly approval: boolean }

/**
 * The whole policy, as one pure function over an already-gathered `State`.
 *
 * ⚠️ Ruling 2 shapes every arm: a refused move says so and writes nothing; a move that would change
 * nothing is reported as unchanged rather than as a success; and each refusal names the bound that
 * actually bit, because "denied" alone sends a model into a retry loop.
 */
export const decide = (input: {
  readonly op: Op
  readonly target: PermissionMode
  readonly justification: string
  readonly state: State
}): Decision => {
  const { op, target, state } = input
  const problem = justificationProblem(input.justification)
  if (problem !== undefined)
    return { kind: "refused", message: `Your permission level is unchanged (${named(state.current)}). ${problem}` }

  const targetRank = modeRank(target)
  const currentRank = modeRank(state.current)

  if (targetRank === currentRank)
    return {
      kind: "unchanged",
      message:
        `Nothing changed: this chat is already at ${named(state.current)} — ${MODE_MEANING[state.current]}. ` +
        (modeRank(state.current) > modeRank(state.ceiling)
          ? `⚠️ You hold this level because the USER set it, and it is above what you may grant yourself here ` +
            `(${named(state.ceiling)}). If you lower yourself, you cannot come back to ${named(state.current)}.`
          : `Call this tool again only when you actually want a DIFFERENT level.`),
    }

  if (op === "raise" && targetRank < currentRank)
    return {
      kind: "refused",
      message:
        `Refused, and nothing changed (still ${named(state.current)}): ${named(target)} is LESS capable than ` +
        `${named(state.current)}, so that is a lowering, not a raise. Call it again with {"op":"lower"} if that is ` +
        `what you meant.`,
    }
  if (op === "lower" && targetRank > currentRank)
    return {
      kind: "refused",
      message:
        `Refused, and nothing changed (still ${named(state.current)}): ${named(target)} is MORE capable than ` +
        `${named(state.current)}, so that is a raise, not a lowering. Call it again with {"op":"raise"} if that is ` +
        `what you meant — raising is bounded, lowering is not.`,
    }

  // Lowering is always permitted and never asks (`plan` is rank 0, so no target below the floor
  // exists to refuse). Only a raise meets a ceiling.
  if (op === "raise" && targetRank > modeRank(state.ceiling)) {
    const reason =
      !state.attended && targetRank > modeRank(AUTO_UNATTENDED_CEILING)
        ? `this chain is UNATTENDED (or its root could not be read), and an unattended session may never grant ` +
          `itself more than ${named(AUTO_UNATTENDED_CEILING)} — nobody is present to say no, so the cap is not ` +
          `negotiable and no approval prompt can lift it.`
        : targetRank > modeRank(state.resolvedMode)
          ? `the user set this chat to ${named(state.resolvedMode)}, and you may never grant yourself more than the ` +
            `user picked. Ask the user to change the chat's permission mode if you genuinely need more.`
          : `a session above you in this chain lowered itself, and a child can never out-rank its chain.`
    return {
      kind: "refused",
      message:
        `Refused, and nothing changed (still ${named(state.current)}): ${named(target)} is above the most this ` +
        `chat may grant itself, which is ${named(state.ceiling)} — ${reason} You can still work at ` +
        `${named(state.ceiling)} or below.`,
    }
  }

  return { kind: "granted", approval: op === "raise" && needsApproval(target) }
}

/** The sentence a successful move returns. Separate from `decide` so the effectful path can report
 *  the same wording whether or not an approval card was answered on the way. */
export const grantedMessage = (input: {
  readonly op: Op
  readonly target: PermissionMode
  readonly previous: PermissionMode
  readonly justification: string
  readonly state: State
}): string =>
  [
    `Permission level ${input.op === "raise" ? "RAISED" : "LOWERED"} from ${named(input.previous)} to ` +
      `${named(input.target)} for this chat. You now own this level: ${MODE_MEANING[input.target]}.`,
    `You wrote: "${input.justification.trim()}"`,
    `The most this chat may grant itself is ${named(input.state.ceiling)}` +
      (input.state.attended
        ? ""
        : ` (this chain is unattended, so ${named(AUTO_UNATTENDED_CEILING)} is the hard cap)`) +
      `. Sessions you spawn from here can never out-rank you.`,
    // Ruling 2, in the direction that costs us something: never let the model believe it made a
    // durable change it did not make.
    `This level holds for this chat while the instance is running. It is NOT written to the chat's ` +
      `saved permission mode — if the instance restarts, the chat returns to ${named(input.state.resolvedMode)}, ` +
      `the mode the user picked.`,
  ].join(" ")

// ── the tool ──────────────────────────────────────────────────────────────────────────────────

const Mode = Schema.Literals(["plan", "ask", "surgical", "bypass", "yolo"])

export const Input = Schema.Struct({
  op: Schema.Literals(["raise", "lower"]).annotate({
    description:
      '"lower" to give up capability (always permitted, never asks), "raise" to take it back. The word must ' +
      "match the direction of `mode` on the ladder, or the call is refused.",
  }),
  mode: Mode.annotate({
    description:
      "The level you are taking, from least to most capable: plan (read only) · ask (every change asks the " +
      "user) · surgical (edits, no whole-file overwrites) · bypass (act freely inside this chat's folder) · " +
      "yolo (act freely anywhere on this computer).",
  }),
  justification: Schema.String.annotate({
    description:
      "WHY, in your own words — what you are about to do and why this level is needed for it. It goes on the " +
      "record for the user to read afterwards. It is required; a blank or perfunctory one is refused.",
  }),
})

const StructuredOutput = Schema.Struct({
  changed: Schema.Boolean,
  mode: Mode,
  previous: Mode,
  ceiling: Mode,
})
export const Output = Schema.Struct({ ...StructuredOutput.fields, message: Schema.String })
export type Output = typeof Output.Type

export const description =
  "Set YOUR OWN permission level for this chat, and own it. Lower yourself to the least capability the work " +
  "actually needs, and raise yourself back — in writing — when you need more. " +
  '{"op":"lower","mode":"plan","justification":"reading the codebase first; I will not change anything yet"} · ' +
  '{"op":"raise","mode":"bypass","justification":"the plan is agreed; I now need to edit src/ to apply it"}. ' +
  "LOWERING is always permitted and never asks. RAISING can never go above the mode the user picked for this " +
  "chat (and never above bypass when nobody is attending), so it is a way back to what you had, not a way " +
  "past it; the refusal names the bound when it bites. A `justification` is required on every call — that is " +
  "the point of the tool, not paperwork. The level applies to the very next tool call and to every session " +
  "you spawn afterwards; it does not survive an instance restart."

const failure = (message: string) => new ToolFailure({ message })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const sessions = yield* SessionStore.Service
    const get = (id: string) => sessions.get(id as SessionSchema.ID)

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            description,
            input: Input,
            output: Output,
            structured: StructuredOutput,
            toStructuredOutput: ({ output }) => ({
              changed: output.changed,
              mode: output.mode,
              previous: output.previous,
              ceiling: output.ceiling,
            }),
            toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const sessionID = String(context.sessionID)
                // `PermissionV2` refuses a missing session row before any allow; do the same here
                // rather than resolving a phantom chain to the global defaults and reporting a level
                // for a session that does not exist.
                const row = yield* sessions.get(context.sessionID)
                if (row === undefined)
                  return yield* failure("Nothing changed: this session has no record, so it has no permission level.")

                const resolved = yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, sessionID, get)
                const rootType = yield* rootAttendance(sessionID, get)
                // ANCESTORS only — this session's own grant is not part of its own ceiling, or a
                // lowering would be one-way. Starting the walk at the PARENT is what excludes it, and
                // it is one walk rather than two.
                const ancestorGrant =
                  row.parentID === undefined
                    ? undefined
                    : yield* chainAutoGrant(String(row.parentID), get, PermissionV2.autoGrantMode)
                const ownGrant = PermissionV2.autoGrantMode(sessionID)
                const chainGrant =
                  ownGrant === undefined
                    ? ancestorGrant
                    : ancestorGrant === undefined
                      ? ownGrant
                      : moreRestrictive(ownGrant, ancestorGrant)

                const state: State = {
                  resolvedMode: resolved.permissionMode,
                  attended: attendedRoot(rootType),
                  ceiling: autoCeiling({ resolvedMode: resolved.permissionMode, rootType, ancestorGrant }),
                  current: autoResolvedMode({
                    resolvedMode: resolved.permissionMode,
                    rootType,
                    grant: chainGrant,
                  }),
                }

                const decision = decide({
                  op: input.op,
                  target: input.mode,
                  justification: input.justification,
                  state,
                })
                const unchanged = {
                  changed: false,
                  mode: state.current,
                  previous: state.current,
                  ceiling: state.ceiling,
                }
                // A refusal is a ToolFailure (the model's error channel), an "already there" is a
                // normal result — they are different facts and collapsing them would tell a model it
                // failed when it simply had nothing to do.
                if (decision.kind === "refused") return yield* failure(decision.message)
                if (decision.kind === "unchanged") return { ...unchanged, message: decision.message }

                // The ONE consent path, and it is the existing one. `save` is scoped to the target
                // mode, never `*`: an "always" answer means "this agent may return to yolo", not "this
                // agent may do anything to its own permissions" (`configure.ts`'s per-key `save`).
                if (decision.approval)
                  yield* permission.assert({
                    action: PRIVILEGED_ACTION,
                    resources: [input.mode],
                    save: [input.mode],
                    metadata: {
                      from: state.current,
                      ceiling: state.ceiling,
                      justification: input.justification.trim(),
                    },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: {
                      type: "tool" as const,
                      messageID: context.assistantMessageID,
                      callID: context.toolCallID,
                    },
                  })

                // Only now — a refused card must leave the level exactly as it was.
                PermissionV2.setAutoGrant(sessionID, {
                  mode: input.mode,
                  justification: input.justification.trim(),
                  at: Date.now(),
                })
                return {
                  changed: true,
                  mode: input.mode,
                  previous: state.current,
                  ceiling: state.ceiling,
                  message: grantedMessage({
                    op: input.op,
                    target: input.mode,
                    previous: state.current,
                    justification: input.justification,
                    state,
                  }),
                }
              }).pipe(
                Effect.mapError((error) => {
                  if (error instanceof ToolFailure) return error
                  // A denial keeps its identity — including the unattended deny-fast wording, which is
                  // the one an unattended run actually needs to read. Prefixed with the fact that
                  // matters most to the model: nothing moved.
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return failure(`Your permission level is unchanged. ${denial}`)
                  return failure(
                    `Your permission level is unchanged. ${name} failed: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  )
                }),
              ),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/permission",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, SessionStore.node],
})

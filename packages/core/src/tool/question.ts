export * as QuestionTool from "./question"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "question"

export const description = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- When \`custom\` is enabled (default), a "Type your own answer" option is added automatically; don't include "Other" or catch-all options
- Answers are returned as arrays of labels; set \`multiple: true\` to allow selecting more than one
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`

export const Input = Schema.Struct({
  questions: Schema.Array(QuestionV2.Prompt).annotate({ description: "Questions to ask" }),
})

export const Output = Schema.Struct({
  answers: Schema.Array(QuestionV2.Answer),
})
export type Output = typeof Output.Type

export const toModelOutput = (
  questions: ReadonlyArray<QuestionV2.Prompt>,
  answers: ReadonlyArray<QuestionV2.Answer>,
) => {
  const formatted = questions
    .map(
      (question, index) =>
        `"${question.question}"="${answers[index]?.length ? answers[index].join(", ") : "Unanswered"}"`,
    )
    .join(", ")
  // ⚠️ When NOTHING was answered, saying "User has answered your questions" attributes the harness's
  // own words to the owner — ruling 2, in the one sentence the model actually reads. Since the tool
  // stopped waiting for a person (owner 2026-08-20), that is now the common case, and it has to say
  // so plainly rather than render empty answers as if they were replies.
  if (questions.length > 0 && answers.every((answer) => !answer?.length))
    return (
      `No one answered — this session runs without a person watching, and waiting would stall it. ` +
      `You asked: ${questions.map((question) => `"${question.question}"`).join(", ")}. ` +
      `Choose the most reasonable option yourself and carry on, saying which you chose. Put any notes, ` +
      `drafts or working files in your own project folder, which needs no permission. Only if the task ` +
      `genuinely cannot be finished without an answer, stop and name what you needed.`
    )
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const question = yield* QuestionV2.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        // What the model is told instead of an answer. Three things, in the order it needs them:
        // nobody is coming, decide anyway, and where to put working files — the owner's "use scratch
        // for such menial tasks". The last clause is the escape for the case the ruling carves out:
        // a task that genuinely cannot proceed (editing the registry, say) should END with the
        // blocker named, not loop asking.
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ input, output }) => [
            { type: "text", text: toModelOutput(input.questions, output.answers) },
          ],
          execute: (input, context) =>
            permission
              .assert({
                action: "question",
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(
                // 1J: consult `denialMessage` FIRST so a denial keeps its own identity — including a
                // reject's user feedback and the deny-fast wording an UNATTENDED run needs to learn
                // that retrying is pointless. The absorber this replaces ignored its error argument
                // and hardcoded "Permission denied: question", which was wrong in both directions.
                //
                // ⚠️ It was not merely lossy, it was FALSE. `assert` is typed
                // `Effect<void, PermissionV2.Error | SessionV2.NotFoundError>`, and `denialMessage`
                // answers every member of `PermissionV2.Error` (Denied — including its own
                // fallback branch — Rejected and Corrected). So the ONE error that reaches the
                // arm below is a vanished session, and the old string reported that as a permission
                // refusal: ruling 2, a fault described falsely. The fallback now claims nothing
                // about permissions, because at this seam it never is one.
                Effect.mapError((error) => {
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return new ToolFailure({ message: denial })
                  return new ToolFailure({ message: "Unable to ask the user" })
                }),
                // 🔴 NO LONGER WAITS FOR A PERSON (owner, 2026-08-20: "we no longer bother the
                // user"). This used to call `question.ask` and block until someone answered. Measured
                // run 19: the model asked at 21 files of 400 and the session sat on it for the
                // remaining twenty minutes — the third surface today whose failure is a blocking wait
                // for a human in a session that has none.
                //
                // The question itself is not lost: this tool call and its text are already in the
                // transcript, so anyone reading the session sees what the model wanted to ask. What is
                // gone is the stall.
                //
                // ⚠️ No timeout, deliberately. A bounded wait was tried earlier the same day and
                // wedged `permission.test.ts` — the timer fiber outlived the test body. An immediate
                // answer has no timer and no race.
                // Empty answers, because nothing WAS answered. `toModelOutput` turns that into a
                // sentence saying so and telling the model to decide — putting the guidance in the
                // answer slot would have rendered as "User has answered … = <our text>".
                Effect.map(() => ({ answers: input.questions.map(() => []) })),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/question",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, QuestionV2.node],
})

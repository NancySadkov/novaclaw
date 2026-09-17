export * as SystemCompose from "./system-compose"

import type { PermissionMode } from "../config-resolve"
import { ContextTemplate } from "../context-template"
import { XmlText } from "../../util/xml-text"
// Type-only, so this file stays pure: `InputCapabilities` is the structural shape `attachmentSupport`
// reads, and sharing it is what keeps the perception SECTION and the media GATE deciding from one
// declaration rather than two that can drift (ruling 6).
import type { InputCapabilities } from "./to-llm-message"

// The ordered assembly of the system-prompt parts, extracted from the runner (session/runner/llm.ts)
// so the composition — and especially the placement of the optional per-model PRE-PROMPT — is a pure
// unit, testable without executing the live runner.
//
// ⚠️ PLACEMENT of the model pre-prompt — an owner ruling, 2026-07-29, and re-based 2026-09-17.
// It is a distinct, clearly-labelled section that reads as "about this model". It now composes FIRST,
// because the shared persona baseline that used to lead the prompt is gone (owner, 2026-09-17: the
// working style is seeded into each officer's own prompt, `officer-prompt.ts`). The correction
// therefore colours everything below it — the officer's identity and job text first among those — and
// remains its own labelled block a reader can separate from them. It rides the same
// `.filter(non-empty)` as every other part, so an absent pre-prompt changes the composed prompt not
// at all.

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ NOTHING PER-TURN-VOLATILE MAY BE COMPOSED HERE (2026-08-05).
//
// Every part in this array is a token-prefix of the message history that follows it, so a part whose
// text changes between two consecutive turns of the SAME session throws away the server-side prefix
// cache for the whole request — system prompt AND transcript. Prefix caching is linear: the first
// differing token forfeits everything after it.
//
// Measured against the DGX Spark's DeepSeek V4 Flash server (notes/reports/ds4-q2-maintenance-2026-07-31.md), on a
// 13.5K-token prompt, cold prefill ≈ 1000 tok/s:
//
//     identical prompt re-sent .................. 15.1s -> 0.9s
//     same prefix, grown tail (an agent turn) ... 15.1s -> 0.3s
//     ONE token edited near the FRONT ........... 15.1s -> 12.9s   (i.e. no reuse at all)
//
// `memoryRecall` used to sit here, fifth of nine, ahead of the entire immutable base. It is recomputed
// every turn from the newest user message and then LLM-reranked, so its text (often merely its ORDER)
// changed on essentially every turn — which meant a coding session re-prefilled its whole prompt every
// single turn. It now rides the message TAIL instead (session/runner/llm.ts), after the append-only
// history, where a change costs only the tokens after it.
//
// The same rule is why `base` is an epoch-frozen baseline (context-epoch.ts) rather than a per-turn
// render, and why `tool/profile.ts` keys its availability predicate on the privacy switch alone. If
// you are adding a part here, it must be constant for the life of the session's context epoch.
// ─────────────────────────────────────────────────────────────────────────────

/** The header that makes the per-model pre-prompt read as "about this model" and keeps it from being
 *  mistaken for task instructions. ⚠️ Standing rule: *"do not make it a dumping ground."* */
export const MODEL_PREPROMPT_LABEL =
  "The following are user-authored corrections for this specific model's known behaviour (not task instructions):"

/**
 * Wrap a user-authored per-model pre-prompt as a distinct, labelled section — or `undefined` when
 * there is nothing to add, so it rides the composition filter and changes the prompt not at all. A
 * whitespace-only value is treated as empty (inert).
 */
export const modelPrePromptSection = (prePrompt: string | undefined): string | undefined => {
  const trimmed = prePrompt?.trim()
  return trimmed ? `${MODEL_PREPROMPT_LABEL}\n\n${trimmed}` : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT SCOPE — the guidance half of the owner's 2026-07-30 directive.
//
// Verbatim: *"the model should be instructed by a non-YOLO mode system that it should not modify
// any files outside of the project's folder."* It is the counterweight to the same directive's
// other half: unattended `bash` now runs on hosts with no sandbox backend (`agent-jail.ts`), and
// `bash`'s permission resource is the command STRING, which `permission.ts` says in its own words
// is not containment. So for the shell — and only for the shell — this instruction is the boundary
// until v0.3.0 ships a real one.
//
// ⚠️ Be honest about what that means, because AGENTS.md pitfall #1 states the law it is up against:
// *informational levers engage, mechanical ones convert.* This is an informational lever and it
// does not contain a hostile command. It is not, however, the only thing standing: every tool whose
// resource is a PATH — read/edit/write/create/trash/apply-patch, and `bash`'s own `workdir` — still
// goes through `LocationMutation.externalDirectoryPermission`, which asks in an attended chain and
// hard-denies in an unattended one. The gap this text covers is the command string, which no rule
// can see. Deleting the text would not make the product safer by being more honest; it would remove
// the one thing that reaches the party actually choosing the command.
//
// ⚠️ ABSENT IN `yolo`, and that is the whole reason the mode exists. `MODE_RULES.yolo` is the one
// overlay that ALLOWS `external_directory_write` outright — documented as "everything, incl.
// outside the project". A system prompt telling a yolo session to stay in its folder would
// contradict the posture the user deliberately picked, and a prompt that argues with the product's
// own settings teaches the model to discount both.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The project-scope rule, as the model reads it. Written to the 1P house style — say what is
 * allowed before what is not, name the escape hatch, and never imply the user is the threat.
 *
 * Three drafting choices that are load-bearing rather than stylistic:
 *  · READS are explicitly allowed. The default posture already permits them (`permission.ts`'s read
 *    baseline: *"reading outside the project folder is ordinary work — a toolchain, an SDK, a system
 *    header"*), and a prompt that forbade them would break real tasks while contradicting the
 *    evaluator — the model would then have to guess which of the two to believe.
 *  · It names WRITES by their verbs (create/modify/move/delete) rather than saying "don't touch
 *    anything", because the vague version is the one a model rationalises its way around.
 *  · It says what to do INSTEAD (ask, and let the user decide) rather than only refusing. An
 *    instruction with no route forward gets abandoned the moment a task seems to need it.
 *
 * 🔴 **The same rule, applied to a kernel instruction that did NOT survive.** A turn-CLOSING
 * instruction shipped and was cut the same day by its own pre-registered kill rule
 * (`notes/reports/turn-closing-instruction-killed-2026-08-11.md`). The defect it aimed at is still
 * open — a turn that stops on a tool call leaves the fold with nothing to show — so whatever is
 * tried next: **do not re-add a bare "be brief" line.** That is exactly the vague form this
 * instruction is written to avoid.
 */
export const PROJECT_SCOPE_INSTRUCTION =
  "Project scope: this session's working folder is your workspace.\n\n" +
  "You may READ anything you need outside it — a toolchain, an SDK, a system header, another " +
  "checkout. But do not CREATE, MODIFY, MOVE or DELETE any file outside that folder. Keep build " +
  "output, scratch files and notes inside it.\n\n" +
  "If a task genuinely needs a change outside the working folder, say what you need and why, and " +
  "let the user decide — do not make the change and report it afterwards. This is a rule of the " +
  "permission mode this chat is in, not a preference of yours to weigh against the task."

/**
 * The project-scope SECTION for a permission mode — the instruction in every mode except `yolo`,
 * and `undefined` (i.e. nothing at all, via the composition filter) in `yolo`.
 *
 * Takes the RESOLVED mode: `resolveSessionConfig` has already applied the narrowing keystone, so a
 * child of a non-yolo parent can never resolve to `yolo` and can never lose this section.
 */
export const projectScopeSection = (mode: PermissionMode): string | undefined =>
  mode === "yolo" ? undefined : PROJECT_SCOPE_INSTRUCTION

/**
 * Is this chat's working folder just the colleague's OWN scratch — i.e. was no project assigned?
 *
 * ⚠️ ONE predicate, because two sections now turn on it and a second copy is how they come to
 * disagree about whether a folder was assigned at all (the `SystemAccounting.BLOCKS` lesson: two
 * lists of one thing drift, and each looks right on its own).
 */
const isOwnScratch = (directory: string, scratch: string): boolean =>
  directory.replaceAll("\\", "/").toLowerCase() === scratch.replaceAll("\\", "/").toLowerCase()

/**
 * BOTH FOLDERS: the project this colleague is assigned to, and its own workspace.
 *
 * 🔴 Owner, 2026-08-22: *"the agent with an assigned folder has both scratch and the project
 * folders."* Assigning a colleague to a project used to take away the one place it could keep notes,
 * drafts and probes without asking anybody — `AgentWorkspace.folderFor` treated the two as
 * alternatives. AGENTS.md is explicit that scratch is how a model is meant to work: *"for menial
 * needs — notes, drafts, scratch — the model uses its own project folder, which requires no
 * permission."* An officer with nowhere to scribble ends up either asking permission to think, or
 * dropping its working files into the user's repository.
 *
 * ⚠️ **It must come AFTER `projectScope`, which says "keep build output, scratch files and notes
 * inside [the working folder]".** That sentence is right for a session whose only folder is the
 * project and wrong for a colleague that has a workspace of its own, so this section names the
 * exception explicitly rather than leaving a model to reconcile two rules. Both are kernel material
 * and a persona cannot bury either; the specific one lands last.
 *
 * ⚠️ Absent when the working folder IS the scratch folder — an unassigned colleague already works
 * there, and telling it "you also have somewhere else" would name the same directory twice.
 */
export const workspaceSection = (input: {
  readonly directory: string | undefined
  readonly scratch: string | undefined
}): string | undefined => {
  const scratch = input.scratch?.trim()
  const directory = input.directory?.trim()
  if (!scratch || !directory) return undefined
  if (isOwnScratch(directory, scratch)) return undefined
  return `You have a private workspace at ${scratch}. Use it for your temporary files, not intended for the user or the user's project.`
}

/**
 * That this colleague keeps NOTHING between chats, when that is true.
 *
 * 🔴 **The defect, measured live on holo3.1 2026-08-22.** A colleague configured `memory: "none"` was
 * asked *"remember this for later: the quarterly review is on the 14th"* and answered *"Yes, I've
 * stored the information."* It had written a TODO. Nothing had ever told it otherwise: the
 * disclosure existed only in the Contacts dialog, where it tells the USER, and in the `self` tool,
 * which a model only reads if it thinks to ask about itself. A model whose prompt says nothing about
 * memory will assume it has some, because almost every model it was trained on does.
 *
 * That is the roster's memory switch failing at the one thing it is for. A throwaway is supposed to
 * be honestly disposable — instead it accepted work it structurally could not do, and said so.
 *
 * ⚠️ **Only for `none`.** A colleague WITH memory needs no section: having memory is the assumption a
 * model already arrives with, and stating it would be dead text in nearly every prompt. Same rule as
 * `toolDiscoverySection`'s zero-count case — an instruction describing a state that is not this
 * session's is a false description, and the absent branch keeps an ordinary prompt byte-identical.
 *
 * ⚠️ Kernel material, so a persona or an agent prompt cannot bury it: whether anything survives this
 * conversation is a fact about the runtime, not a preference of the assistant's.
 */
export const memoryStanceSection = (input: {
  readonly memory: "own" | "none" | undefined
  readonly archiveChats: boolean | undefined
}): string | undefined => {
  if (input.memory === "none") return THROWAWAY_MEMORY_INSTRUCTION
  // ⚠️ The SECOND way a colleague can be wrong about its own recall, and it is the subtler one: it
  // keeps memories and can search them, so nothing in its experience says the older half of this
  // conversation is unreachable. `shouldArchive` already folds `memory: "none"` in above, so this
  // arm is only ever about a remembering colleague whose user turned archiving off.
  if (input.archiveChats === false) return NO_ARCHIVE_INSTRUCTION
  return undefined
}

/**
 * ⚠️ Says what is LOST and what still works, because half of it does. A colleague told only "your
 * conversations are not archived" would reasonably conclude its memory is off — it is not, and
 * `kb` still finds everything it deliberately remembered. Getting that wrong in the other direction
 * would make a working colleague refuse to look things up.
 */
const NO_ARCHIVE_INSTRUCTION =
  "This conversation is NOT archived. Your own memories are kept and you can still search them, but " +
  "the raw conversation is not: once it is compacted, whatever scrolled out of it is gone and you " +
  "will not be able to look it up later. If something said here matters beyond this chat, remember " +
  "it deliberately or write it somewhere durable — do not promise to find it again in the transcript."

const THROWAWAY_MEMORY_INSTRUCTION =
  "You have NO long-term memory. Nothing from this conversation is kept: when it ends, or is " +
  "compacted, everything you were told here is gone, and you will not have it in any future chat. " +
  "If you are asked to remember, note, or keep something for later, say plainly that you cannot and " +
  "that it needs to go somewhere durable — a file, or a colleague who does keep memories. Never " +
  "answer that you have stored, saved or noted something for later, because you have not."

/**
 * That the tool list is INCOMPLETE, and how to reach the rest.
 *
 * 🔴 **The defect (owner, 2026-08-11, on Holo-3.1):** asked *"what is the full list of tools you have
 * available?"*, the model listed the resident tools and never called `tool_search` — so it answered
 * confidently with a subset, and could not reach a capability that was installed the whole time.
 *
 * Nothing had ever told it otherwise. Deferred tools were disclosed in exactly ONE place —
 * `tool_search`'s own description — which is both jargon ("deferred tools") and circular: it says to
 * call it *"when the category manifest suggests a capability"*, and the category manifest is only
 * visible in the result of calling it. A model that has never called `tool_search` has no way to
 * learn that anything is missing. Answering from the visible list was the correct inference from the
 * information it had.
 *
 * ⚠️ **The COUNT is the load-bearing part, not the prose.** "Some tools may not be listed" is the
 * kind of hedge a model reasonably ignores; "there are 37 more" is a fact it can act on, and one the
 * reader can check. This is also why the section is absent when the count is zero — an instruction
 * describing tools that do not exist is a false description (ruling 2), and it would then be dead
 * text in every prompt that has no catalogue.
 *
 * ⚠️ Kernel material, so a custom persona or an agent prompt cannot drop it: the list being partial
 * is a fact about the runtime, not a preference of the assistant's.
 */
export const toolDiscoverySection = (deferredCount: number): string | undefined => {
  if (deferredCount <= 0) return undefined
  const count = `${deferredCount} more tool${deferredCount === 1 ? "" : "s"}`
  return (
    `Your tool list is PARTIAL. Beyond the tools defined in this request, ${count} ` +
    `${deferredCount === 1 ? "is" : "are"} installed and callable — their schemas are held back to keep ` +
    "this prompt small.\n\n" +
    "To reach them, call `tool_search` with a plain-language description of the capability you need " +
    '(for example "read a sqlite database", "take a screenshot", "send a message"). It returns their ' +
    "complete schemas; then call the tool you want by its exact name.\n\n" +
    "So when you are asked what you can do, or when no listed tool fits the task, search before you " +
    "answer or decline. Answering from the listed tools alone will be wrong."
  )
}

/**
 * The officer's durable objective, for an unattended / goal-oriented session.
 *
 * 🔴 Owner, 2026-09-16. The sentence names WHOSE goal it is, because provenance is the whole point of
 * having the block: *"the goal is something user or agent's Superior officer sets"*, and a colleague
 * that knows it did not author its own objective treats it differently from one that thinks it did.
 * The block exists only while the session is unattended — the mode switch adds and removes it.
 */
export const goalSection = (goal: string | undefined): string | undefined => {
  const text = goal?.trim()
  if (!text) return undefined
  return `Your durable goal, set for you by whoever assigned this work:\n\n${text}`
}

/**
 * The durable area, as the model reads it.
 *
 * Owner, 2026-09-16: *"Durable context area … Right after the agent's goal area … updated only after
 * compaction, from the housekeeped shadow copy."* The sketch is literal about the shape —
 * `<goal>`, then `#DURABLE`, then `Name: Value` lines, then the first user prompt — so the header is
 * the owner's own token rather than prose we invented for it.
 *
 * ⚠️ **The FRAMING line is ours, and it earns its place.** `#DURABLE` alone is a header a model has
 * to guess the meaning of, and the items are pointers it must maintain rather than prose it reads
 * once: the two tool names are what make the area editable by the model that owns it. That is
 * AGENTS.md principle 8 applied to a block whose whole audience is the agent — teach what it is for,
 * do not hope it infers the mechanism from the label.
 *
 * ⚠️ `undefined` for an empty area is not cosmetic: an empty block would be a header promising items
 * that are not there, and it would also differ from "this session has no durable area" for no reader.
 */
export const durableSection = (text: string | undefined): string | undefined => {
  const body = text?.trim()
  if (!body) return undefined
  return [
    "The durable area: short named items kept for you across a context rewrite, rebuilt from your `durable` items after each compaction. Maintain it with `durable_set` and `durable_clear`.",
    "",
    "#DURABLE",
    body,
  ].join("\n")
}

/**
 * That the model can SEE, and that an image on disk is therefore its own to look at.
 *
 * 🔴 **The defect (measured 2026-08-19, `notes/reports/vision-on-disk-2026-08-19.md`).** Asked
 * *"please rename each png glyph into proper name"* in a folder of six PNGs, Holo-3.1 called `bash
 * ls`, `glob`, `ls ../` and `ls ../icons/glyphs_256/` — **`read` zero times** — then said *"Since I
 * can't visually identify the icons"* and asked the user what they were. Told to call `read` by
 * name, the same model on the same instance described the file correctly. Every layer between the
 * file and the provider works: magic-byte MIME, the `{type:"file"}` part, the capability gate, the
 * untrusted-media frame, the `image_url` on the wire.
 *
 * ⚠️ **The harness had written only the NEGATIVE branch.** `unreadableToolMediaNotice` is a
 * carefully-drafted sentence for the model that CANNOT see, and there was no sentence at all for the
 * model that can — so the only statement about vision a model could ever receive was one saying it
 * had none. An absence teaches the negative. This is the same defect as `toolDiscoverySection`
 * above, one function away: a capability the runtime knew about and never disclosed, and a model
 * answering correctly from the information it had.
 *
 * ⭐ Codex closed the identical bug by REWORDING `view_image` (openai/codex#23949) after
 * openai/codex#12439 — *"view_image requires user to explicitly paste path to image"*. A hedged
 * capability description is read as a prohibition, which is why this section states the fact flatly
 * and names the tool.
 *
 * ⚠️ **ABSENT unless the catalog declares an `image` input modality**, so it is never a false
 * description (ruling 2) and never dead text on a text-only model. `undefined`/empty capabilities
 * mean *nobody told us* — the same tri-state `attachmentSupport` reads — and there the section stays
 * absent: an unmeasured local endpoint gets today's behaviour rather than a promise we cannot keep.
 *
 * ⚠️ **The delegation paragraph is gated on `spawn` being CALLABLE**, for the same reason: telling a
 * model to fan out through a tool its permission baseline withholds is an instruction it cannot
 * follow. `spawn` is deliberately outside `AMBIENT_SAFE_BASELINE`.
 *
 * ⚠️ Constant for the context epoch, as this file's header requires: it is derived from the resolved
 * model's declared modalities and the materialized tool set, neither of which moves between two
 * turns of one epoch. A model swap changes it — and a model swap has already forfeited that server's
 * prefix cache by moving to a different server.
 */
export const perceptionSection = (input: {
  readonly capabilities: InputCapabilities | undefined
  readonly canSpawn: boolean
}): string | undefined => {
  const declared = input.capabilities?.input
  if (declared === undefined || declared.length === 0) return undefined
  if (!declared.some((entry) => entry.toLowerCase().trim().startsWith("image"))) return undefined
  return [
    "You can SEE. This model reads images as well as text, so a picture on this machine is yours to " +
      "look at — you never need the user to describe one for you, and you must not ask them to.",
    "Call `read` on the image's path (png, jpeg, gif, webp) and the picture itself arrives in the " +
      "tool result, for you to look at. That is how you answer any question about what a file LOOKS " +
      "like: what a photo contains, what an icon depicts, what a screenshot shows, how two images " +
      "differ, what name a picture deserves.",
    // 🔴 Measured 2026-08-20, and it is the last gap the harness can address by saying something.
    // With the folder listing in place the model reads and describes correctly — but only when the
    // task SPELLS OUT that there are several: "Look at every png in this folder … Read them all"
    // scored 6/6 twice, while "please describe each glyph here" read ONE image and stopped, twice.
    // A plural request is not self-evidently a loop to this model, so the loop is stated.
    //
    // ⚠️ Informational, and the fourth of its kind here — three earlier ones did not convert. It is
    // cheap and precisely aimed at an observed failure, so it is worth one measurement; it is NOT a
    // substitute for the fan-out, which makes completeness the harness's property instead of the
    // phrasing's. If the A/B does not move it, this comes out rather than accumulating as folklore.
    "When a task covers SEVERAL images — a folder, a set, 'each of these' — work through them one at " +
      "a time: open one, write down what it shows, then open the next, until every one is done. " +
      "Describing the first image is not the answer to a question about all of them, and stopping " +
      "after it leaves the task unfinished.",
    // 🔴 This paragraph used to end "…no listing can answer a question about what a picture shows.
    // When the task is about images, open the images." — and measured 2026-08-20 on the six-glyph
    // corpus, that overshot into discouraging the listing STEP. Asked "please describe each glyph
    // here" with the folder as the working directory, Holo-3.1 called no `ls`, no `glob`, invented
    // the single filename `glyphs.png`, failed to read it twice, and then asked the user to describe
    // the glyphs in words — the exact behaviour the first sentence of this section forbids.
    //
    // The sentence was written against a REAL failure (substituting a listing for looking) and that
    // half is kept. What was missing is that a listing is how the model learns WHICH files exist:
    // without it there is no path to call `read` on, and a model told only that listings cannot
    // answer will guess one. Enumerate, then open — and never invent a name.
    "`bash ls`, `glob` and `grep` return file NAMES and text, never pixels: a listing tells you WHICH " +
      "images exist, never what any of them shows. So when you are pointed at a folder, list it " +
      "first to learn the real filenames, then `read` each image you were asked about. Never guess " +
      "or invent a filename, and never answer from names alone — if a read fails, list the folder " +
      "and use the names it returns.",
    // 🔴 Rewritten 2026-08-20 from "for more than a handful of images, spawn a child session per
    // batch". That rule keyed on COUNT, and measured against 400 icons the model obeyed it exactly:
    // it spawned, waited ten minutes on the child, and after 25 minutes had read 8 files and named
    // 1 of 400. The premise it acted on — "a large folder will not fit in this conversation" — is
    // false for small images. Anything up to 256×256 costs 66 tokens, so 400 glyphs are ~26K of a
    // 131K window, while a single 12-megapixel photo is ~11,700 and nine of them fill it.
    // Nine files can need the fan-out and four hundred can not, so the trigger is SIZE, not number.
    ...(input.canSpawn
      ? [
          "Images differ hugely in cost: a small icon costs about as much as a sentence, while a " +
            "photo or a screenshot can cost several pages of text — nine large photos can fill this " +
            "whole conversation, and several hundred icons need not. So judge by how big the " +
            "pictures are, never by how many. When the images are LARGE and there are enough of " +
            "them to crowd out the task, `spawn` a child session per batch, let it look and return " +
            "its findings as TEXT through `exit`, and join the results — the pixels stay in the " +
            "children while your own context keeps the task. When they are small, do not delegate: " +
            "reading them yourself, one at a time, is faster and finishes.",
        ]
      : []),
  ].join("\n\n")
}

/**
 * WHO ELSE CAN DO WORK — and the difference between the two kinds.
 *
 * 🔴 **Measured on Qwen3.6-35B 2026-08-22, and it is why this section exists.** An officer told
 * plainly to *"spawn a fleet of 6 sub-agents"* reached for the `colleague` tool and addressed ITSELF,
 * six times. It then reasoned *"right, `marshal` is me — I need `spawn`"*, went looking for `spawn`
 * with `tool_search`, and looped on the search four times without ever calling the tool, which was
 * RESIDENT on its horizon the whole time.
 *
 * None of that is a bad tool description. The prompt simply never said the capability existed: the
 * only mention of `spawn` anywhere in the system prompt sat inside the VISION section, behind a check
 * for an image modality, so a text-only model was told nothing. And under this product's own
 * vocabulary a "sub-agent" and a "colleague" are the same idea — both are other agents doing work —
 * so a model reaching for the one it HAD been told about is making the reasonable inference.
 *
 * ⚠️ The two are named TOGETHER on purpose. Stating either alone leaves the model to guess how it
 * relates to the other, which is precisely the guess that failed: what distinguishes them is not
 * capability but IDENTITY — a colleague is a person on the roster with their own chat and their own
 * memory, a sub-agent is nameless, temporary, and yours.
 *
 * ⚠️ Both flags come from the MATERIALIZED tool list, never the registry: a section naming a tool
 * this turn cannot call is the false description ruling 2 forbids.
 */
export const delegationSection = (input: {
  readonly canSpawn: boolean
  readonly canAddressColleagues: boolean
  /**
   * The colleague-loop cap is reached, so the asking ops were WITHHELD from this turn's tool list.
   *
   * 🔴 The absence must be EXPLAINED. Withholding alone teaches nothing — a model that cannot see
   * `ask` does not conclude "the chain is too long", it concludes nothing and tries something else.
   * The refusal text is what sends it back to the user, and withholding removes the refusal, so the
   * sentence has to move here.
   */
  readonly colleaguesAtCap?: boolean
}): string | undefined => {
  const lines: string[] = []
  if (input.canSpawn)
    lines.push(
      "You can put SIZEABLE, INDEPENDENT work in parallel with sub-agents. `spawn` creates a nameless " +
        "helper in a fresh context with your own authority; it does one piece of work and ends, with " +
        "no chat or memory of its own. Use it only when the parallel payoff exceeds that startup and " +
        "reread cost; keep a bounded task you can finish in a few tool calls in this session. For a " +
        "real split, call `spawn` once per part in the same turn, continue other independent work, then " +
        "collect the results. Do not redo " +
        "a child's part while it runs, and verify its evidence or changed state before reporting it " +
        "complete. When explicitly asked to delegate, do not do the parts yourself. Do not look for " +
        "`spawn` — it is already in your tool list.",
    )
  if (input.canAddressColleagues)
    lines.push(
      "You can also hand work to a COLLEAGUE with `colleague`. A colleague is a different person on " +
        "this instance's roster, with their own name, their own chat and their own memory. That is the " +
        "opposite of a sub-agent: you use it when the work BELONGS to somebody else, not when you " +
        "simply want more hands. Never address yourself — a message to your own name lands in this " +
        "same conversation.",
    )
  if (input.canAddressColleagues && input.colleaguesAtCap === true)
    lines.push(
      "⚠️ You cannot ASK a colleague on this turn. This conversation is already several colleague " +
        "hand-offs deep with nobody outside it, so `colleague` is offered WITHOUT its asking ops — " +
        "that is why you cannot see them, and not an oversight. Passing it on again would not help. " +
        "Say what you have and what is still open, and let the user decide: the limit resets as soon " +
        "as they say anything. You can still call `colleague` to `list` who works here.",
    )
  if (input.canSpawn && input.canAddressColleagues)
    lines.push(
      "In short: `spawn` for more hands doing YOUR work, `colleague` for work that is somebody " +
        "else's. If you are asked for several workers, sub-agents are what is being asked for.",
    )
  return lines.length === 0 ? undefined : lines.join("\n\n")
}

/** The instance-owned profile fields that define one officer to the model. */
export interface AgentIdentityProfile {
  readonly id: string
  readonly name?: string | undefined
  readonly title?: string | undefined
  readonly personality?: string | undefined
}

const identityLabel = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed ? XmlText.escape(trimmed.replace(/\s+/g, " ")) : undefined
}

const IDENTITY_SENTINELS = ["<agent_identity>", "</agent_identity>"] as const

/**
 * The ONE model-facing officer identity block. The immutable id is only a degraded fallback; a
 * resolved profile name wins without changing the id that owns the chat and memory cabinet.
 */
export const agentIdentitySection = (profile: AgentIdentityProfile): string => {
  const name = identityLabel(profile.name) ?? identityLabel(profile.id) ?? "unknown colleague"
  const title = identityLabel(profile.title)
  // Personality is authored instruction text, so preserve its markup and neutralise only the two
  // wrapper sentinels. A profile describing this prompt format must not accidentally close its own
  // identity block or manufacture a second one.
  const personality = profile.personality?.trim()
  const framedPersonality = personality ? XmlText.neutralizeSentinels(personality, IDENTITY_SENTINELS) : undefined
  return [
    "<agent_identity>",
    `Your name is ${name}.`,
    ...(title === undefined ? [] : [`Your job title is ${title}.`]),
    ...(framedPersonality ? ["Your personality and standing instructions are:", framedPersonality] : []),
    "</agent_identity>",
  ].join("\n")
}

/** The immutable chain of command for roster officers.
 *
 * This is kernel material, not an editable personality: an officer must not be able to resolve a
 * collision by overpowering a peer, and Nova's coordinating authority must not be cloneable as text. */
export const organizationSection = (input: {
  readonly agentID: string
  readonly officer: boolean
  readonly worker?: boolean | undefined
  readonly superior?: { readonly id: string; readonly name?: string | undefined } | undefined
}): string | undefined => {
  const superior = input.superior?.name?.trim() || input.superior?.id || "Nova"
  const id = input.superior?.id ?? "nova"
  // A worker inherits its officer's profile and authority, but not the officer's place in the org
  // chart. This branch MUST precede Nova's CEO branch: a worker Nova spawned is staff working for
  // Nova, not a second CEO wearing the inherited profile.
  if (input.worker)
    return [
      `You are a worker spawned by ${superior} (id \`${id}\`). ${superior} is your superior; report your result to them.`,
      `If your work conflicts with another agent's work, pause the conflicting part and report it to ${superior}. Do not start an edit war, overwrite their work, or stop/kill their processes.`,
    ].join("\n")
  if (input.agentID === "nova")
    return [
      "You are this instance's CEO and are accountable only to the user.",
      "You are responsible for resolving conflicts between officers. When their work overlaps — for example, two officers need to edit the same file — assign ownership or sequence the work so they do not fight, overwrite one another, or stop one another's processes.",
    ].join("\n")
  if (!input.officer) return undefined
  return [
    `Your superior is ${superior} (id \`${id}\`). Nova is the instance's CEO and is ultimately accountable to the user.`,
    `If your work conflicts with another officer's work, pause the conflicting part and message ${superior} with the \`colleague\` tool. Do not start an edit war, overwrite their work, or stop/kill their processes; ask your superior to assign ownership or sequence the work.`,
  ].join("\n")
}

/**
 * The system prompt's parts, keyed by slot name.
 *
 * 🔴 The type is DERIVED from `ContextTemplate.SLOTS` (owner, 2026-09-16), which is what makes the
 * table the single source: a slot cannot exist without a key here, and a key cannot exist without a
 * slot. The per-field descriptions that used to live in this interface are the `purpose` and
 * `placement` columns of that table now — one home, where the ORDER and the VOLATILITY sit beside them.
 *
 * ⚠️ Optional on purpose: a slot with nothing to say composes nothing. `ContextTemplate.composedBlocks`
 * states the non-empty predicate once, and `test/session-system-compose.test.ts`'s
 * `Required<Omit<…>>` ledger is what forces a decision when a slot is added.
 */
export type SystemPromptParts = ContextTemplate.SystemPromptParts

/**
 * The ORDERED, non-empty system-prompt parts. The per-model pre-prompt sits immediately after the
 * persona baseline; every other part keeps its existing position, so with no pre-prompt the output is
 * byte-identical to the pre-feature array. Uses the exact same non-empty predicate the runner used
 * inline (`part !== undefined && part.length > 0`).
 *
 * ⚠️ PLACEMENT of `projectScope`: immediately BEFORE `base`, i.e. after everything a persona, a
 * user override or an agent prompt can say, and still inside the kernel material that closes the
 * prompt. Two reasons, in order of weight. (1) It is a KERNEL constraint, not task material — the
 * same family as the base context, and grouping it there is what lets a session inspecting its own
 * prompt tell "what the product requires" from "what this chat asked for". (2) An agent's own
 * system prompt (`agentSystem`) is authored per agent and can be edited by the user; sitting after
 * it means a well-meaning agent prompt cannot bury the rule under later instructions. `base` stays
 * last, exactly as the header above documents.
 */
/**
 * THE ORDER, and the ONE list that decides it.
 *
 * 🔴 The list MOVED (owner, 2026-09-16): it is now `ContextTemplate.SLOTS`
 * (`session/context-template.ts`), which declares every place in the request — the system blocks, the
 * tail, the tool schemas and the transcript — together with each one's VOLATILITY (how long its value
 * survives, i.e. whether changing it costs the server's prefix cache) and a one-line purpose.
 *
 * ⚠️ It was split across five places before that, and the split was not merely untidy: `volatility`
 * decides whether a request keeps its prefix cache, and getting it wrong is what turns a small edit
 * into gigabytes of re-prefill. That knowledge was a prose warning here, an implicit consequence of
 * where a value was read in `llm.ts`, and a conditional in `context-epoch.ts`.
 *
 * What stays here is the shaping — `composeSystemParts` joins what the table orders, and
 * `SystemAccounting.of` counts it (BLOCKS derives from this function, so the instrument and the thing
 * measured still cannot drift).
 */
export const systemPartsInOrder = (parts: SystemPromptParts): ReadonlyArray<{ block: string; text?: string }> =>
  ContextTemplate.systemBlocks(parts)

/** The system prompt's parts, in order, with the absent ones dropped. */
export const composeSystemParts = (parts: SystemPromptParts): string[] =>
  systemPartsInOrder(parts)
    .map((part) => part.text)
    .filter((text): text is string => text !== undefined && text.length > 0)

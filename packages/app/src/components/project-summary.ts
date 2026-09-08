import type { TranslationKey, Translator } from "@/context/language"
import type { ProjectState } from "@/utils/project-api"

/**
 * **What a folder's `novaclaw.json` says, in words a person can read.**
 *
 * The rule: *"never make a person infer project state from a hidden dotfile."* A project
 * file can NARROW a session's permissions, so a user whose tool call was refused needs somewhere to
 * see which file did it. Settings → General and the composer's Tune panel already say it; Chats and
 * Files are the two surfaces that did not.
 *
 * ⚠️ **This module holds every sentence those two surfaces show, and it is PURE on purpose.** The
 * only part of this feature that can be got wrong quietly is the wording: a summary that reports
 * "not a Project" for a folder whose file merely failed to parse tells the user their settings are
 * absent when in fact they are *ignored*, which is the same falsehood in a friendlier voice. So the
 * mapping is data — one function, no DOM, tested over all three kinds and both invalid reasons —
 * and the components render what it returns verbatim.
 *
 * ⚠️ It reports what `GET /api/project` actually carries: the name, the root, the file, the
 * permission-rule COUNT and the exclusions. It never claims which Tune switches the file supplied,
 * because the route does not say — the composer's Tune panel reads the resolved session config and
 * is the authority for that. The chat summary points at it rather than guessing.
 */

/** Which surface is asking. The facts are the same; the sentences are written for where they land. */
export type ProjectScope = "chat" | "files"

/** How the chip should read: a Project, a plain folder, or a file that could not be used. */
export type ProjectTone = "project" | "plain" | "warning"

export interface ProjectSummary {
  readonly kind: ProjectState["kind"]
  readonly tone: ProjectTone
  /** The chip's word — a few characters of screen, so it states the STATE and nothing else. */
  readonly label: string
  /** Principle 12(d): what is in force right now, said before any control or detail. */
  readonly headline: string
  /** Principle 8: the one sentence a curious non-expert learns what a Project *is* from. */
  readonly teach: string
  /** The directory holding the file — an ANCESTOR of the routed folder when the file is above it. */
  readonly root?: string
  /** The governing file, verbatim, so a refused tool call is traceable to it. */
  readonly file?: string
  /**
   * What the file contributes, already worded — or, when it could not be used, what to do about it.
   * Empty for a plain folder, because a folder without a project file contributes nothing to explain.
   */
  readonly contributes: readonly string[]
}

/**
 * Every key this module can ask for, spelled as a LITERAL.
 *
 * ⚠️ Not assembled from the scope at runtime. `context/language.tsx` types the translator to
 * `keyof Dictionary`, so a literal table is compile-checked against `en.ts` while a
 * `` `${scope}.project.what` `` template would need the cast that `i18n/key-typing.test.ts` ledgers
 * as a bypass. The duplication buys the check.
 */
const KEYS = {
  chat: {
    labelProject: "chat.project.label.project",
    labelPlain: "chat.project.label.plain",
    labelInvalid: "chat.project.label.invalid",
    what: "chat.project.what",
    named: "chat.project.named",
    unnamed: "chat.project.unnamed",
    plain: "chat.project.plain",
    unusable: "chat.project.unusable",
    rules: "chat.project.rules",
    rulesOne: "chat.project.rulesOne",
    rulesNone: "chat.project.rulesNone",
    exclude: "chat.project.exclude",
  },
  files: {
    labelProject: "files.project.label.project",
    labelPlain: "files.project.label.plain",
    labelInvalid: "files.project.label.invalid",
    what: "files.project.what",
    named: "files.project.named",
    unnamed: "files.project.unnamed",
    plain: "files.project.plain",
    unusable: "files.project.unusable",
    rules: "files.project.rules",
    rulesOne: "files.project.rulesOne",
    rulesNone: "files.project.rulesNone",
    exclude: "files.project.exclude",
  },
} as const satisfies Record<ProjectScope, Record<string, TranslationKey>>

/**
 * The two remedies for an unusable file come from `settings.project.*`, NOT from a second copy here.
 *
 * ⚠️ *"Update NovaClaw"* and *"fix your file"* are opposite actions, and the Settings panel already
 * spells both. A surface that reworded them would be a second place for the two to disagree about
 * which one a user should take — the same rule the panel itself follows about permission rules.
 */
const REMEDY = {
  future: "settings.project.invalidFuture",
  broken: "settings.project.invalidBroken",
} as const satisfies Record<string, TranslationKey>

/** The label a detail block puts in front of the root / the file. Shared with Settings, deliberately. */
export const PROJECT_DETAIL_LABELS = {
  section: "settings.project.section",
  root: "settings.project.rootLabel",
  file: "settings.project.fileLabel",
} as const satisfies Record<string, TranslationKey>

/**
 * The chat surface points at Tune rather than restating it. Chat-only: the Files app has no composer,
 * so telling a file browser to look "below the message box" would be an instruction it cannot follow.
 */
const TUNE_POINTER: TranslationKey = "chat.project.tune"

/**
 * Turn a resolved `ProjectState` into the sentences a surface shows.
 *
 * Returns `undefined` while the answer is still in flight — a surface that has not been told yet
 * must say nothing rather than assert "not a Project", which is a claim it has not earned.
 */
export function projectSummary(
  state: ProjectState | undefined,
  t: Translator,
  scope: ProjectScope,
): ProjectSummary | undefined {
  if (!state) return undefined
  const keys = KEYS[scope]
  const teach = t(keys.what)

  // A plain working folder is a NORMAL, complete state — not an error and not a setup step left
  // undone. It says so in those words, because a surface that merely omitted the Project would leave
  // the user unable to tell "no project file" from "this screen has not loaded".
  if (state.kind === "none")
    return { kind: "none", tone: "plain", label: t(keys.labelPlain), headline: t(keys.plain), teach, contributes: [] }

  // 🔴 The case this whole surface exists for. A file that failed to parse is NOT the same as no
  // file: the settings the user wrote are being ignored, and nothing else on screen would tell them.
  // The headline says that outright before the remedy, so the failure can never read as a silent
  // fallback in which their settings quietly applied.
  if (state.kind === "invalid")
    return {
      kind: "invalid",
      tone: "warning",
      label: t(keys.labelInvalid),
      headline: t(keys.unusable),
      teach,
      file: state.file,
      contributes: [state.reason === "future-version" ? t(REMEDY.future) : t(REMEDY.broken, { detail: state.detail })],
    }

  const name = state.name?.trim()
  const contributes: string[] = [
    state.permissionRules === 0
      ? t(keys.rulesNone)
      : state.permissionRules === 1
        ? t(keys.rulesOne)
        : t(keys.rules, { count: state.permissionRules }),
  ]
  if (state.exclude.length > 0) contributes.push(t(keys.exclude, { list: state.exclude.join(", ") }))
  if (scope === "chat") contributes.push(t(TUNE_POINTER))
  return {
    kind: "project",
    tone: "project",
    label: t(keys.labelProject),
    headline: name ? t(keys.named, { name }) : t(keys.unnamed),
    teach,
    root: state.root,
    file: state.file,
    contributes,
  }
}

/**
 * Every key a summary can ask for, for the test that pins them against `en.ts`.
 *
 * ⚠️ A missing key does not throw — `t()` hands back `undefined` behind a signature that claims
 * `string`, so the surface would render the word "undefined" at a user. The type check catches a key
 * that was never in `en`; this list catches one that is *removed* from `en` later.
 */
export const projectSummaryKeys = (scope: ProjectScope): readonly TranslationKey[] => [
  ...Object.values(KEYS[scope]),
  ...Object.values(REMEDY),
  ...Object.values(PROJECT_DETAIL_LABELS),
  ...(scope === "chat" ? [TUNE_POINTER] : []),
]

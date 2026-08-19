import type { TranslationKey, Translator } from "@/context/language"
import type { ProjectState } from "@/utils/project-api"

/**
 * **Which folder Settings → Project is talking about, said out loud, in every state.**
 *
 * 🔴 WHY THIS MODULE EXISTS. The section resolves its subject as the INSTANCE's directory
 * (`path.directory || path.home`) — correct by design, because Settings is an instance-wide dialog
 * and not a per-chat one. What was wrong is that no sentence on the screen ever NAMED that folder.
 * The rows said *"This folder is not a Project"* and *"Add a novaclaw.json **here**"* with no
 * antecedent for "this" or "here", so on a desktop launch — where the instance's folder is the
 * user's HOME — the section offered to make `C:\Users\<name>` a Project while the reader had a
 * project chat open, and two separate readers (the owner, then an agent) concluded the feature was
 * pointed at the wrong folder and was broken. It was not. **An unnamed subject made a working
 * feature look broken**, which is exactly the failure AGENTS.md principle 12(d) — *say what is in
 * force right now, BEFORE any control* — exists to prevent.
 *
 * ⚠️ So the rule this module enforces mechanically: **every state names the folder.** Not a "this",
 * not a "here" — the path. `project-copy.test.ts` asserts it over all four states and goes red if a
 * sentence ever stops interpolating it.
 *
 * ⚠️ PURE, and modelled on `components/project-summary.ts` for the same reason that module is pure:
 * the only part of this that can be got wrong quietly is the WORDING, and wording is testable only
 * when it is data. The component renders what this returns, verbatim.
 *
 * ⚠️ THE HOME CASE GETS ITS OWN SENTENCES (AGENTS.md principle 11 — the home's top level is somewhere
 * we are careful about writing). The generic *"Add a novaclaw.json here to give the folder its own
 * defaults"* is a fine invitation for a working folder and a bad one for `C:\Users\<name>`, where the
 * file would govern every chat started anywhere beneath it. Saying that plainly is principle 8:
 * teach why, do not silently hide the control.
 */

/** What the section shows above and at the head of its rows. Every field already has the folder in it. */
export interface ProjectSectionCopy {
  /** The folder these rows describe, verbatim, as the caller resolved it. */
  readonly directory: string
  /** True when the instance's folder IS the user's home — the case with its own copy. */
  readonly atHome: boolean
  /** Principle 12(d): the subject line, rendered BEFORE any row or control. Names the folder. */
  readonly subject: string
  /** The head row's title. Names the folder. */
  readonly title: string
  /** The head row's description. */
  readonly description: string
  /** Which `ProjectState` this describes — so a test (and a reader) can tell the branches apart. */
  readonly kind: ProjectState["kind"]
}

const KEYS = {
  subject: "settings.project.subject",
  subjectHome: "settings.project.subjectHome",
  none: "settings.project.none",
  noneDetail: "settings.project.noneDetail",
  noneHome: "settings.project.noneHome",
  noneHomeDetail: "settings.project.noneHomeDetail",
  invalid: "settings.project.invalid",
  invalidFuture: "settings.project.invalidFuture",
  invalidBroken: "settings.project.invalidBroken",
  namedTitle: "settings.project.namedTitle",
  unnamedTitle: "settings.project.unnamedTitle",
  rootHere: "settings.project.rootHere",
  rootAbove: "settings.project.rootAbove",
} as const satisfies Record<string, TranslationKey>

/** Every key this module can ask for, for the test that pins them against `en.ts`. */
export const projectSectionCopyKeys: readonly TranslationKey[] = Object.values(KEYS)

/**
 * Are these two paths the same folder?
 *
 * ⚠️ Separator- and case-insensitive on purpose. The instance reports `path.home` and
 * `path.directory` from the same process, but not necessarily spelled the same way — Windows hands
 * back `C:\Users\nangl` where a config-derived path may carry forward slashes, and the whole home
 * branch below turns on this comparison. Getting it wrong in the *false* direction is the expensive
 * one: it would put the generic "add a novaclaw.json here" invitation back on the home folder.
 *
 * ⚠️ Case-folding is wrong on a case-sensitive filesystem in the narrow sense that `/home/a` and
 * `/home/A` are two folders there. It is the right trade anyway: the only cost of a false match is
 * that a user reads the *more* careful sentence about a folder that merely looks like their home,
 * and no write is gated on this — the controls below are unchanged in both branches.
 */
function sameFolder(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  return norm(a) === norm(b) && a.trim() !== ""
}

/**
 * Turn a resolved `ProjectState` into the section's own copy.
 *
 * Returns `undefined` while the answer is still in flight, or before the instance has told us where
 * it is — a section that has not been told which folder it is describing must say nothing rather
 * than assert something about an unnamed one. That is the defect, restated as a guard.
 */
export function projectSectionCopy(input: {
  readonly state: ProjectState | undefined
  readonly directory: string
  readonly home: string
  readonly t: Translator
}): ProjectSectionCopy | undefined {
  const { state, t } = input
  const directory = input.directory.trim()
  if (!state || directory === "") return undefined
  const atHome = sameFolder(directory, input.home)
  const subject = atHome ? t(KEYS.subjectHome, { directory }) : t(KEYS.subject, { directory })
  const base = { directory, atHome, subject } as const

  if (state.kind === "none")
    return {
      ...base,
      kind: "none",
      // Not an error and not a nag: a folder without a project file is perfectly usable. The home
      // branch says the same thing and then explains what a Project HERE would actually cover,
      // because "here" is the one folder where accepting the invitation is usually a mistake.
      title: atHome ? t(KEYS.noneHome) : t(KEYS.none, { directory }),
      description: atHome ? t(KEYS.noneHomeDetail, { directory }) : t(KEYS.noneDetail, { directory }),
    }

  if (state.kind === "invalid")
    return {
      ...base,
      kind: "invalid",
      title: t(KEYS.invalid, { directory }),
      // ⚠️ The two reasons keep DIFFERENT sentences. "Update NovaClaw" and "fix your file" are
      // opposite actions, and one message covering both would send half its readers the wrong way.
      // These two keys are shared with `project-summary.ts`, so the three surfaces that report a
      // broken project file cannot come to disagree about which remedy applies.
      description:
        state.reason === "future-version"
          ? t(KEYS.invalidFuture)
          : t(KEYS.invalidBroken, { detail: state.detail }),
    }

  const name = state.name?.trim()
  return {
    ...base,
    kind: "project",
    title: name ? t(KEYS.namedTitle, { directory, name }) : t(KEYS.unnamedTitle, { directory }),
    // 🔴 The project ROOT can be an ANCESTOR of the folder on screen, and that is the second half of
    // the same naming defect: a reader who sees only "Declared in <path>" cannot tell whether the
    // file lives in the folder these rows describe or three levels above it, governing far more than
    // they think. So the two cases get different sentences instead of one path with no explanation.
    description: sameFolder(state.root, directory) ? t(KEYS.rootHere) : t(KEYS.rootAbove, { root: state.root }),
  }
}

// The Recipes app's presentation logic, kept OUT of the page so every state is unit-testable: each of
// the four cook verdicts, a recipe that declares no postcondition, a shipped one against a user's own, an
// import carrying hostile metadata, and a recipe whose file we could not read. `recipes.test.ts` walks
// all of them.
//
// ─── WHAT A RECIPE IS, AND WHY THIS APP EXISTS ────────────────────────────────────────────────────
// AGENTS.md → *Recipes are source code for the AI era*: a recipe is a FOLDER (`recipe.md` + assets)
// carrying the INTENT rather than the artifact, and an agent cooks it fresh on demand. *Source rots,
// intent doesn't.* It is also called **the anti-elitist artifact** — *"A normal person can read, edit and
// share a recipe. They cannot read a Makefile."* — so the job of this surface is to be legible to
// somebody who does not program, and to TEACH rather than gatekeep (principle 8).
//
// Three obligations run through everything below and must survive any edit:
//
//  1. **The trade is taught, not buried.** A recipe buys DURABILITY and pays in EXACT REPRODUCIBILITY:
//     two cooks of one recipe are not byte-identical. A person pressing Run must be able to learn in one
//     sentence why they may get a different-but-working result each time — {@link REPRODUCIBILITY}.
//  2. **The four verdicts never collapse.** `not-available` (the MODEL cannot do this) reading as
//     `not-working` (your install is broken) would blame the user's machine for a model limit; `unknown`
//     reading as `working` would be the vibe the receipt replaced. {@link describeVerdict} keeps them
//     apart in the WORDS, not only in the colour, and the test asserts all four differ pairwise.
//  3. **A recipe is untrusted content.** An imported one was written by a stranger: its name, description
//     and body are attacker-controlled strings. They are rendered as DATA and labelled as the author's
//     claim, never as ours, and they go through `authorText`/`authorBody` first.
//
// ⚠️ **Nothing here judges what a recipe DOES.** There is no risk score and no "this recipe is safe"
// verdict. What a reader gets is what the harness OBSERVED — which files the recipe names, whether this
// machine has what it says it needs, and what actually landed on disk after a cook.

import { authorBody, authorText, containsInvisible } from "./author-text"

export { authorBody, authorText, containsInvisible }

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The wire shapes this app reads (`packages/protocol/src/groups/recipe.ts`)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** `GET /api/recipe` — the record. `prompt` is the BODY of recipe.md; the frontmatter is not on it. */
export interface RecipeInfo {
  readonly slug: string
  readonly name: string
  readonly description?: string
  readonly prompt: string
  readonly assets: readonly string[]
  readonly builtin: boolean
  readonly updatedAt: number
}

/** One `needs:` fact, probed against this machine. `unknown` is NOT `absent` — see {@link describeNeeds}. */
export interface NeedCheckInfo {
  readonly fact: string
  /**
   * ⚠️ **Two of these four are not "no".** `unknown` = we have no probe for that fact; `unreadable` = we
   * have one and it failed (a locked file, a folder we cannot read). Neither blocks a cook and neither
   * may ever be rendered as "missing" — that is the instrument's failure told as a fact about the user's
   * machine, complete with an instruction to go and install something.
   */
  readonly status: "present" | "absent" | "unknown" | "unreadable"
  readonly looked: readonly string[]
  readonly found?: string
}

/** `GET /api/recipe/:slug/source` — the author's own bytes, plus what they need and produce. */
export interface SourceInfo {
  readonly slug: string
  readonly name: string
  readonly markdown: string
  readonly needs: readonly NeedCheckInfo[]
  readonly produces: readonly string[]
  readonly collection: { readonly id: CollectionId; readonly title: string; readonly note: string }
}

export type Outcome = "met" | "unmet" | "unknown"
export type UnknownReason = "not-applicable" | "not-measured" | "measurement-failed" | "incomplete"

export interface VerifyCheckInfo {
  readonly declared: string
  readonly outcome: Outcome
  readonly reason?: UnknownReason
  readonly path?: string
  readonly checked: string
  readonly bytes?: number
}

export type Verdict = "working" | "not-working" | "not-available" | "unknown"

/**
 * What the COOK did, as opposed to what is in the folder.
 *
 * 🔴 `blocked` is why a dead model endpoint no longer reads as a broken install. An empty folder is
 * only evidence about this computer if the cook actually reached it — see `core/src/recipe-verify.ts`.
 * Absent means we were not told, which is NOT `ran`.
 */
export type CookState = "ran" | "blocked" | "stopped"

export interface VerifyResultInfo {
  readonly slug: string
  readonly name: string
  readonly directory: string
  readonly verdict: Verdict
  readonly checks: readonly VerifyCheckInfo[]
  readonly summary: string
  readonly at: number
  readonly cookState?: CookState
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The shelves — mirrored from `RecipeBuiltin.COLLECTIONS`, and pinned against it by the test
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// `@novaclaw/core/recipe-builtin` cannot be imported here: it pulls `core/recipe.ts`, which imports
// `node:fs`. So the vocabulary is restated and `recipes.test.ts` asserts it EQUALS core's, id for id and
// word for word — the same shape `skills.ts` uses for `wildcardMatch`. A divergence fails a test instead
// of quietly showing a user a shelf the engine does not have.
//
// ⚠️ Membership is decided by the BUILD, never by the file: a recipe cannot declare which shelf it is on,
// because an artifact that travels between strangers could then announce itself as one NovaClaw shipped.
// Here that fact arrives as the record's `builtin` flag, which the server sets from `BUILTIN_SLUGS`.

export type CollectionId = "examples" | "mine"

export interface CollectionInfo {
  readonly id: CollectionId
  readonly title: string
  readonly note: string
}

export const COLLECTIONS: readonly CollectionInfo[] = [
  {
    id: "examples",
    title: "Examples",
    note: "Recipes NovaClaw brought with it. Run one to see what this install can do — or copy one and make it yours.",
  },
  { id: "mine", title: "My recipes", note: "Everything you wrote, imported, or copied." },
]

export const collectionOf = (recipe: { readonly builtin: boolean }): CollectionId =>
  recipe.builtin ? "examples" : "mine"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The row the page renders
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface RecipeView {
  readonly key: string
  /** Safe to put on screen: flattened, bidi/zero-width stripped, bounded. */
  readonly name: string
  /** The name as the file spells it — a stable key, and what a rename starts from. */
  readonly rawName: string
  readonly description: string
  readonly hasDescription: boolean
  /**
   * The prompt as the file spells it, NOT flattened.
   *
   * ⚠️ Load-bearing. The editor binds to this, and a flattened prompt written back would delete
   * characters from the author's file on every open/save round trip — a display defence turned into a
   * silent data loss. Read-only prompt DISPLAY uses {@link RecipeView.body} instead.
   */
  readonly rawPrompt: string
  /** The prompt for READING — invisible characters gone, line breaks kept. */
  readonly body: string
  readonly assets: readonly string[]
  readonly shipped: boolean
  readonly collection: CollectionId
  readonly updatedAt: number
  /**
   * True when this recipe's own text carries characters that make it read differently than it is.
   *
   * ⚠️ The read-only surfaces already flatten those away, but the EDITOR cannot: whatever is in the box is
   * what a save writes back, so flattening there would delete characters from the author's file on every
   * open/save round trip. The raw string stays, and the page SAYS it is not what it looks like.
   */
  readonly hiddenCharacters: boolean
}

/** A recipe whose name is blank once the invisibles are gone still gets a row a person can point at. */
export function displayName(recipe: { readonly name: string; readonly slug: string }): string {
  return authorText(recipe.name, 80) || authorText(recipe.slug, 80) || "(unnamed recipe)"
}

export function toView(recipe: RecipeInfo): RecipeView {
  const description = authorText(recipe.description, 400)
  return {
    key: recipe.slug,
    name: displayName(recipe),
    rawName: recipe.name,
    description,
    hasDescription: description !== "",
    rawPrompt: recipe.prompt,
    body: authorBody(recipe.prompt),
    assets: recipe.assets.map((asset) => authorText(asset, 120)).filter((asset) => asset !== ""),
    shipped: recipe.builtin,
    collection: collectionOf(recipe),
    updatedAt: recipe.updatedAt,
    hiddenCharacters:
      containsInvisible(recipe.name) || containsInvisible(recipe.description) || containsInvisible(recipe.prompt),
  }
}

/** Group onto the shelves in {@link COLLECTIONS} order, dropping shelves with nothing on them. */
export function groupViews(
  views: readonly RecipeView[],
): readonly { readonly collection: CollectionInfo; readonly recipes: readonly RecipeView[] }[] {
  return COLLECTIONS.map((collection) => ({
    collection,
    recipes: views.filter((view) => view.collection === collection.id),
  })).filter((group) => group.recipes.length > 0)
}

/** Case-insensitive substring search over the words a person can actually see. */
export function filterViews(views: readonly RecipeView[], query: string): RecipeView[] {
  const needle = authorText(query, 120).toLowerCase()
  if (needle === "") return [...views]
  return views.filter(
    (view) => view.name.toLowerCase().includes(needle) || view.description.toLowerCase().includes(needle),
  )
}

export const sortViews = (views: readonly RecipeView[]): RecipeView[] =>
  [...views].sort((a, b) => a.name.localeCompare(b.name))

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The trade — taught, in the words AGENTS.md uses to make it
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The one thing a person pressing Run has to understand, and the reason this app cannot just say
 * "Run". AGENTS.md: *"a recipe buys **durability** and pays in **exact reproducibility**. Two cooks of one
 * recipe are not byte-identical, so anything needing bit-exactness, a signature, or an audited artifact
 * still wants real source."*
 *
 * ⚠️ It is shown BESIDE the Run button, not behind a help link. The whole claim of the artifact is that a
 * non-expert can hold it; a trade-off a non-expert has to go looking for is a trade-off we hid.
 * `price` is deliberately the sentence that names who should NOT use a recipe — a product that only
 * lists what its idea is good for has not been honest about it.
 */
export const REPRODUCIBILITY = {
  headline: "Every run is cooked fresh, so you can get a different — but working — result each time.",
  gain:
    "A recipe stores what you wanted, not the finished thing. NovaClaw builds it again from scratch with " +
    "today's tools, which is why a recipe still works years after the program that did the same job " +
    "stopped building.",
  price:
    "The price is exact repeatability: two runs of the same recipe are not identical down to the byte. " +
    "If you need a file that must match exactly — something signed, audited, or checked against a " +
    "checksum — keep the real source too, and use the recipe for everything else.",
  reassurance:
    "Running a recipe never changes it. NovaClaw copies it into a work folder and cooks there, so you can " +
    "run the same recipe as many times as you like.",
} as const

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// What this machine has, and what the recipe promises — read BEFORE anyone presses Run
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ **Three answers, and two of them are not "no".** `absent` is a fact we probed; `unknown` is a fact we
 * have no probe for and it never blocks a cook; `unreadable` is a fact about US. A UI that folded the last
 * two into "missing" would tell a person their machine lacks something we never looked for — the fault
 * described falsely that the engine's own `unmetMessage` refuses to commit.
 */
export type NeedsState = "unreadable" | "none" | "ready" | "missing" | "unsure"

export interface NeedsView {
  readonly state: NeedsState
  readonly sentence: string
  /** Every candidate actually tried, so the claim stays checkable by hand. Empty unless `missing`. */
  readonly looked: readonly string[]
  readonly facts: readonly NeedCheckInfo[]
  /** True only when a cook will actually be refused at the door. */
  readonly blocksRun: boolean
}

const list = (values: readonly string[]) =>
  values.length <= 1 ? (values[0] ?? "") : `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`

const quoted = (values: readonly string[]) => list(values.map((value) => `“${value}”`))

export function describeNeeds(source: SourceInfo | undefined): NeedsView {
  if (!source)
    return {
      state: "unreadable",
      sentence: "I could not read this recipe's file, so I cannot tell you what it needs from your computer.",
      looked: [],
      facts: [],
      blocksRun: false,
    }
  const facts = source.needs.map((need) => ({ ...need, fact: authorText(need.fact, 120) }))
  if (facts.length === 0)
    return {
      state: "none",
      sentence: "This recipe does not ask for anything special from your computer.",
      looked: [],
      facts,
      blocksRun: false,
    }
  const absent = facts.filter((need) => need.status === "absent")
  const unsure = facts.filter((need) => need.status === "unknown")
  // A probe that EXISTS and failed. Kept apart from `unsure` all the way to the screen because the two
  // give a person different work to do: nothing at all for `unknown`, and "a path on your machine I
  // could not read" for this one — which they can often fix.
  const blocked = facts.filter((need) => need.status === "unreadable")
  const present = facts.filter((need) => need.status === "present")
  const cannotCheck =
    (unsure.length > 0
      ? ` It also says it needs ${quoted(unsure.map((need) => need.fact))}, which I have no way to check.`
      : "") +
    (blocked.length > 0
      ? ` I tried to check ${quoted(blocked.map((need) => need.fact))} and could not — something on this ` +
        `computer blocked the look, which is not the same as it being missing.`
      : "")

  if (absent.length > 0)
    return {
      state: "missing",
      // ⚠️ Never "you do not have gcc". We looked HERE and did not find it — the only claim the probe
      // supports, and the same sentence shape the engine's own refusal uses.
      sentence:
        `This recipe says it needs ${quoted(absent.map((need) => need.fact))}, and I did not find ` +
        `${absent.length > 1 ? "them" : "it"} where I looked on this computer. NovaClaw will not start the ` +
        `cook until it is there.${cannotCheck}`,
      looked: [...new Set(absent.flatMap((need) => need.looked))],
      facts,
      blocksRun: true,
    }
  if (present.length > 0)
    return {
      state: "ready",
      sentence:
        `This recipe says it needs ${quoted(present.map((need) => need.fact))}, and I found ` +
        `${present.length > 1 ? "them" : "it"} on this computer.${cannotCheck}`,
      looked: [],
      facts,
      blocksRun: false,
    }
  // Nothing was found and nothing was provably missing, so every fact is one we could not settle. Which
  // sentence depends on WHY, and the two are not interchangeable: "there is no way to check that" asks
  // nothing of the user, while "I could not read the places I look" points at something they can fix.
  if (unsure.length === 0 && blocked.length > 0)
    return {
      state: "unsure",
      sentence:
        `This recipe says it needs ${quoted(blocked.map((need) => need.fact))}, and I could not check — ` +
        `something on this computer blocked me from looking (a locked file, or a folder I am not allowed ` +
        `to read). That is not the same as it being missing, so I will not stand in the way of the cook.`,
      looked: [...new Set(blocked.flatMap((need) => need.looked))],
      facts,
      blocksRun: false,
    }
  return {
    state: "unsure",
    sentence:
      `This recipe says it needs ${quoted(unsure.map((need) => need.fact))}. I have no way to check that, so ` +
      `I will not stand in the way — if it turns out not to be there, the run itself will say so.` +
      (blocked.length > 0
        ? ` It also names ${quoted(blocked.map((need) => need.fact))}, which I tried to check and could not.`
        : ""),
    looked: [],
    facts,
    blocksRun: false,
  }
}

/**
 * What a finished cook is judged on. Three states again, and again two of them are not "nothing":
 * `unreadable` is about us, `none` is a real property of the recipe (and the thing to teach a way out of).
 */
export type DeclaredState = "unreadable" | "none" | "declared"

export interface DeclaredView {
  readonly state: DeclaredState
  readonly files: readonly string[]
  readonly sentence: string
  /** The way forward, in the user's own vocabulary. Empty when there is nothing to fix. */
  readonly advice: string
}

export function describeDeclared(source: SourceInfo | undefined): DeclaredView {
  if (!source)
    return {
      state: "unreadable",
      files: [],
      sentence: "I could not read this recipe's file, so I cannot tell you what a finished run should leave behind.",
      advice: "",
    }
  const files = source.produces.map((entry) => authorText(entry, 120)).filter((entry) => entry !== "")
  if (files.length === 0)
    return {
      state: "none",
      files,
      sentence:
        "This recipe does not name any file a finished run should leave behind, so afterwards I will not be " +
        "able to tell you whether it worked.",
      advice:
        "Add the file names below — for example report.md — and NovaClaw will check them for you every time " +
        "you run this recipe.",
    }
  return {
    state: "declared",
    files,
    sentence: `When this finishes, NovaClaw will look for ${quoted(files)} in the work folder and tell you what it found.`,
    advice: "",
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE RECEIPT — four verdicts, and keeping them apart is the feature
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// AGENTS.md: the bundled set is *the install's health check* — *"a user can tell in one click whether
// THEIR NovaClaw is actually working, a diagnostic that reads as a feature, not a test suite."* The
// engine already answers in four words (`core/src/recipe-verify.ts`); this turns each into a sentence a
// non-expert can act on, and the acting differs per verdict, which is exactly why they may not collapse:
//
//   working        nothing to do.
//   not-working    something on THIS INSTALL did not do its job — the one verdict that is a fault report.
//   not-available  the MODEL cannot do this at all. Change the model; your install is fine.
//   unknown        we could not tell. Never a pass, never a failure, and it says which.
//
// ⚠️ `subject` and `isFault` are what a caller styles from. Colour alone cannot carry this: a red badge
// and an amber badge are the same badge to a colour-blind reader and to anybody reading it aloud.

export interface VerdictRow {
  readonly declared: string
  readonly path: string
  readonly outcome: Outcome
  readonly reason?: UnknownReason
  readonly checked: string
  readonly size: string
}

export interface VerdictView {
  readonly verdict: Verdict
  /** The word a person reads. */
  readonly label: string
  /** What the verdict is ABOUT — the thing to change if you want a different one. */
  readonly subject: "this run" | "this NovaClaw" | "the model" | "nothing we could see"
  /** True for exactly one verdict. A caller may show an alarm ONLY when this is true. */
  readonly isFault: boolean
  readonly tone: "good" | "bad" | "neutral" | "unsure"
  readonly meaning: string
  readonly advice: string
  /** The harness's own sentence, unchanged. Shown as well, never instead. */
  readonly summary: string
  readonly rows: readonly VerdictRow[]
  readonly directory: string
  readonly at: number
}

const bytes = (value: number | undefined): string => {
  if (value === undefined) return ""
  if (value < 1024) return `${value} bytes`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

const toRow = (check: VerifyCheckInfo): VerdictRow => ({
  declared: authorText(check.declared, 120),
  path: authorText(check.path, 120),
  outcome: check.outcome,
  ...(check.reason ? { reason: check.reason } : {}),
  checked: authorText(check.checked, 200),
  size: bytes(check.bytes),
})

/**
 * The receipt, in the words a person acts on.
 *
 * ⚠️ The `unknown` arm splits on WHY, because the two are different problems: a recipe that declares no
 * postcondition is fixable by the user in one edit (and this says how), while a measurement that failed is
 * not their fault at all. Collapsing them would leave a person staring at "I could not check" with nothing
 * to do about it.
 */
export function describeVerdict(result: VerifyResultInfo): VerdictView {
  const rows = result.checks.map(toRow)
  const base = {
    verdict: result.verdict,
    summary: authorText(result.summary, 1000),
    rows,
    directory: result.directory,
    at: result.at,
  }
  switch (result.verdict) {
    case "working":
      return {
        ...base,
        label: "Worked",
        subject: "this run",
        isFault: false,
        tone: "good",
        meaning: `Everything this recipe said it would leave behind is there: ${quoted(
          rows.filter((row) => row.outcome === "met").map((row) => row.path || row.declared),
        )}.`,
        advice: "Open the work folder to use what it made.",
      }
    case "not-working":
      return {
        ...base,
        label: "Did not work",
        subject: "this NovaClaw",
        isFault: true,
        tone: "bad",
        meaning: `This recipe should have left ${quoted(
          rows.filter((row) => row.outcome === "unmet").map((row) => row.declared),
        )} behind, and I looked in the work folder and did not find what it promised.`,
        advice:
          "Run the “Install health check” recipe to see what this computer can actually do, or open the " +
          "chat for this run and read where it stopped.",
      }
    case "not-available":
      return {
        ...base,
        label: "Not available here",
        subject: "the model",
        // ⚠️ NOT a fault, and the sentence says so in words. This arm exists so a model limit is never
        // reported as a broken install.
        isFault: false,
        tone: "neutral",
        meaning:
          "The AI model you ran this with cannot do this at all — it cannot use tools, so it could never " +
          "have written a file. Nothing is broken on this computer.",
        advice: "Run it again with a model that can use tools, and this check will mean something.",
      }
    default: {
      const noPostcondition = rows.length === 0
      // ── The run never got to exercise this computer ───────────────────────────────────────────────
      //
      // 🔴 This is the arm the 2026-08-18 defect fell through. Six cooks died on a dead model endpoint,
      // every declared file was absent, and this app rendered `label: "Did not work"` ·
      // `subject: "this NovaClaw"` · `isFault: true` — accusing the user's install of a fault that
      // belonged entirely to an endpoint. The engine now re-files those rows as unknown, and these two
      // branches are what a person then reads. Note `subject: "the model"` and `isFault: false`: a
      // caller may show an alarm ONLY on `isFault`, so this cannot render as a fault report by accident.
      if (result.cookState === "blocked")
        return {
          ...base,
          label: "Couldn't run",
          subject: "the model",
          isFault: false,
          tone: "unsure",
          meaning:
            "This run never reached the AI model, so it never actually did anything on this computer — " +
            (rows[0]?.checked ?? "the model did not answer.") +
            " There is nothing here for me to check, and nothing here points at a problem with this " +
            "computer or with your NovaClaw.",
          advice:
            "Start your model server again, or pick a model that is running, and cook this recipe once " +
            "more. Everything else is still fine.",
        }
      if (result.cookState === "stopped")
        return {
          ...base,
          label: "Stopped early",
          subject: "this run",
          isFault: false,
          tone: "unsure",
          meaning:
            "This run was stopped before it finished, so anything missing is work that never happened " +
            "rather than work that failed. That tells us nothing about this computer either way.",
          advice: "Run it again and let it finish, and I will be able to tell you what it made.",
        }
      return {
        ...base,
        label: "Can't tell",
        subject: "nothing we could see",
        isFault: false,
        tone: "unsure",
        meaning: noPostcondition
          ? "This recipe does not name any file a finished run leaves behind, so there was nothing for me to " +
            "check. That is not a pass and not a failure — I simply have no way to know."
          : "I could not check this run, so I am not going to guess. That is not a pass and not a failure.",
        advice: noPostcondition
          ? "Add the names of the files this recipe should produce, and I can check them for you next time."
          : "Read the chat for this run to see what happened, or run it again into a folder you can open.",
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Where the last cook happened — so the receipt can be shown without asking
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// Pressing Run navigates to the cook's chat, so the Recipes page unmounts. Nothing on the recipe itself
// records where it cooked (and nothing should: a cook is not a property of a recipe — the same recipe can
// be cooking in four folders at once). This is the smallest thing that closes the loop: a module-scoped
// note of the last work dir per recipe, so coming back to the app can offer the receipt instead of asking
// the user to remember a path.
//
// ⚠️ Deliberately NOT persisted. It is a convenience, not a record: a remembered folder that no longer
// exists would produce a receipt about nothing, and `verify` is a pure function of the folder anyway —
// re-running it is always cheaper than trusting a stored verdict. "Check another folder…" is the path for
// a cook this process never saw.

export interface CookRecord {
  readonly slug: string
  readonly directory: string
  readonly sessionID: string
  readonly at: number
  /**
   * The model this cook was started on, as `providerID/modelID` — `recipe.run`'s own answer, which is
   * the caller's `model` when it named one and the instance default otherwise.
   *
   * 🔴 **This field is the whole of defect 2.** Until it existed the app sent no model on run, kept
   * none, and passed none to `verify` — so the NOT AVAILABLE arm was structurally unreachable from the
   * UI, and an instance whose only model cannot call tools reported *"Did not work · about: this
   * NovaClaw"*. Both arms worked at the HTTP surface; the app simply never had a value to send.
   *
   * Optional because an instance with no usable model must send nothing rather than guess: downstream,
   * an unresolvable model is `not-measured` and never `not-applicable`.
   */
  readonly model?: string
}

const cooks = new Map<string, CookRecord>()

export const rememberCook = (record: CookRecord): void => {
  cooks.set(record.slug, record)
}

export const lastCook = (slug: string): CookRecord | undefined => cooks.get(slug)

/** Test seam, and the right thing to call if a recipe is deleted. */
export const forgetCook = (slug?: string): void => {
  if (slug === undefined) cooks.clear()
  else cooks.delete(slug)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Import / export — the shareable unit is the FOLDER
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A preview of a pasted or dropped `recipe.md`, so the user sees what they are about to store BEFORE it
 * lands. Parsed here rather than trusted: the file was written by somebody else.
 *
 * ⚠️ A deliberately forgiving, deliberately SMALL parser — it reads the same block `core/src/recipe.ts`
 * reads, and it is a preview, not the authority: the server parses the file again when it stores it, and
 * the file it stores is the bytes, not this. A disagreement between the two can only ever mislabel a
 * preview, never write the wrong thing.
 */
export interface ImportPreview {
  readonly ok: boolean
  /** Why it cannot be imported, in a sentence. Empty when `ok`. */
  readonly problem: string
  readonly name: string
  readonly description: string
  readonly needs: readonly string[]
  readonly produces: readonly string[]
  readonly body: string
  readonly bytes: number
  /** Frontmatter lines this build does not model — kept, and SAID, rather than silently dropped. */
  readonly unmodelled: readonly string[]
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/
const BOM = String.fromCharCode(0xfeff)

/** Longest a pasted file may be, mirroring `Recipe.IMPORT_CAP`. Refused here so the refusal is instant. */
export const IMPORT_CAP = 1024 * 1024

/**
 * One frontmatter line, classified ONCE.
 *
 * 🔴 **The reason this exists is that the preview used to read the block twice and disagree with
 * itself.** `needs:` may be written inline (`needs: gcc, python3`) or as a YAML block, and a block's
 * `  - gcc` lines only mean anything relative to the `needs:` above them. One pass tracked that
 * state; the pass that decided which lines the build does not model did not, so a block item matched
 * no field pattern and was reported as an unused line — *while the value it carried was shown as a
 * need on the same screen*. The user was told, about untrusted content they were deciding whether to
 * run, both that a fact was read and that it was ignored.
 *
 * The class is *two derivations of "which lines were consumed" that can disagree*, and the fix is
 * that there is now only one: every reader below asks this function, so a line cannot be consumed by
 * one and orphaned by another.
 */
type FrontmatterLine =
  /** `key: value` (value may be empty, which is what opens a block). */
  | { readonly kind: "field"; readonly key: string; readonly value: string; readonly raw: string }
  /** `  - item`, belonging to the `key:` that opened above it. */
  | { readonly kind: "item"; readonly key: string; readonly value: string; readonly raw: string }
  /** Blank, or something that is neither — indentation-only YAML, a comment, a stray sentence. */
  | { readonly kind: "other"; readonly raw: string }

const FIELD = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/
const BLOCK_ITEM = /^\s+-\s*(.*)$/

/** Fields whose value this build reads. Everything else is carried in the file and SAID on screen. */
const MODELLED = new Set(["name", "description", "needs", "produces"])
/** …of those, the ones a YAML block may belong to. `name:` followed by `- x` is not a list. */
const LIST_FIELDS = new Set(["needs", "produces"])

const readFrontmatter = (lines: readonly string[]): FrontmatterLine[] => {
  const out: FrontmatterLine[] = []
  let block: string | undefined
  for (const raw of lines) {
    const field = FIELD.exec(raw.trim())
    if (field) {
      const key = field[1]!.toLowerCase()
      const value = field[2]!.trim()
      out.push({ kind: "field", key, value, raw })
      // An empty value is what opens a block; a value on the same line closes any previous one.
      block = value === "" ? key : undefined
      continue
    }
    const item = block === undefined ? null : BLOCK_ITEM.exec(raw)
    if (item) {
      out.push({ kind: "item", key: block!, value: (item[1] ?? "").trim(), raw })
      continue
    }
    out.push({ kind: "other", raw })
    block = undefined
  }
  return out
}

/** Unquote a scalar the author wrote as `"…"` or `'…'`. */
const unquoted = (value: string): string => value.replace(/^["'](.*)["']$/, "$1")

/** Everything a list field carries, from either spelling, in author order. */
const carried = (parsed: readonly FrontmatterLine[], key: string): string[] =>
  parsed
    .flatMap((line) =>
      line.kind === "field" && line.key === key
        ? line.value.split(",")
        : line.kind === "item" && line.key === key
          ? [line.value]
          : [],
    )
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")

export function previewImport(markdown: string): ImportPreview {
  const empty = {
    name: "",
    description: "",
    needs: [] as string[],
    produces: [] as string[],
    body: "",
    bytes: markdown.length,
    unmodelled: [] as string[],
  }
  if (markdown.length > IMPORT_CAP)
    return { ...empty, ok: false, problem: "That file is too big to be a recipe — a recipe is prose somebody wrote." }
  const text = markdown.startsWith(BOM) ? markdown.slice(BOM.length) : markdown
  const match = FRONTMATTER.exec(text)
  const lines = match ? match[1].split(/\r?\n/) : []
  const body = (match ? text.slice(match[0].length) : text).trim()
  const parsed = readFrontmatter(lines)
  let name = ""
  let description = ""
  const unmodelled: string[] = []
  for (const line of parsed) {
    if (line.kind === "field" && line.key === "name") name = unquoted(line.value)
    else if (line.kind === "field" && line.key === "description") description = unquoted(line.value)
    // A line is "not used" only when nothing above CONSUMED it. A block item under `needs:` is read;
    // an item under a field this build does not model is not, and is still reported as carried.
    else if (line.kind === "field" && MODELLED.has(line.key)) continue
    else if (line.kind === "item" && LIST_FIELDS.has(line.key)) continue
    else if (line.raw.trim() !== "") unmodelled.push(authorText(line.raw, 120))
  }
  const preview = {
    name: authorText(name, 80),
    description: authorText(description, 400),
    needs: carried(parsed, "needs").map((entry) => authorText(entry, 120)),
    produces: carried(parsed, "produces").map((entry) => authorText(entry, 120)),
    body: authorBody(body, 20_000),
    bytes: markdown.length,
    unmodelled,
  }
  if (body === "")
    return {
      ...preview,
      ok: false,
      problem: "That file has no prompt. The prompt IS the recipe, so there would be nothing to cook.",
    }
  return { ...preview, ok: true, problem: "" }
}

/**
 * The filename an export is offered under. Derived from the SLUG, never from the recipe's own name: the
 * name is a stranger's string and this one becomes a path on the user's disk.
 */
export function exportFilename(slug: string): string {
  const safe = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return `${safe || "recipe"}.recipe.zip`
}

/**
 * What a person is told they are getting when they export.
 *
 * The ZIP is the complete portable unit. Paste remains useful for prose-only recipes, but that path is
 * labelled asset-free at the control rather than weakening the normal export.
 */
export function describeExport(view: RecipeView): string {
  const carried =
    view.assets.length === 0
      ? "its recipe.md"
      : `its recipe.md and ${view.assets.length} asset${view.assets.length === 1 ? "" : "s"}`
  return `This ZIP carries the complete recipe folder — ${carried}, with every byte preserved. Anybody can import it into their own NovaClaw.`
}

// The Skills app's presentation logic, kept OUT of the page so every state is unit-testable: an
// enabled skill, a denied one, one with nothing declared, one whose provenance we cannot place, and
// one whose metadata is hostile. `skills.test.ts` walks all of them.
//
// ─── WHAT THE ENGINE ACTUALLY GIVES US ────────────────────────────────────────────────────────────
// `GET /api/skill` returns `SkillV2.Info` and that struct has exactly FIVE fields
// (`packages/schema/src/skill.ts`):
//
//     name · description? · slash? · location · content
//
// There is no `capabilities`, no `trust`, no `compatibility`, no `version`, no `enabled`, and no
// pointer back to the source it was loaded from. The frontmatter parser accepts exactly
// `name`/`description`/`slash` (`packages/core/src/skill.ts`), so a skill author has nowhere to
// declare a capability even if they wanted to. **That absence is a fact this app must SHOW, not
// paper over** — an empty "capabilities" panel reads as "this skill can do nothing", which is the
// opposite of true.
//
// So everything below is derived from the two things we can actually observe:
//   · the skill's `location` on disk, against the instance's own paths (`/path` → cache, config)
//     and the user's configured sources (`config.skills`), which is how "where did this come
//     from" is answered as an OBSERVATION rather than a claim;
//   · the skill's own `content`, which is the literal text the `skill` tool pastes into the
//     conversation (`core/src/tool/skill.ts` → `toModelOutput`) — i.e. the real answer to "what
//     does turning this on change".
//
// ─── THE FRAMING RULE ─────────────────────────────────────────────────────────────────────────────
// A skill's name, description and body are ATTACKER-CONTROLLED for any skill the user did not
// write, and one of them (`description`) is copied verbatim into every system prompt by
// `SkillGuidance.render`. Two consequences are baked into the functions here:
//   1. Text that came from a skill goes through `authorText`, which strips the invisible and
//      bidi-override characters that let a string lie about its own contents, and bounds its
//      length. Solid escapes markup for us; this handles what escaping does not.
//   2. Nothing here returns a verdict about what a skill DOES. `scanMentions` reports which words
//      occur in the text and how often — a fact the reader can check by looking — and never
//      "this skill runs commands".

/** The wire shape of `GET /api/skill` (`SkillV2.Info`). All five fields, nothing invented. */
export interface SkillInfo {
  readonly name: string
  readonly description?: string
  readonly slash?: boolean
  readonly location: string
  readonly content: string
}

/** The slice of `GET /path` this app reads. Both optional — an older instance may send neither. */
export interface InstancePaths {
  readonly cache?: string
  readonly config?: string
}

export interface SkillContext {
  readonly paths: InstancePaths
  /** `config.skills` — the sources the user configured: http(s) URLs and absolute directory paths. */
  readonly sources: readonly string[]
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Text safety
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Characters that let a string misrepresent itself on screen: the bidi overrides and isolates
 * (a skill named with U+202E renders its trailing text reversed, so `troop.exe` reads as
 * `exe.poort`), the directional marks, and the zero-width joiners/space/BOM that hide a word
 * break or pad a name past a truncation boundary.
 *
 * ⚠️ Written as escapes ON PURPOSE — typing the literal characters into this file would put them
 * in the bundle and in every grep result over it.
 */
const INVISIBLE = /[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

/** C0/C1 controls plus every kind of line break — folded to a space for single-line display. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g

/**
 * One line of text that came from a skill's author, made safe to put on screen.
 *
 * Removes the invisible/bidi characters, folds controls and newlines to spaces, collapses runs of
 * whitespace, trims, and truncates to `max` with an ellipsis. Returns `""` for nothing at all — the
 * caller decides what an empty field should say, because "no description" and "a description of
 * three zero-width spaces" must not look different by accident.
 *
 * ⚠️ This is NOT the XSS defence. Solid escapes text nodes; this file never builds HTML. This is
 * the defence against a string that renders as something other than what it is.
 */
export function authorText(value: string | undefined, max = 240): string {
  if (typeof value !== "string") return ""
  const flat = value.replace(INVISIBLE, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return flat.slice(0, Math.max(0, max - 1)).trimEnd() + "…"
}

/**
 * The multi-line body, made safe to put in a `<pre>`: invisible/bidi characters removed, controls
 * other than tab/newline removed, line endings normalized. Line breaks SURVIVE — the body is the
 * one place a reader is meant to see the text as the author laid it out.
 */
export function authorBody(value: string | undefined, maxChars = 200_000): string {
  if (typeof value !== "string") return ""
  const clean = value
    .replace(INVISIBLE, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g, "")
  return clean.length <= maxChars ? clean : clean.slice(0, maxChars) + "\n…"
}

/**
 * A skill's name as a heading. A skill whose name is blank once the invisibles are gone gets a
 * placeholder rather than an empty heading — an unnamed row in a list of things you are about to
 * trust is worse than a labelled one.
 */
export function displayName(skill: SkillInfo): string {
  return authorText(skill.name, 80) || "(unnamed skill)"
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Provenance — where the file actually is
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value)

/** Trailing separators off, backslashes to slashes. Comparison form only — never displayed. */
function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "")
}

/** A Windows path (drive letter or a backslash) compares case-insensitively; a POSIX one does not. */
function caseless(value: string): boolean {
  return /^[a-zA-Z]:/.test(value) || value.includes("\\")
}

/** True when `child` is `parent` itself or sits underneath it. */
export function isUnder(parent: string, child: string): boolean {
  const p = normalize(parent)
  const c = normalize(child)
  if (p === "") return false
  const fold = caseless(parent) || caseless(child)
  const a = fold ? p.toLowerCase() : p
  const b = fold ? c.toLowerCase() : c
  return b === a || b.startsWith(a + "/")
}

/** The folder holding the skill file — the base directory the `skill` tool hands the model. */
export function skillFolder(location: string): string {
  const cut = Math.max(location.lastIndexOf("/"), location.lastIndexOf("\\"))
  return cut > 0 ? location.slice(0, cut) : location
}

/**
 * Where the skill came from, as an OBSERVATION about the file on disk.
 *
 * ⚠️ `SkillV2.Info` carries no source pointer, so this is derived by containment rather than
 * reported by the engine. Each arm is still a fact:
 *   `downloaded`  the file sits under `<cache>/skills`, and the ONLY writer of that tree is
 *                 `SkillDiscovery.pull` — nothing else puts a skill there. The hash directory is a
 *                 `Bun.hash` of the base URL and cannot be reversed in a browser, so we name the
 *                 configured web sources as candidates rather than claiming one of them.
 *   `instance`    under NovaClaw's own config folder (`<config>/skill` or `<config>/skills`).
 *   `configured`  under one of the folders in `config.skills`, and we name which.
 *   `local`       somewhere else on this computer — a project's own skill folder, most often.
 * The longest matching parent wins, so a configured source nested inside the config folder is
 * reported as the configured source rather than as the folder that contains it.
 */
export type Origin =
  | { readonly kind: "downloaded"; readonly folder: string; readonly candidates: readonly string[] }
  | { readonly kind: "instance"; readonly folder: string }
  | { readonly kind: "configured"; readonly folder: string; readonly source: string }
  | { readonly kind: "local"; readonly folder: string }

export function describeOrigin(skill: SkillInfo, context: SkillContext): Origin {
  const folder = skillFolder(skill.location)
  const candidates: { parent: string; make: () => Origin }[] = []

  if (context.paths.cache) {
    const root = `${normalize(context.paths.cache)}/skills`
    if (isUnder(root, skill.location))
      candidates.push({
        parent: root,
        make: () => ({ kind: "downloaded", folder, candidates: context.sources.filter(isHttpUrl) }),
      })
  }
  if (context.paths.config)
    for (const leaf of ["skill", "skills"]) {
      const root = `${normalize(context.paths.config)}/${leaf}`
      if (isUnder(root, skill.location)) candidates.push({ parent: root, make: () => ({ kind: "instance", folder }) })
    }
  for (const source of context.sources) {
    if (isHttpUrl(source)) continue
    if (isUnder(source, skill.location))
      candidates.push({ parent: normalize(source), make: () => ({ kind: "configured", folder, source }) })
  }

  if (candidates.length === 0) return { kind: "local", folder }
  // Longest parent = most specific claim.
  return candidates.reduce((best, item) => (item.parent.length > best.parent.length ? item : best)).make()
}

/** True when the skill's bytes were fetched over the network by this instance. */
export const isRemote = (origin: Origin) => origin.kind === "downloaded"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Enablement — the engine's ONE gate, mirrored read-only
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The engine has no per-skill on/off switch. The only thing that decides whether an agent may open
 * a skill is the `skill` permission action, evaluated against the skill's NAME:
 *
 *     PermissionV2.evaluate("skill", skill.name, agent.permissions)   // core/src/skill.ts
 *
 * `evaluate` takes the LAST matching rule across the ruleset and answers a synthetic `ask` when
 * nothing matches (`core/src/permission.ts`). The three lines below mirror that exactly, and
 * `skills.test.ts` pins the wildcard half against `@novaclaw/core/util/wildcard` so a divergence
 * fails rather than quietly telling a user their skill is allowed when it is not.
 */
export interface PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

export interface AgentLike {
  readonly id: string
  readonly hidden?: boolean
  readonly permissions?: readonly PermissionRule[]
}

/** `core/src/util/wildcard.ts`'s `match`, minus its `process.platform` read (see the test). */
export function wildcardMatch(input: string, pattern: string, windows = false): boolean {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", windows ? "si" : "s").test(normalized)
}

/**
 * The rule that decides this skill for this agent — the engine's `evaluate`, verdict included.
 *
 * ⚠️ `windows` is not cosmetic. `core/src/util/wildcard.ts` compiles its regex with the `i` flag
 * when `process.platform === "win32"`, so on a Windows instance a deny rule written `writer` ALSO
 * denies a skill named `Writer`. The renderer has no `process.platform` for the SERVER (which may
 * be a different machine entirely — "never assume the UI and the runtime share a process or
 * machine"), so the caller derives it from the instance's own reported paths. Getting this wrong
 * under-reports a deny, i.e. tells a user a skill is available when the engine refuses it.
 */
export function evaluateSkill(
  name: string,
  rules: readonly PermissionRule[] = [],
  windows = false,
): PermissionRule {
  return (
    [...rules]
      .reverse()
      .find(
        (rule) => wildcardMatch("skill", rule.action, windows) && wildcardMatch(name, rule.resource, windows),
      ) ?? {
      action: "skill",
      resource: "*",
      effect: "ask",
    }
  )
}

/** Whether the INSTANCE is a Windows host, judged by the paths it reports about itself. */
export function instanceIsWindows(paths: InstancePaths): boolean {
  return [paths.config, paths.cache].some((value) => typeof value === "string" && caseless(value))
}

/**
 * What the whole agent set does with one skill, in the vocabulary a person reads:
 *   `open`     every agent may open it without asking.
 *   `asks`     at least one agent will stop and ask you first, and none refuse.
 *   `mixed`    agents disagree — some refuse it, others do not.
 *   `blocked`  every agent refuses it.
 *   `unknown`  we could not read the agent list, so we say nothing rather than guess.
 */
export type Enablement =
  | { readonly state: "unknown" }
  | { readonly state: "open" | "asks" | "mixed" | "blocked"; readonly allow: number; readonly ask: number; readonly deny: number }

export function describeEnablement(
  name: string,
  all: readonly AgentLike[] | undefined,
  windows = false,
): Enablement {
  // `hidden` agents are NovaClaw's own internal ones (compaction, title, summary — measured live on
  // 2026-08-18: 3 of the 7 an instance ships). "All 7 of your agents" would be a count of a set the
  // user has never seen and cannot change, so the sentence is about the agents they DO have.
  const agents = all?.filter((agent) => agent.hidden !== true)
  if (!agents || agents.length === 0) return { state: "unknown" }
  let allow = 0
  let ask = 0
  let deny = 0
  for (const agent of agents) {
    const effect = evaluateSkill(name, agent.permissions, windows).effect
    if (effect === "allow") allow++
    else if (effect === "deny") deny++
    else ask++
  }
  const state = deny === agents.length ? "blocked" : deny > 0 ? "mixed" : ask > 0 ? "asks" : "open"
  return { state, allow, ask, deny }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// What the instructions MENTION — a text search, never a verdict
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ **This is a word search over the skill's own text, and the UI must say so.**
 *
 * The skill format declares no capabilities, so there is nothing to disclose that the author
 * committed to. What a reader can still be given is a shortcut into a long document: the words in
 * it that are worth stopping on, with their counts, so the claim stays checkable by scrolling up.
 *
 * It is deliberately NOT a risk score and must never be rendered as one. A skill can shell out
 * without the word "bash" appearing anywhere, and a skill that says "never run `sudo`" matches
 * `sudo`. Both directions are wrong, which is exactly why the output is *occurrences of a word*
 * rather than *a capability this skill has*.
 */
export type MentionTopic = "run" | "network" | "secrets" | "modify" | "install"

const TERMS: Readonly<Record<MentionTopic, readonly string[]>> = {
  run: ["sudo", "bash", "shell", "powershell", "cmd.exe", "terminal", "command line", "subprocess", "os.system"],
  network: ["http://", "https://", "curl", "wget", "fetch(", "upload", "download", "webhook"],
  secrets: ["password", "api key", "api_key", "apikey", "secret", "credential", "private key", ".env", "token"],
  modify: ["rm -rf", "overwrite", "delete the", "git push", "force push", "chmod", "truncate"],
  install: ["npm install", "pip install", "apt install", "apt-get", "brew install", "cargo install", "winget"],
}

export interface Mention {
  readonly topic: MentionTopic
  /** The exact strings found, with how many times each occurs. Sorted by count, then alphabetically. */
  readonly terms: readonly { readonly term: string; readonly count: number }[]
}

/** Non-overlapping occurrences of `term`, case-insensitively. No regex — the terms contain `.`, `(`, `-`. */
function countOccurrences(haystack: string, term: string): number {
  if (term === "") return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(term, from)
    if (at < 0) return count
    count++
    from = at + term.length
  }
}

function scanMentionBody(body: string): Mention[] {
  const haystack = body.toLowerCase()
  const out: Mention[] = []
  for (const topic of Object.keys(TERMS) as MentionTopic[]) {
    const terms = TERMS[topic]
      .map((term) => ({ term, count: countOccurrences(haystack, term) }))
      .filter((hit) => hit.count > 0)
      .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    if (terms.length > 0) out.push({ topic, terms })
  }
  return out
}

export function scanMentions(content: string): Mention[] {
  return scanMentionBody(authorBody(content))
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Compatibility — the honest answer is "the format has no such field"
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether this build can say anything about whether a skill fits this instance.
 *
 * It cannot, and that is the whole finding. `SkillV2.Info` has no version, no engine range, no
 * platform, no required-tool list; the frontmatter parser accepts three keys and none of them is
 * about compatibility. The remote index (`SkillDiscovery.IndexSkill`) carries an optional `version`
 * but it is used only to decide whether to re-download and is DISCARDED before the skill reaches
 * this app.
 *
 * Exported as a constant rather than written into the page so that the day the engine grows the
 * field, the compiler points at the one place that has to change.
 */
export const COMPATIBILITY_DECLARED = false

/** Likewise: the format offers no place to declare a capability, so nothing here is "undeclared by choice". */
export const CAPABILITIES_DECLARED = false

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The row the page renders
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface SkillView {
  readonly key: string
  readonly name: string
  readonly rawName: string
  readonly description: string
  readonly hasDescription: boolean
  readonly slash: boolean
  readonly location: string
  readonly folder: string
  readonly body: string
  readonly origin: Origin
  readonly remote: boolean
  readonly enablement: Enablement
  readonly mentions: readonly Mention[]
}

export function toView(skill: SkillInfo, context: SkillContext, agents?: readonly AgentLike[]): SkillView {
  const origin = describeOrigin(skill, context)
  const description = authorText(skill.description, 400)
  const body = authorBody(skill.content)
  return {
    // The engine dedups by name (last source wins), so the raw name is a stable key even when the
    // DISPLAY name has been sanitized down to nothing.
    key: skill.name,
    name: displayName(skill),
    rawName: skill.name,
    description,
    hasDescription: description !== "",
    slash: skill.slash === true,
    location: skill.location,
    folder: skillFolder(skill.location),
    body,
    origin,
    remote: isRemote(origin),
    enablement: describeEnablement(skill.name, agents, instanceIsWindows(context.paths)),
    mentions: scanMentionBody(body),
  }
}

/** Alphabetical by the name a person sees, with remote skills NOT hoisted — sorting by trust would
 *  imply a ranking we have not earned. The origin badge does that work in the row itself. */
export function sortViews(views: readonly SkillView[]): SkillView[] {
  return [...views].sort((a, b) => a.name.localeCompare(b.name))
}

/** Case-insensitive substring search over the words a person can actually see. */
export function filterViews(views: readonly SkillView[], query: string): SkillView[] {
  const needle = authorText(query, 120).toLowerCase()
  if (needle === "") return [...views]
  return views.filter(
    (view) => view.name.toLowerCase().includes(needle) || view.description.toLowerCase().includes(needle),
  )
}

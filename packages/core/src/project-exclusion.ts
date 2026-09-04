export * as ProjectExclusion from "./project-exclusion"

import path from "node:path"
import { Effect, Schema } from "effect"
import { GlobMatch } from "./util/glob-match"
import { FSUtil } from "./fs-util"
import { ProjectFileCache } from "./project-file-cache"

/**
 * `novaclaw.json`'s `exclude` section, ENFORCED.
 *
 * The requirement: *"Files/Project settings shows what Nova must not read … Keep model read
 * eligibility distinct from watcher/build ignores and enforce it below all agentic file tools."*
 *
 * 🔴 **This existed as a promise before it existed as a mechanism.** The section was declared in
 * `@novaclaw/schema/project-file` and DISPLAYED in Settings → Project under the words *"Never
 * read"*, and nothing anywhere consulted it — measured 2026-08-18 by resolving and reading an
 * excluded file end to end through `LocationMutation.resolve` + `ReadToolFileSystem.read`, which
 * returned the file's contents. A UI that tells the user Nova will not read a path while Nova reads
 * it is worse than no setting at all, so the enforcement is the load-bearing half of that item.
 *
 * ## Where it is enforced, and why THERE
 *
 * Underneath the tools, at {@link https://…|`LocationMutation.resolve`} — the one function every
 * path-taking agentic tool already funnels caller-supplied paths through (`test/
 * tool-path-classification.test.ts` is the standing guard that keeps it that way). Enforcing there
 * means a NEW tool inherits the refusal instead of having to remember it, and it means the check
 * runs on the CANONICAL path — after `realPath`, after `..` collapsing, after Windows case folding
 * — so a path alias cannot spell its way around it.
 *
 * The two enumerating tools (`glob`, `grep`) additionally filter their RESULTS, because they never
 * name the files they return: `resolve` only sees their search root. See {@link screenAll}.
 *
 * ⚠️ **Residual, stated rather than hidden.** `grep` runs ripgrep, so the ripgrep PROCESS opens
 * excluded files while matching; the filter drops those rows before anything reaches the model.
 * The promise this enforces is *"an excluded file's content never enters the model's context"*, not
 * *"no process on this machine opens it"*. The second is not achievable while search is a
 * subprocess, and claiming it would be the same kind of lie the `exclude` section already was.
 *
 * ## READ eligibility, not a write policy
 *
 * The item says **model read eligibility** and the UI says **Excluded paths**, so that is exactly what
 * this refuses: operations that would put the file's bytes in front of the model. A pure write
 * (`write`, `write-hex`, `trash`, a bash redirect target) passes `readsContent: false` and is NOT
 * refused — *"Nova may create this file but its dedicated tools may not read it"* is a coherent stance and the one the
 * user asked for. `edit` and `apply_patch` READ before they write, so they take the default and are
 * refused.
 *
 * 🔴 The flag DEFAULTS to "this reads", which is the fail-closed direction: a tool added later that
 * forgets to classify itself gets the refusal, not the bypass.
 *
 * ## Not the watcher/build ignore list
 *
 * `filesystem/ignore.ts` answers a different question — *"is this worth watching / worth indexing"*
 * — and its answer is a performance judgement about `node_modules`, `dist` and `.DS_Store`. This
 * answers *"did the user forbid this"*, and its answer is a privacy promise. The two
 * must stay distinct: folding them together would make a build-output tweak
 * silently widen or narrow what Nova is allowed to see, and would make the exclusion list unable to
 * say `node_modules is fine to read here`.
 */

/**
 * ## Pattern semantics — decided here, per principle 10
 *
 * **gitignore-style globs**, because the product imports a `.gitignore` and a
 * format that reinterpreted the lines it imported would be a trap. Concretely:
 *
 * - A pattern is matched against the target's path **relative to the directory holding the
 *   `novaclaw.json` that declared it**, with `/` separators. Never against the string the caller
 *   typed — that is what closes the alias vectors.
 * - **A bare name matches at any depth.** `secret.txt`, `*.env` and `node_modules` match wherever
 *   they occur below the project root. This is what a non-expert means when they type a name.
 * - **A pattern containing a `/` is ANCHORED to the project root.** `build/out` matches
 *   `<root>/build/out` and nothing else; a leading `/` (as in `/secrets`) anchors and is stripped.
 * - **A trailing `/` means directory-only**: `logs/` never matches a FILE called `logs`.
 * - **Matching a directory excludes everything beneath it.** Excluding `secrets` excludes
 *   `secrets/keys/id_rsa`; nothing has to be listed twice.
 * - **`!` re-includes**, and **the last matching pattern wins** — gitignore's order rule, so
 *   `["*.env", "!.env.example"]` reads the way it looks.
 * - `**` crosses separators, `*` does not, `?` is one character, and dotfiles match normally
 *   (a privacy list that could not name `.env` would be useless).
 * - A blank line is ignored; a line starting with `#` is a comment.
 * - `\` is accepted as a path separator, not as gitignore's escape character. This file is edited by
 *   people on Windows who will type `build\out`, and per *teach, don't gatekeep* the surprising
 *   reading is the wrong one to pick. The cost is that a literal `*` or `!` in a filename cannot be
 *   escaped; a `[*]` character class still expresses it.
 * - **Case-insensitive on Windows and macOS, case-sensitive on Linux** — the platform's own
 *   filesystem rule. `git` is case-sensitive everywhere, and copying that here would let
 *   `SECRETS/key` walk past a `secrets/` line on the two platforms where those name one file. For a
 *   privacy guard the fail-closed reading wins over fidelity to git.
 *
 * ⚠️ **One gitignore rule deliberately NOT copied:** git cannot re-include a file whose parent
 * directory is excluded. Here it can (`["secrets", "!secrets/README.md"]` works). The git rule
 * exists as a directory-traversal optimisation, and reproducing it would mean a user's `!` line
 * silently doing nothing — the failure mode this whole module exists to end.
 */
export interface Rule {
  /** The line as the user wrote it — this is what a refusal quotes back. */
  readonly source: string
  readonly negated: boolean
  readonly directoryOnly: boolean
  /** Glob for the target ITSELF. */
  readonly self: string
  /** Glob for anything BELOW the target. */
  readonly under: string
}

export interface Matcher {
  readonly rules: readonly Rule[]
  readonly caseInsensitive: boolean
}

export const EMPTY: Matcher = { rules: [], caseInsensitive: false }

/** The platform's own answer, not git's. See the semantics note above. */
export const caseInsensitiveHere = () => process.platform === "win32" || process.platform === "darwin"

const toPosix = (value: string) => value.replaceAll("\\", "/")

/**
 * Would this module honour `line`, and as what?
 *
 * Exported for the `.gitignore` importer (`project-gitignore.ts`), which must not carry a second
 * copy of the semantics documented above — a suggestion listing patterns this module silently
 * discards is the same class of lie as an `exclude` section nothing enforced. `undefined` means the
 * line contributes nothing.
 */
export const ruleFor = (line: string): Rule | undefined => toRule(line)

function toRule(line: string): Rule | undefined {
  const raw = line.trim()
  if (raw.length === 0 || raw.startsWith("#")) return undefined
  const negated = raw.startsWith("!")
  let body = toPosix(negated ? raw.slice(1) : raw).trim()
  const directoryOnly = body.endsWith("/")
  while (body.endsWith("/")) body = body.slice(0, -1)
  while (body.startsWith("./")) body = body.slice(2)
  const anchored = body.startsWith("/") || body.includes("/")
  while (body.startsWith("/")) body = body.slice(1)
  // Collapse any interior `..`/`.` so a pattern cannot address outside the root it is relative to.
  body = toPosix(path.posix.normalize(body))
  // A pattern that still climbs after normalising is DROPPED, not clamped. `../secrets` cannot mean
  // anything here — the list governs the folder that declared it — and silently rewriting it to
  // `secrets` would exclude a real, different directory the user never named.
  if (body.length === 0 || body === "." || body === ".." || body.startsWith("../")) return undefined
  const self = anchored ? body : `**/${body}`
  return { source: raw, negated, directoryOnly, self, under: `${self}/**` }
}

/**
 * Compile a project's `exclude` lines.
 *
 * Memoised on the joined source, because `LocationMutation.resolve` runs on every file operation
 * and `GlobMatch` compiles a matcher per pattern. The cache is bounded and keyed on the
 * TEXT, so an edited `novaclaw.json` simply misses it.
 */
const compiled = new Map<string, Matcher>()
const COMPILE_CACHE_MAX = 64

export function compile(patterns: readonly string[]): Matcher {
  const caseInsensitive = caseInsensitiveHere()
  // 🔴 The `\x00` below is a SEPARATOR, and it must stay an ESCAPE rather than a literal byte. It
  // shipped as two raw NULs on 2026-08-18: a raw NUL takes the whole file out of ripgrep and
  // `git diff`, which is why `invisible-characters.test.ts` can never sanction one with a ledger row.
  //
  // ⚠️ Deleting it instead would pass that sweep and silently break this cache: with no separator
  // `["a","bc"]` and `["ab","c"]` join to the same key, so the second folder would be filtered by the
  // first folder's rules — a privacy guard applying the wrong list. Spelled `\x00` to match
  // `tool/kb.ts` and `llm/.../tool-recovery.ts`, which solve the same problem the same way; this file
  // now joins them in that suite's REPAIRED ratchet, so removing the separator fails a test.
  const key = `${caseInsensitive ? "i" : "s"}\x00${patterns.join("\x00")}`
  const held = compiled.get(key)
  if (held) return held
  const rules = patterns.map(toRule).filter((rule): rule is Rule => rule !== undefined)
  const matcher: Matcher = { rules, caseInsensitive }
  compiled.set(key, matcher)
  if (compiled.size > COMPILE_CACHE_MAX) {
    const oldest = compiled.keys().next()
    if (!oldest.done) compiled.delete(oldest.value)
  }
  return matcher
}

export interface Verdict {
  readonly excluded: boolean
  /** The pattern that decided it, verbatim — a refusal has to be able to name it. */
  readonly pattern?: string
}

const NOT_EXCLUDED: Verdict = { excluded: false }

/**
 * Match one project-root-relative path.
 *
 * `relative` must already be relative and posix-separated; {@link relativeWithin} produces it.
 * Later rules win, which is how `!` re-inclusion reads correctly.
 */
export function evaluate(matcher: Matcher, relative: string, isDirectory: boolean): Verdict {
  if (matcher.rules.length === 0) return NOT_EXCLUDED
  const target = toPosix(relative).replace(/^\/+/, "").replace(/\/+$/, "")
  if (target.length === 0 || target === ".") return NOT_EXCLUDED
  const options = { dot: true, nocase: matcher.caseInsensitive } as const
  let verdict: Verdict = NOT_EXCLUDED
  for (const rule of matcher.rules) {
    const hit =
      (GlobMatch.match(rule.self, target, options) && (!rule.directoryOnly || isDirectory)) ||
      GlobMatch.match(rule.under, target, options)
    if (!hit) continue
    verdict = rule.negated ? NOT_EXCLUDED : { excluded: true, pattern: rule.source }
  }
  return verdict
}

/**
 * Fold the two Windows path aliases that survive `realPath`.
 *
 * 🔴 **MEASURED, and it was a live bypass.** `LocationMutation.resolve` canonicalises with Effect's
 * `fs.realPath`, which is node's `fs.promises.realpath` — and on Windows that does **not** expand an
 * 8.3 short name. Probed 2026-08-18 on this laptop, where NTFS 8.3 generation is ON:
 *
 * ```
 * realpathSync       : …\Temp\snfeoEu7\LONGSE~1\a.txt        ← alias survives
 * realpathSync.native: …\Temp\snfeoEu7\Long Secret Folder\a.txt
 * ```
 *
 * So `exclude: ["Long Secret Folder/"]` was enforced against `Long Secret Folder\a.txt` and NOT
 * against `LONGSE~1\a.txt` — the same file, two names, one of them free. `realpathSync.native` folds
 * it (that is what `FSUtil.normalizePath` calls), so the fold happens here rather than in
 * `LocationMutation`: `resolve`'s `canonical` is also the PERMISSION RESOURCE that user rules are
 * saved against, and quietly re-spelling it would invalidate stored verdicts for a bug that only
 * concerns matching.
 *
 * ⚠️ Gated on a `~<digit>` segment and on the `\\?\` prefix rather than run always. `.native` is a
 * synchronous filesystem call and `screenAll` runs per row of a grep — a thousand-match search must
 * not pay two thousand of them. Both markers are structural: an 8.3 alias always carries `~n`, and
 * an extended-length path always starts `\\?\`. A path with neither cannot be either alias.
 */
const SHORT_NAME = /~\d/
const EXTENDED_PREFIX = /^[\\/]{2}\?[\\/]/

function unalias(value: string): string {
  if (process.platform !== "win32") return value
  const stripped = EXTENDED_PREFIX.test(value) ? value.replace(EXTENDED_PREFIX, "") : value
  if (!SHORT_NAME.test(stripped)) return stripped
  return FSUtil.normalizePath(stripped)
}

/**
 * The path of `canonical` relative to `root`, posix-separated — or `undefined` when it is not
 * inside `root` at all.
 *
 * ⚠️ `path.relative` is the containment test AND the normaliser, which is deliberate: on win32 it
 * is case-insensitive, matching the filesystem, and it collapses `..`. Both inputs are expected to
 * be canonical already (`LocationMutation.resolve` has run `realPath`) — plus {@link unalias} for
 * the two things `realPath` misses — so a symlink cannot make two strings out of one file here.
 */
export function relativeWithin(root: string, canonical: string): string | undefined {
  const rel = path.relative(unalias(root), unalias(canonical))
  if (rel === "") return "."
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../")) return undefined
  return toPosix(rel)
}

/** What one `novaclaw.json` declares, resolved and compiled. */
export interface Declaration {
  /** The directory holding the file — every pattern is relative to THIS. */
  readonly root: string
  /** The file itself, so a refusal can tell the user where the rule lives. */
  readonly file: string
  readonly patterns: readonly string[]
  readonly matcher: Matcher
}

/**
 * The exclusion declaration governing `directory`, or `undefined` when nothing does.
 *
 * ⚠️ Asked about the TARGET's directory, not the session's. The project that declares an exclusion
 * is the one that CONTAINS the file, which is the only reading that survives all three shapes at
 * once: a nested `novaclaw.json` in a subfolder, an absolute path naming a file in the session's
 * own project from outside it, and a path into a different project entirely. Anchoring on the
 * session folder instead would make the answer depend on how the caller spelled the path — which is
 * precisely the bypass class this is here to close.
 *
 * ⚠️ **`boundary` is a DIFFERENT axis and does not weaken that.** `directory` is where the search
 * STARTS; `boundary` is how far up it may climb — the caller's own trusted root, the session's
 * selected working folder. The start stays anchored on the target, so none of the three shapes above
 * changes; the boundary only decides whether a `novaclaw.json` at the session root is allowed to
 * govern a file in a subfolder. It must be, and outside a git repository it previously was not.
 */
export const declarationFor = Effect.fn("ProjectExclusion.declarationFor")(function* (
  directory: string,
  boundary: string,
) {
  const projects = yield* ProjectFileCache.Service
  const entry = yield* projects.read(directory, boundary)
  // Empty exclusion fields on a fault are a presentation fallback, never an authorization. Every
  // path-taking agentic tool passes through this declaration seam, so failing it closes reads,
  // enumerations and mutations together without duplicating the classification in each tool.
  yield* ProjectFileCache.refuseFault(entry)
  if (entry.root === undefined || entry.file === undefined || entry.exclude.length === 0) return undefined
  return {
    root: entry.root,
    file: entry.file,
    patterns: entry.exclude,
    matcher: compile(entry.exclude),
  } satisfies Declaration
})

/** Screen one canonical path against one declaration. */
export function screen(declaration: Declaration, canonical: string, isDirectory: boolean): Verdict {
  const relative = relativeWithin(declaration.root, canonical)
  if (relative === undefined) return NOT_EXCLUDED
  return evaluate(declaration.matcher, relative, isDirectory)
}

/**
 * Drop the excluded entries from an enumeration.
 *
 * `glob` and `grep` never name the files they hand back, so `LocationMutation.resolve` — which sees
 * only their search ROOT — cannot speak for them. This is the second seam, and the only one.
 * `toCanonical` maps a row to its absolute path.
 */
export function screenAll<A>(
  declaration: Declaration | undefined,
  rows: readonly A[],
  toCanonical: (row: A) => string,
): { readonly kept: readonly A[]; readonly withheld: number } {
  if (declaration === undefined) return { kept: rows, withheld: 0 }
  const kept = rows.filter((row) => !screen(declaration, toCanonical(row), false).excluded)
  return { kept, withheld: rows.length - kept.length }
}

/**
 * The refusal.
 *
 * 🔴 It is an ERROR, never an empty result. AGENTS.md: the UI never dead-ends and we teach rather
 * than gatekeep — and for the model specifically, a silent "no such file" is the shape that makes an
 * agent retry the same path five different ways and then conclude the repository is broken. So the
 * message says three things: that it was a PROJECT EXCLUSION, WHICH pattern matched, and WHICH file
 * declared it. The user can then act on it, and the agent can stop.
 */
export class ExcludedError extends Schema.TaggedErrorClass<ExcludedError>()("ProjectExclusion.ExcludedError", {
  /** The path as the caller named it, so the model recognises its own request. */
  resource: Schema.String,
  /** The pattern that matched, verbatim. */
  pattern: Schema.String,
  /** Absolute path of the `novaclaw.json` that declared it. */
  file: Schema.String,
}) {
  override get message() {
    return refusal(this.resource, this.pattern, this.file)
  }
}

/**
 * ⚠️ Names the declaring FILE as the authority and does not say the reader owns it. Until 2026-09-03 it
 * said "the person who owns this folder", which for a clone attributes the repository author's
 * list to the user — `permission.ts`'s sibling wording for `project-denied` ("it belongs to whoever
 * set the folder up") had this right, and ruling 2 applies in both directions.
 */
/**
 * What the model is told when a project exclusion shortened the result.
 *
 * ⚠️ **It names the COUNT and the declaring file, never the paths.** Naming them would hand back
 * exactly what the list exists to hide — and a directory listing is the cheapest way to learn what
 * someone was trying to keep out, which is why the exclusion covers enumerations at all.
 *
 * The wording tracks `ProjectExclusion.refusal`, which the model may also meet: same authority
 * (the declaring file), same attribution (whoever set the folder up, not necessarily the user), and
 * the same closing instruction, so the two seams do not read as two different mechanisms.
 */
export const withheldNotice = (withheld: number, file: string | undefined): string | undefined => {
  if (withheld <= 0) return undefined
  const one = withheld === 1
  return (
    `(${withheld} match${one ? " is" : "es are"} on this project's Excluded paths list and ${one ? "is" : "are"} not shown, so this result is PARTIAL. ` +
    `The rule is the \`exclude\` section of ${file ? `\`${file}\`` : "this project's `novaclaw.json`"} — a deliberate privacy choice declared by whoever set the folder up, ` +
    `for a cloned repository its author rather than the user. Re-running the search will not return them; if you genuinely need one, say so in your reply.)`
  )
}

export function refusal(resource: string, pattern: string, file: string) {
  return (
    `Refused by a project exclusion: \`${resource}\` is on this project's Excluded paths list, so this operation did not read it. ` +
    `The rule is the pattern \`${pattern}\` in the \`exclude\` section of \`${toPosix(file)}\`. ` +
    `This is a deliberate privacy choice declared in that file by whoever set the folder up — for a cloned ` +
    `repository that is its author, not necessarily the user — not a missing file and not a fault — ` +
    `dedicated file and search tools enforce the same path list. ` +
    `Work with what you can see, and if this file is genuinely needed say so in your reply: the user can remove the ` +
    `pattern in Settings → Project → Excluded paths, or edit that \`exclude\` list directly.`
  )
}

/**
 * The model-facing sentence for an exclusion refusal, or `undefined` for anything else.
 *
 * Shaped exactly like `PermissionV2.denialMessage`, and consumed from the same place: `denialMessage`
 * delegates here, so every tool that already maps a refusal to a legible `ToolFailure` — all of them
 * — reports an exclusion legibly without a line of its own. `test/project-exclusion.test.ts` holds
 * the ledger that keeps it that way.
 */
export function refusalMessage(error: unknown): string | undefined {
  return error instanceof ExcludedError ? error.message : undefined
}

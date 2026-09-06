export * as KbClaim from "./claim"

import { createHash } from "node:crypto"

/**
 * THE CLAIM VOCABULARY — the closed shape a correction is allowed to key on.
 *
 * A memory used to be a sentence with a scope and a timestamp, and the only thing the system could do
 * when the user changed their mind was accumulate the second sentence beside the first. Retrieval then
 * had two answers to one question and no way to tell which was current, so the model picked by
 * embedding rank — i.e. by wording. A CLAIM is that sentence with the three things needed to govern it:
 * WHO it belongs to (scope), WHAT it is about (subject), and WHICH question about that subject it
 * answers (predicate).
 *
 * 🔴 **The identity is validated, never inferred from prose.** The rejected design — and the one this
 * file exists to keep out — matches a new memory against old ones by title/subset similarity and
 * retires whatever looks close enough. That silently destroys a fact whenever two unrelated statements
 * share words, and it fails to fire whenever one restatement is phrased differently, so it is wrong in
 * both directions at once and neither is visible from the outside. Here the harness decides: an
 * identity is a `{scope, subject, predicate}` triple whose predicate is a member of the closed table
 * below, and anything else produces NO conflict key, which means the two claims coexist and a person
 * reconciles them.
 *
 * ⚠️ **Cardinality is the whole reason automatic supersession is safe.** A person has ONE current
 * employer and MANY skills, so "works at Acme" replaces "works at Initech" while "knows Rust" must
 * never replace "knows TypeScript". A single closed table carrying that distinction is what lets a
 * correction be deterministic instead of a guess: `single` predicates supersede, `multi` predicates
 * accumulate, and a predicate nobody declared does neither.
 *
 * Pure by construction — no engine, no clock, no id that is not derived from its inputs — so every
 * rule here is testable without opening a graph.
 */

/** Where a claim is in its life. `active` is the current answer; the rest are history or a flag. */
export type ClaimStatus = "active" | "superseded" | "archived" | "needs_review"

export const CLAIM_STATUSES = ["active", "superseded", "archived", "needs_review"] as const

/**
 * Which statuses RECALL may return — the "current truth vs history" separation, as one constant.
 *
 * `superseded` and `archived` are excluded: they are what the correction replaced and what the user
 * retired, and letting either compete by embedding rank against the current answer is precisely the
 * defect the lifecycle exists to end. They stay fully readable through `claimHistory`, which is how a
 * timeline and an explanation are served without a second store.
 *
 * ⚠️ `needs_review` IS included, deliberately. It marks a claim whose EVIDENCE moved — a cited file
 * renamed, a commit rewritten — not a claim that was contradicted. Dropping it from recall would turn
 * a file rename into silent amnesia about a fact nobody disputed, which is a worse failure than
 * answering with a flagged fact; the ranker discounts it instead (`ranking.ts`), and the tool renders
 * the flag so the model can say the citation needs checking.
 */
export const RECALL_STATUSES: readonly ClaimStatus[] = ["active", "needs_review"]

/** Statuses that no longer answer anything — history, kept and explainable, never retrieved. */
export const isRetired = (status: ClaimStatus): boolean => status === "superseded" || status === "archived"

export type Cardinality = "single" | "multi"

/**
 * The closed predicate table. `single` = one current answer per subject, so a new claim SUPERSEDES the
 * old one; `multi` = facts that accumulate, where a second claim is additional knowledge and replacing
 * it would be data loss.
 *
 * ⚠️ Small on purpose (`notes/reports/knowl-assessment-2026-08-25.md`: do not copy a foreign tool's
 * seven project categories into every colleague's memory). These are the questions NovaClaw's own
 * personal/user/document memories actually answer. Adding one is a deliberate act with a cardinality
 * decision attached; a predicate that is not here simply does not auto-correct, which is the safe
 * direction to be wrong in.
 */
export const CLAIM_PREDICATES = {
  /** What the subject is called right now. */
  name: "single",
  /** The subject's current job title or function. */
  role: "single",
  /** Who the subject currently works for. */
  employer: "single",
  /** Where the subject currently is, or lives. */
  location: "single",
  email: "single",
  phone: "single",
  timezone: "single",
  /** The language the subject wants to be spoken to in. */
  language: "single",
  birthday: "single",
  /** How the user wants THIS subject handled — the canonical "actually, I changed my mind" case. */
  preference: "single",
  /** The subject's current state (a project is shipped, a task is blocked). */
  status: "single",
  /** The version currently in use. */
  version: "single",
  /** Where the subject lives on disk. */
  path: "single",
  /** Who owns or is responsible for the subject. */
  owner: "single",
  /** A durable fact about the subject that does not replace any other. The default. */
  about: "multi",
  likes: "multi",
  dislikes: "multi",
  /** A skill, technology or person the subject knows. */
  knows: "multi",
  uses: "multi",
  works_on: "multi",
} as const satisfies Record<string, Cardinality>

export type ClaimPredicate = keyof typeof CLAIM_PREDICATES

/** Every predicate, for a closed-vocabulary pick in the tool schema (guided decoding can then only
 *  ever produce a valid one — the measured rule from `notes/spec/rag.md`: pick from a list, never
 *  generate). Sorted so the tool surface is stable across builds. */
export const CLAIM_PREDICATE_NAMES: readonly ClaimPredicate[] = (
  Object.keys(CLAIM_PREDICATES) as ClaimPredicate[]
).sort()

/**
 * The relationship vocabulary exposed by the kb tool. The graph engine accepts arbitrary edge types
 * for internal ingestion and extraction, but a model-authored join must be a deliberate, reviewable
 * choice. Keep this list small and stable; adding a relation is an engine/API decision, not a prompt
 * convention.
 */
export const RELATION_TYPES = [
  "about",
  "depends_on",
  "dislikes",
  "knows",
  "likes",
  "located_in",
  "part_of",
  "related_to",
  "uses",
  "works_at",
  "works_on",
  "wrote",
  "wrote_about",
] as const

export type RelationType = (typeof RELATION_TYPES)[number]
export const RELATION_TYPE_NAMES: readonly RelationType[] = RELATION_TYPES
export const isRelationType = (value: unknown): value is RelationType =>
  typeof value === "string" && (RELATION_TYPES as readonly string[]).includes(value)

/** The predicate a named `remember` gets when nobody chose one. `multi`, so a default never corrects. */
export const DEFAULT_PREDICATE: ClaimPredicate = "about"

export const isPredicate = (value: unknown): value is ClaimPredicate =>
  typeof value === "string" && Object.hasOwn(CLAIM_PREDICATES, value)

export const cardinality = (predicate: ClaimPredicate): Cardinality => CLAIM_PREDICATES[predicate]

/** What a claim is ABOUT and WHICH question it answers, once the harness has accepted the proposal. */
export interface ClaimIdentity {
  /** Owner scope — `global`, `agent:<id>` or `session:<id>`. Part of the key, so a correction can
   *  never reach across the cabinet boundary even when subject and predicate match exactly. */
  readonly scope: string
  /** The subject's NAME as written. The graph node it resolves to is `KbChunk.entityID(scope, name)`. */
  readonly subject: string
  readonly predicate: ClaimPredicate
}

/** What a caller (or a model) PROPOSES. Every field is untrusted until `proposeIdentity` accepts it. */
export interface IdentityProposal {
  readonly scope: string
  readonly subject?: string | undefined
  readonly predicate?: string | undefined
}

/**
 * Validate a proposed identity into the closed shape, or refuse it.
 *
 * ⚠️ Refusal is not an error — it is the CONFLICT branch. A claim with no accepted identity is stored
 * exactly like one with an identity, minus the conflict key, so it supersedes nothing and nothing
 * supersedes it. That is what "otherwise both claims stay visible as a conflict to reconcile" means:
 * the system declines to guess and leaves the two statements standing where a person can see them.
 */
export const proposeIdentity = (proposal: IdentityProposal): ClaimIdentity | undefined => {
  const scope = proposal.scope.trim()
  const subject = proposal.subject?.trim() ?? ""
  if (scope === "" || subject === "") return undefined
  if (!isPredicate(proposal.predicate)) return undefined
  return { scope, subject, predicate: proposal.predicate }
}

/** Case- and whitespace-insensitive statement text, for id derivation and duplicate detection. Never
 *  used for MATCHING two different statements — only for recognising the identical one again. */
export const normalizeStatement = (text: string): string => text.replaceAll(/\s+/g, " ").trim().toLowerCase()

const digest = (parts: readonly string[]): string =>
  createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 24)

/**
 * The CONFLICT KEY — the one thing automatic supersession is allowed to key on.
 *
 * `undefined` for a `multi` predicate, which is the mechanical reason "knows Rust" can never retire
 * "knows TypeScript": there is no key for them to collide on. Defined only for the `single` predicates
 * the table above declares to have exactly one current answer.
 *
 * The scope is IN the key. Two colleagues can each hold a current `employer` claim about the same
 * person and neither touches the other's, because their keys differ in the first field — the filing
 * cabinet rule enforced by arithmetic rather than by a check somebody has to remember to write.
 */
export const conflictKey = (identity: ClaimIdentity): string | undefined => {
  if (cardinality(identity.predicate) !== "single") return undefined
  return "ck_" + digest([identity.scope, identity.subject.trim().toLowerCase(), identity.predicate])
}

/**
 * A claim's id: content-addressed over identity AND statement.
 *
 * Including the STATEMENT is what makes history possible. Keying on the identity alone would mean the
 * corrected claim and its correction share an id, so writing the new one would either overwrite the
 * old (history destroyed) or collide and be dropped (the correction lost) — and on this engine a
 * duplicate `CREATE` is a silent no-op, so it would have been the second one.
 *
 * Idempotent for a genuine restatement: saying the same thing about the same subject twice lands on
 * the same id and dedupes, exactly like `SessionExtract.memoryID` does for episodes.
 */
export const claimID = (identity: ClaimIdentity | undefined, scope: string, statement: string): string =>
  "clm_" +
  digest(
    identity === undefined
      ? [scope, "", "", normalizeStatement(statement)]
      : [identity.scope, identity.subject.trim().toLowerCase(), identity.predicate, normalizeStatement(statement)],
  )

/**
 * Where a claim's evidence lives. Deliberately WIDER than "a chat message": the roadmap's requirement
 * is that a project memory cites the file/symbol/commit it came from, so the same lifecycle serves
 * "you told Nova on Tuesday" and "this is what `auth.ts:42` said at commit abc123".
 */
export type EvidenceKind = "chat" | "message" | "passage" | "file" | "url" | "test" | "command" | "commit"

export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "chat",
  "message",
  "passage",
  "file",
  "url",
  "test",
  "command",
  "commit",
]

export const isEvidenceKind = (value: unknown): value is EvidenceKind =>
  typeof value === "string" && (EVIDENCE_KINDS as readonly string[]).includes(value)

/** One piece of evidence. `locator` is the thing that can MOVE — a path, a URL, a commit sha, a
 *  message id — and is what `reviewEvidence` matches on when it does. */
export interface Evidence {
  readonly kind: EvidenceKind
  readonly locator: string
  /** How a person should read this citation. Falls back to a generated line when omitted. */
  readonly label?: string
}

/**
 * A source node's id: content-addressed over scope + kind + locator, so one file cited by forty claims
 * in the same cabinet is ONE source node with forty edges rather than forty copies of the citation.
 *
 * 🔴 **The SCOPE is in it, and leaving it out was a real defect in the first cut of this.** A source
 * node is written with the citing claim's scope, and on this engine a duplicate id is a silent no-op
 * that keeps the FIRST row — so the same file cited first from one chat and later from another left
 * the second claim pointing at a node in a scope it does not share. Two different private scopes are
 * refused by `addEdge`, so the second claim was stored with its evidence edge quietly missing: a claim
 * that looked cited and was not. Keying on the scope makes each cabinet's citation its own node, which
 * is also the honest boundary — a citation is exactly as private as the claim that makes it.
 *
 * ⚠️ Not hashed over the LABEL. Two claims describing the same file differently ("the auth module",
 * "auth.ts") must still converge, or `reviewEvidence` would have to flag several nodes for one moved
 * file and would miss whichever spelling it did not see.
 */
export const sourceID = (scope: string, kind: EvidenceKind, locator: string): string =>
  "src_" + digest([scope, kind, locator.trim().toLowerCase()])

/**
 * The human sentence a personal memory shows instead of an id — "you told Nova on 3 March 2026".
 *
 * Formatted here rather than at the call site because the roadmap makes it a product promise ("Personal
 * memory says 'you told Nova on …'"), and a promise implemented separately in each surface is one that
 * drifts. `at` is injected; nothing in this module reads a clock.
 */
export const describeEvidence = (evidence: Evidence, at?: Date): string => {
  if (evidence.label !== undefined && evidence.label.trim() !== "") return evidence.label.trim()
  const when = at === undefined || Number.isNaN(at.getTime()) ? undefined : at.toISOString().slice(0, 10)
  switch (evidence.kind) {
    case "chat":
    case "message":
      return when === undefined ? "you told Nova" : `you told Nova on ${when}`
    case "file":
      return `from the file ${evidence.locator}`
    case "url":
      return `from ${evidence.locator}`
    case "commit":
      return `from commit ${evidence.locator}`
    case "test":
      return `from the test ${evidence.locator}`
    case "command":
      return `from running ${evidence.locator}`
    case "passage":
      return `from a passage of ${evidence.locator}`
  }
}

/** Edge types the lifecycle owns. Named constants because three modules write them and one traverses
 *  them, and a typo in any of those is an edge that exists but joins nothing anybody looks for. */
export const SUBJECT_EDGE = "subject"
export const SUPPORTED_BY_EDGE = "supported_by"
export const SUPERSEDES_EDGE = "supersedes"

/**
 * Does this query text carry an EXACT identifier worth looking up directly?
 *
 * 🔴 The requirement is "exact identifiers stay reachable when semantic similarity is weak", and it
 * exists because both retrieval legs are bad at exactly this. A vector index places `mem_x9f2…` and
 * `src_44ab…` in roughly the same nowhere, and full-text tokenization splits `packages/core/auth.ts`
 * into common words that match half the store. So an id, a path, a symbol or a sha is pulled out and
 * looked up by EQUALITY, and fused ahead of the fuzzy legs.
 *
 * Deliberately conservative: an ordinary English word must not be treated as an identifier or every
 * query would run an extra equality scan for nothing. A token qualifies when it looks like a stored
 * id, a path, a dotted/underscored/camel symbol, or a long hex sha.
 */
export const identifierTokens = (query: string): string[] => {
  const out: string[] = []
  for (const raw of query.split(/[\s,;"'`()\[\]{}<>]+/)) {
    const token = raw.replace(/[.,;:!?]+$/, "").trim()
    if (token.length < 3 || token.length > 200) continue
    const isStoredID = /^(mem_|clm_|src_)[A-Za-z0-9_]+$/.test(token)
    const isPath = /[/\\]/.test(token) && /[A-Za-z0-9]/.test(token)
    // ⚠️ The first segment must be at least two characters and the whole token at least five, or
    // "e.g", "i.e" and "U.S.A" all read as dotted symbols and every other English sentence buys an
    // equality scan it can never satisfy. `os.EOL` and `Session.resolveConfig` still qualify.
    const isSymbol = token.length >= 5 && /^[A-Za-z_$][A-Za-z0-9_$]+(?:[._$][A-Za-z0-9_$]+)+$/.test(token)
    const isSha = /^[0-9a-f]{7,40}$/.test(token) && /[0-9]/.test(token) && /[a-f]/.test(token)
    if (isStoredID || isPath || isSymbol || isSha) out.push(token)
    if (out.length >= 8) break
  }
  return [...new Set(out)]
}

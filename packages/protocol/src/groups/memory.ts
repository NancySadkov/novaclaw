import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

/**
 * Memory operations on the ONE contract.
 *
 * 🔴 The rest of `/memory/*` is legacy (`novaclaw/src/server/routes/instance/httpapi/groups/memory.ts`)
 * and may only SHRINK — ruling 11, enforced by `sdk/js/test/legacy-path-ledger.test.ts`, which turned
 * red when `erase` was first added there beside its neighbours. It typechecked, it worked, and it
 * would have reviewed as consistent; the ledger is what made the line honest. New memory endpoints
 * belong here.
 */
/**
 * ⚠️ **A HAND-KEPT COPY of `KbClaim.EVIDENCE_KINDS`**, because `@novaclaw/protocol` depends on
 * `@novaclaw/schema` and nothing else while `claim.ts` lives in core. It is EXPORTED rather than
 * inlined so the copy has a name a guard can hold: `server/src/handlers/memory-claim.test.ts`
 * compares it against core's own list. A vocabulary copy goes stale in the direction that looks
 * fine — a kind added upstream would come back as a 400 that reads like a caller mistake.
 */
/**
 * ─── THE NOISE VIEWS' WIRE SHAPES (P3) ───────────────────────────────────────────────────────────
 *
 * ⚠️ **Every field a handler intends to return is declared here.** An undeclared field is silently
 * stripped on the way out and the route still answers 200 — which is how the whole claim lifecycle
 * stayed invisible to the Memory app after P1 shipped it.
 */
const MemoryRow = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  text: Schema.String,
  name: Schema.NullOr(Schema.String),
  scope: Schema.String,
  source: Schema.NullOr(Schema.String),
  confidence: Schema.NullOr(Schema.Finite),
  relation: Schema.String,
  status: Schema.String,
  subject: Schema.NullOr(Schema.String),
  predicate: Schema.NullOr(Schema.String),
  conflictKey: Schema.NullOr(Schema.String),
  supersededBy: Schema.NullOr(Schema.String),
  evidence: Schema.NullOr(Schema.String),
  evidenceKind: Schema.NullOr(Schema.String),
})

const UsageCounts = Schema.Struct({
  accesses: Schema.Finite,
  uses: Schema.Finite,
  useful: Schema.Finite,
  corrections: Schema.Finite,
  firstAccessedAt: Schema.Finite,
  lastAccessedAt: Schema.Finite,
})

/** A memory in a noise view: the row, plus the ledger's verdict on it. */
const UsageItem = Schema.Struct({ ...MemoryRow.fields, usage: Schema.optional(UsageCounts) })

const NeverUsedResult = Schema.Struct({
  items: Schema.Array(UsageItem),
  scanned: Schema.Finite,
  partial: Schema.Boolean,
})
const UsefulResult = Schema.Struct({ items: Schema.Array(UsageItem) })
const CorrectionGroup = Schema.Struct({
  conflictKey: Schema.String,
  scope: Schema.String,
  corrected: Schema.Finite,
  corrections: Schema.Finite,
  lastAccessedAt: Schema.Finite,
  items: Schema.Array(UsageItem),
})
const CorrectionsResult = Schema.Struct({ groups: Schema.Array(CorrectionGroup) })
const AccessRow = Schema.Struct({
  fingerprint: Schema.String,
  surface: Schema.String,
  rank: Schema.Finite,
  score: Schema.Finite,
  accessedAt: Schema.Finite,
  usedAt: Schema.NullOr(Schema.Finite),
  usefulAt: Schema.NullOr(Schema.Finite),
  correctedAt: Schema.NullOr(Schema.Finite),
})
const UsageDetail = Schema.Struct({ usage: Schema.NullOr(UsageCounts), accesses: Schema.Array(AccessRow) })

/**
 * ⚠️ **POST for a read, and no `urlParams`** — the house rule `groups/log.ts` records. `scopes` is a
 * list of store keys, one of which is `session:<id>`; a query string lands in access logs, proxy logs
 * and referrers, and a session id is `correlate`-class data that may not egress. The filters ride the
 * body for the same reason `log.read`'s do.
 */
const UsageFilter = Schema.Struct({
  scopes: Schema.optional(Schema.Array(Schema.String)),
  limit: Schema.optional(Schema.Finite),
})

/**
 * 🔴 **THE CLOSED PREDICATE VOCABULARY — offered, not guessed.**
 *
 * `predicate` was declared as free `Schema.String`, and a value outside `KbClaim.CLAIM_PREDICATES` is
 * not an error: `conflictKey` returns `undefined`, so the claim is written with NO identity, nothing
 * it can ever correct, and a `200` that says `identified: false`. Measured 2026-08-26 against this
 * endpoint — three claims sent with `predicate: "opening hours"` about one subject produced three
 * simultaneously-current answers and no supersession, silently.
 *
 * That is principle 12 exactly: *a setting may never require a value the user has no way to know*,
 * and 12(b) — offer what exists. A literal union puts the vocabulary in the OpenAPI document and the
 * generated SDK, so a wrong predicate is a 400 that names the options instead of a success that
 * quietly did something else.
 *
 * ⚠️ A HAND-KEPT COPY, like `EVIDENCE_KINDS` above and for the same reason — `@novaclaw/protocol`
 * depends on `@novaclaw/schema` and nothing else, while `claim.ts` lives in core. Exported so
 * `server/src/handlers/memory-claim.test.ts` can compare it against core's own table.
 */
export const CLAIM_PREDICATES = [
  "about",
  "birthday",
  "dislikes",
  "email",
  "employer",
  "knows",
  "language",
  "likes",
  "location",
  "name",
  "owner",
  "path",
  "phone",
  "preference",
  "role",
  "status",
  "timezone",
  "uses",
  "version",
  "works_on",
] as const

export const EVIDENCE_KINDS = ["chat", "message", "passage", "file", "url", "test", "command", "commit"] as const

/**
 * The statuses a PERSON controls, mirroring `MemoryClient.setClaimStatus`.
 *
 * ⚠️ `superseded` is deliberately absent. A claim is retired by the LIFECYCLE, under the lock that
 * wrote the claim replacing it; a person stamping it by hand would assert a correction with no
 * corrector — a retired answer with nothing standing in its place.
 */
export const PERSON_CLAIM_STATUSES = ["active", "archived", "needs_review"] as const

export const MemoryGroup = HttpApiGroup.make("server.memory")
  .add(
    HttpApiEndpoint.post("memory.erase", "/api/memory/erase", {
      // A COUNT, not a boolean. "It worked" is not auditable, and a store that was already empty must
      // answer 0 rather than imply something happened.
      success: Schema.Finite,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.erase",
        summary: "Erase all memory",
        description:
          "Delete every memory in every scope, for every agent including Nova. Used to run from a clean slate without resetting the install. The confirmation is the caller's responsibility.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("memory.export", "/api/memory/export", {
      payload: Schema.Struct({ includeInvalid: Schema.optional(Schema.Boolean) }),
      // The server exhausts the store's bounded pages before answering. An empty array therefore
      // means the store is authoritatively empty; an unavailable store travels through the error
      // arm instead of becoming an indistinguishable empty backup.
      success: Schema.Array(MemoryRow),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.export",
        summary: "Export every memory",
        description:
          "Return a complete backup view of current memory, optionally including invalidated history. The server exhausts its bounded store pages and fails the request if any page cannot be read.",
      }),
    ),
  )
  .add(
    /**
     * 🔴 **ARCHIVE / RESTORE — the half of the claim lifecycle a PERSON controls, and until now the
     * only one with no door.**
     *
     * `WasmMemory.setClaimStatus`, `MemoryClient.setClaimStatus` and the `memory.claim.status` event
     * the store publishes when a claim moves all shipped together; what never existed was an HTTP
     * endpoint, so the Memory app rendered its Archive button DISABLED with a sentence explaining
     * that this instance could not reach the operation. Everything behind the control worked. This
     * is the control's other end.
     *
     * ⚠️ **`superseded` is deliberately NOT settable here**, mirroring `MemoryClient.setClaimStatus`.
     * A claim is retired by the LIFECYCLE, under the lock that wrote the claim replacing it, and a
     * person who could stamp `superseded` by hand would be asserting a correction that has no
     * corrector — a retired answer with nothing standing in its place.
     *
     * ⚠️ It answers a BOOLEAN — whether the status actually moved. `false` is a real answer: the
     * claim does not exist, or it is already in that state. A 200 that meant "the request was
     * well-formed" would let a viewer draw a lifecycle change that never happened.
     */
    HttpApiEndpoint.post("memory.claim.status", "/api/memory/claim/status", {
      payload: Schema.Struct({
        id: Schema.String,
        status: Schema.Literals(PERSON_CLAIM_STATUSES),
      }),
      success: Schema.Boolean,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.claim.status",
        summary: "Archive, restore or flag a claim",
        description:
          "Move one claim between the statuses a person controls: `archived` (kept, never recalled), " +
          "`active` (restored), `needs_review` (flagged). `superseded` is the lifecycle's own and " +
          "cannot be set here. Answers whether the status actually changed.",
      }),
    ),
  )
  .add(
    /**
     * 🔴 **RECORD A GOVERNED CLAIM — the write that carries an IDENTITY, and therefore the only write
     * that can correct anything.**
     *
     * Before this, every HTTP path into the store was `POST /memory/remember`, which calls
     * `addMemory` — a plain node with no subject, no predicate and no conflict key. So a claim with
     * an identity could be created by exactly one thing in the whole instance, the model's `kb` tool
     * inside a turn, and a supersession could not be caused from outside one at all. That made the
     * P2 gate — *one real recall, one write and one correction each visible in an open Memory app,
     * whatever agent or transport caused them* — unmeetable by construction rather than unmet by
     * accident.
     *
     * ⚠️ **`scope` defaults to `global`, and the ACCESS is the owner's** — the same stance every
     * other endpoint in the Memory app's surface takes. This is the human at their own instance; a
     * model reaches `addClaim` through the `kb` tool, which builds its access from the session it is
     * running in and can never construct this one.
     *
     * ⚠️ The result is the lifecycle's OWN `ClaimResult`, unflattened. `identified: false` means the
     * harness refused the conflict identity, so this claim corrects nothing by design; `deduped`
     * means the store already knew it; `superseded` names what this retired. A boolean here would
     * make "Nova already knew that" and "this replaced yesterday's answer" the same event.
     */
    HttpApiEndpoint.post("memory.claim.add", "/api/memory/claim", {
      payload: Schema.Struct({
        statement: Schema.String,
        scope: Schema.optional(Schema.String),
        subject: Schema.optional(Schema.String),
        predicate: Schema.optional(Schema.Literals(CLAIM_PREDICATES)),
        confidence: Schema.optional(Schema.Finite),
        source: Schema.optional(Schema.String),
        agent: Schema.optional(Schema.String),
        validFrom: Schema.optional(Schema.String),
        evidence: Schema.optional(
          Schema.Array(
            Schema.Struct({
              kind: Schema.Literals(EVIDENCE_KINDS),
              locator: Schema.String,
              label: Schema.optional(Schema.String),
            }),
          ),
        ),
      }),
      success: Schema.Struct({
        ok: Schema.Boolean,
        id: Schema.optional(Schema.String),
        status: Schema.optional(Schema.String),
        identified: Schema.optional(Schema.Boolean),
        deduped: Schema.optional(Schema.Boolean),
        superseded: Schema.Array(Schema.String),
        reason: Schema.optional(Schema.String),
      }),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.claim.add",
        summary: "Record a claim",
        description:
          "Write a governed claim: file it against its subject and its evidence, and retire the claim " +
          "it corrects. Supersession is keyed on scope + subject + predicate, so a claim that names " +
          "both replaces the current answer to that question and the reply lists what it retired.",
      }),
    ),
  )
  .add(
    /**
     * 🔴 **THE FOUR NOISE VIEWS AND THE VOUCH — MOVED HERE FROM `/memory/*`, not newly added.**
     *
     * They landed on the LEGACY surface, which ruling 11 freezes to shrink-only, and the ledger that
     * enforces it (`sdk/js/test/legacy-path-ledger.test.ts`) went red the moment they did: it pins 82
     * legacy paths and the spec had 87. Moving them is what makes the ledger honest again, and it
     * needs no ledger edit at all — the pin was already correct and the surface had grown past it.
     *
     * ⚠️ The pruning protection depends on these being REACHABLE. `usage/useful` is the list of
     * memories a person vouched for, and `POST /memory/feedback` is the only way to become one; a
     * vouched memory is excluded from the forgetting pass outright rather than merely weighted. A
     * protection whose only door has no caller is a protection nobody has.
     */
    HttpApiEndpoint.post("memory.usage.neverUsed", "/api/memory/usage/never-used", {
      payload: Schema.Struct({
        ...UsageFilter.fields,
        /** How deep the never-used scan may go before it answers `partial`. */
        scan: Schema.optional(Schema.Finite),
      }),
      success: NeverUsedResult,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.usage.neverUsed",
        summary: "Never recalled",
        description:
          "Memories no recall has ever returned, oldest first. `scanned`/`partial` say how far the " +
          "scan reached — a short answer is not proof there are no more.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("memory.usage.useful", "/api/memory/usage/useful", {
      payload: UsageFilter,
      success: UsefulResult,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.usage.useful",
        summary: "Vouched for",
        description:
          "Memories a person marked useful. These are protected from the forgetting pass outright, " +
          "not merely weighted.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("memory.usage.corrections", "/api/memory/usage/corrections", {
      payload: Schema.Struct({
        ...UsageFilter.fields,
        /** How many corrected claims an identity needs before it counts as "repeatedly". Default 2. */
        minCorrected: Schema.optional(Schema.Finite),
      }),
      success: CorrectionsResult,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.usage.corrections",
        summary: "Keeps being corrected",
        description:
          "Grouped by claim IDENTITY, not by claim: a single claim is superseded at most once, so " +
          "'repeatedly' can only be a property of the question.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("memory.usage.detail", "/api/memory/usage/detail", {
      payload: Schema.Struct({ id: Schema.String }),
      success: UsageDetail,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.usage.detail",
        summary: "Why is this here",
        description:
          "Every recall that returned one memory: when, from which surface, at what rank, and " +
          "whether it was used, vouched for or later corrected. The query is a fingerprint and " +
          "never the words.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("memory.protection", "/api/memory/protection", {
      payload: Schema.Struct({ ids: Schema.Array(Schema.String).check(Schema.isMaxLength(500)) }),
      success: Schema.Array(Schema.Struct({ id: Schema.String, protected: Schema.Boolean })),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.protection",
        summary: "Read memory protection",
        description: "Complete protection state for up to 500 requested memories. A store failure is an error, never an unprotected result.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("memory.feedback", "/api/memory/feedback", {
      payload: Schema.Struct({
        id: Schema.String,
        /** `false` RETRACTS a vouch rather than counting a negative — the flag exists to protect,
         *  and the only two states that matter are "somebody vouched" and "nobody did". */
        useful: Schema.Boolean,
      }),
      success: Schema.Boolean,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.feedback",
        summary: "Mark useful",
        description: "Vouch for a memory recall handed you, or retract the vouch. A vouched memory is never pruned.",
      }),
    ),
  )
  // ⚠️ Not the bare name `memory`: the legacy `/memory/*` group already answers to it, and two tag
  // entries with one name is an invalid `tags` array, not a merged section. This half is the claim
  // LIFECYCLE and the ledger over it; that half is the graph viewer/editor. Ruling 11 retires the
  // legacy surface, and the plain name is what it should leave behind.
  .annotateMerge(
    OpenApi.annotations({
      title: "memory lifecycle",
      description:
        "Governed claims and what the graph does with them: file a claim and see what it retired, read the noise views over how memories are actually used, vouch for one, and export or erase.",
    }),
  )
  .add(
    HttpApiEndpoint.post("world-memory.erase", "/api/world-memory/erase", {
      success: Schema.Finite,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.world-memory.erase",
        summary: "Erase agent memory",
        description:
          "Delete the automatic session and agent world model. This does not erase the explicit/source KB.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("world-memory.export", "/api/world-memory/export", {
      payload: Schema.Struct({ includeInvalid: Schema.optional(Schema.Boolean) }),
      success: Schema.Array(MemoryRow),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.world-memory.export",
        summary: "Export agent memory",
        description:
          "Return a complete backup of the automatic session and agent world model, without explicit/source KB rows.",
      }),
    ),
  )

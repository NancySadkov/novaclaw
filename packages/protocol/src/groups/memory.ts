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
export const EVIDENCE_KINDS = ["chat", "message", "passage", "file", "url", "test", "command", "commit"] as const

/**
 * The statuses a PERSON controls, mirroring `MemoryClient.setClaimStatus`.
 *
 * ⚠️ `superseded` is deliberately absent. A claim is retired by the LIFECYCLE, under the lock that
 * wrote the claim replacing it; a person stamping it by hand would assert a correction with no
 * corrector — a retired answer with nothing standing in its place.
 */
export const PERSON_CLAIM_STATUSES = ["active", "archived", "needs_review"] as const

export const MemoryGroup = HttpApiGroup.make("server.memory").add(
  HttpApiEndpoint.post("memory.erase", "/api/memory/erase", {
    // A COUNT, not a boolean. "It worked" is not auditable, and a store that was already empty must
    // answer 0 rather than imply something happened.
    success: Schema.Number,
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
        predicate: Schema.optional(Schema.String),
        confidence: Schema.optional(Schema.Number),
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

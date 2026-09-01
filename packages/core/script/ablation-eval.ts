export * as KbAblationEval from "./ablation-eval"

import type { MemoryClient } from "../src/kb-graph/memory-client"

/**
 * THE ABLATION CORPUS AND ITS SCORING — an instrument, not product code.
 *
 * 🔴 **Why this exists at all.** Knowl's published result says lifecycle governance helped Knowl on
 * Knowl's corpus. It does not say supersession helps NovaClaw's retrieval, and the honest way to
 * find out is to hold the corpus and the retrieval path fixed and turn one thing off at a time
 * (`notes/reports/knowl-assessment-2026-08-25.md`). A graph store that is never measured against
 * itself-without-the-graph is a design nobody can defend.
 *
 * 🔴 **Retrieval and reader are scored SEPARATELY, and that separation is the point.** They fail for
 * different reasons and they are fixed in different places: retrieval that never returns the answer
 * cannot be repaired by a better model, and a model that ignores a correct context cannot be
 * repaired by better ranking. A single end-to-end number hides which of the two moved — and this
 * store already has a measurement saying answer-correctness tracked retrieval hit-rate exactly,
 * which is a claim that only means something because the two were counted apart.
 *
 * ⚠️ **The multi-hop edges are AUTHORED by this corpus, not derived by the absorb pass.** So the
 * edges-on/off arm measures what a one-hop traversal leg BUYS given good relations; it does not
 * measure whether extraction produces good relations. Those are two experiments and this is the
 * first one.
 *
 * ⚠️ **Every question's bridge term is absent from the question.** A "multi-hop" question that names
 * the intermediate entity is answerable by one lexical lookup, which is how a graph gets credit for
 * work FTS did.
 */

export type QuestionKind = "conflict" | "personalization" | "document" | "multi-hop"

export interface Question {
  readonly id: string
  readonly kind: QuestionKind
  readonly text: string
  /** Memory keys (see `CorpusItem.key`) that carry the answer. Any one of them counts as a hit. */
  readonly gold: ReadonlyArray<string>
  /**
   * Keys that must ALSO be present for the question to count as retrievable.
   *
   * 🔴 A multi-hop question is not answered by returning the far fact alone. If the pack holds
   * "Acme Robotics manufactures picking arms" but not "Ann Brenner works at Acme Robotics", a reader
   * has no way to know that sentence is the one about Ann's employer — and scoring the far fact as a
   * hit would credit retrieval for an answer nothing downstream could actually produce.
   */
  readonly bridge?: ReadonlyArray<string>
  /**
   * Keys whose text gives a WRONG answer — the superseded claim, mostly. Ranking one of these above
   * every gold is the failure supersession is supposed to prevent, and it is counted separately from
   * a plain miss because the two mean different things to a reader.
   */
  readonly stale: ReadonlyArray<string>
  /** A substring the reader's answer must contain, case-insensitively. */
  readonly answer: string
  /** A substring that must NOT appear. Absent when the question has no attractive wrong answer. */
  readonly wrong?: string
}

export interface CorpusItem {
  /** A stable handle for this file's own bookkeeping — the store assigns the real id. */
  readonly key: string
  readonly kind: "claim" | "passage" | "entity"
  readonly text: string
  readonly name?: string
  readonly subject?: string
  readonly predicate?: string
  /** Written in order, so a later claim with the same identity supersedes the earlier one. */
  readonly supersededByLater?: boolean
}

/** Explicit relations, by corpus key. The multi-hop arm traverses these and nothing else. */
export interface CorpusEdge {
  readonly from: string
  readonly to: string
  readonly type: string
}

/**
 * The corpus.
 *
 * Small on purpose: every item is either an answer, an attractive wrong answer, or a lexical
 * distractor that exists because ONE ingested document is hundreds of rows and that is the measured
 * way a claim gets crowded out of a `k = 10` recall.
 */
export const CORPUS: ReadonlyArray<CorpusItem> = [
  // ── current-fact conflict ───────────────────────────────────────────────────────────────────
  {
    key: "ann.employer.old",
    kind: "claim",
    text: "Ann Brenner works at Initech Labs.",
    name: "Ann Brenner",
    subject: "Ann Brenner",
    predicate: "employer",
    supersededByLater: true,
  },
  {
    key: "ann.employer.new",
    kind: "claim",
    text: "Ann Brenner works at Acme Robotics.",
    name: "Ann Brenner",
    subject: "Ann Brenner",
    predicate: "employer",
  },
  {
    key: "harbor.status.old",
    kind: "claim",
    text: "Project Harbor is blocked on a security review.",
    name: "Project Harbor",
    subject: "Project Harbor",
    predicate: "status",
    supersededByLater: true,
  },
  {
    key: "harbor.status.new",
    kind: "claim",
    text: "Project Harbor has shipped to every customer.",
    name: "Project Harbor",
    subject: "Project Harbor",
    predicate: "status",
  },

  // ── personalization ─────────────────────────────────────────────────────────────────────────
  {
    key: "nadia.language",
    kind: "claim",
    text: "Nadia Okonkwo wants every reply written in Dutch.",
    name: "Nadia Okonkwo",
    subject: "Nadia Okonkwo",
    predicate: "language",
  },
  {
    key: "nadia.units",
    kind: "claim",
    text: "Nadia Okonkwo wants measurements given in metric units.",
    name: "Nadia Okonkwo",
    subject: "Nadia Okonkwo",
    predicate: "preference",
  },

  // ── the document ────────────────────────────────────────────────────────────────────────────
  {
    key: "handbook.escalation",
    kind: "passage",
    text:
      "Operations handbook, section 4. An incident that has not been acknowledged is escalated to " +
      "the on-call lead after 25 minutes, and to the duty director after a further hour.",
    name: "Operations handbook",
  },
  {
    key: "handbook.review",
    kind: "passage",
    text:
      "Operations handbook, section 5. A post-incident review is due within three working days of " +
      "the incident being closed, and is written by the responder who closed it.",
    name: "Operations handbook",
  },

  // ── multi-hop ───────────────────────────────────────────────────────────────────────────────
  //
  // 🔴 **The five sibling companies are what make these questions actually multi-hop.** A first
  // draft had ONE company per fact, and both hybrid legs found the answer with edges off — not
  // because they hopped, but because "what does Ann's employer manufacture" is semantically almost
  // the sentence "Acme Robotics manufactures warehouse picking arms", and there was nothing else in
  // the store it could have been. Measured: hit@8 8/8 in every condition, gold at rank 4 and 2 with
  // and without traversal alike. A multi-hop question with one plausible target measures similarity,
  // not hops.
  //
  // Each sibling now answers the question's WORDS exactly as well as the true target does, so the
  // only thing that can separate them is the bridge — the company name, which no question contains.
  { key: "acme.entity", kind: "entity", text: "Acme Robotics", name: "Acme Robotics" },
  { key: "initech.entity", kind: "entity", text: "Initech Labs", name: "Initech Labs" },
  {
    key: "bo.employer",
    kind: "claim",
    text: "Bo Vance works at Initech Labs.",
    name: "Bo Vance",
    subject: "Bo Vance",
    predicate: "employer",
  },
  {
    key: "acme.product",
    kind: "claim",
    text: "Acme Robotics manufactures warehouse picking arms.",
    name: "Acme Robotics",
    subject: "Acme Robotics",
    predicate: "about",
  },
  {
    key: "initech.office",
    kind: "claim",
    text: "The Initech Labs office is in Rotterdam.",
    name: "Initech Labs",
    subject: "Initech Labs",
    predicate: "location",
  },
  ...["Corvid Systems", "Zenith Freight", "Halcyon Works", "Meridian Tooling", "Northgate Automation"].flatMap(
    (company, index) => [
      {
        key: `sibling.product.${index}`,
        kind: "claim" as const,
        text: `${company} manufactures warehouse ${["conveyor belts", "pallet shuttles", "sorting gantries", "packing cells", "picking cranes"][index]}.`,
        name: company,
        subject: company,
        predicate: "about",
      },
      {
        key: `sibling.office.${index}`,
        kind: "claim" as const,
        text: `The ${company} office is in ${["Utrecht", "Antwerp", "Ghent", "Eindhoven", "Leuven"][index]}.`,
        name: company,
        subject: company,
        predicate: "location",
      },
    ],
  ),

  // ── lexical distractors: the handbook, echoing the claims' own words ─────────────────────────
  ...[
    "Employees change employer from time to time; update the staff directory when somebody moves.",
    "Every project has a status, and a status that has not been reviewed this quarter is stale.",
    "Reply language preferences are recorded per person and are not inferred from the message.",
    "Units of measurement in customer-facing documents follow the customer's own convention.",
    "A robotics manufacturer is expected to publish an annual safety statement for each arm.",
    "Office locations are listed in the staff handbook appendix and change without notice.",
    "The on-call rota is published weekly and an unacknowledged page rolls over automatically.",
    "A review that is due and not written is itself an incident under section 9 of the handbook.",
    "Security reviews block a project until a reviewer signs the finding off in writing.",
    "Shipping to every customer requires a written go-ahead from the duty director.",
  ].map((text, index) => ({
    key: `filler.${index}`,
    kind: "passage" as const,
    text: `Operations handbook, appendix ${index + 1}. ${text}`,
    name: "Operations handbook",
  })),
]

/** The traversal leg's whole world: the bridge that no question names. */
export const EDGES: ReadonlyArray<CorpusEdge> = [
  { from: "ann.employer.new", to: "acme.entity", type: "mentions" },
  { from: "acme.product", to: "acme.entity", type: "mentions" },
  { from: "bo.employer", to: "initech.entity", type: "mentions" },
  { from: "initech.office", to: "initech.entity", type: "mentions" },
]

export const QUESTIONS: ReadonlyArray<Question> = [
  {
    id: "conflict.employer",
    kind: "conflict",
    text: "Where does Ann Brenner work?",
    gold: ["ann.employer.new"],
    stale: ["ann.employer.old"],
    answer: "acme",
    wrong: "initech",
  },
  {
    id: "conflict.status",
    kind: "conflict",
    text: "What is the current state of Project Harbor?",
    gold: ["harbor.status.new"],
    stale: ["harbor.status.old"],
    answer: "ship",
    wrong: "blocked",
  },
  {
    id: "personal.language",
    kind: "personalization",
    text: "Which language should replies to Nadia Okonkwo be written in?",
    gold: ["nadia.language"],
    stale: [],
    answer: "dutch",
  },
  {
    id: "personal.units",
    kind: "personalization",
    text: "How does Nadia Okonkwo want measurements expressed?",
    gold: ["nadia.units"],
    stale: [],
    answer: "metric",
  },
  {
    id: "document.escalation",
    kind: "document",
    text: "How long may an incident go unacknowledged before it is escalated to the on-call lead?",
    gold: ["handbook.escalation"],
    stale: [],
    answer: "25",
  },
  {
    id: "document.review",
    kind: "document",
    text: "When is a post-incident review due?",
    gold: ["handbook.review"],
    stale: [],
    answer: "three working days",
  },
  {
    // Two hops: Ann → (her employer, which the question does not name) → what that company makes.
    // Five sibling companies answer the question's words equally well, so only the bridge separates
    // them — and the BRIDGE claim has to be retrieved too, or a reader cannot make the hop either.
    id: "multihop.product",
    kind: "multi-hop",
    text: "What does the company Ann Brenner works for manufacture?",
    gold: ["acme.product"],
    bridge: ["ann.employer.new"],
    stale: [],
    answer: "picking arms",
  },
  {
    id: "multihop.office",
    kind: "multi-hop",
    text: "In which city is the office of the company Bo Vance works for?",
    gold: ["initech.office"],
    bridge: ["bo.employer"],
    stale: [],
    answer: "rotterdam",
  },
]

export interface Condition {
  readonly supersession: boolean
  readonly edges: boolean
}

export const CONDITIONS: ReadonlyArray<Condition> = [
  { supersession: true, edges: true },
  { supersession: true, edges: false },
  { supersession: false, edges: true },
  { supersession: false, edges: false },
]

export const conditionName = (condition: Condition): string =>
  `supersession=${condition.supersession ? "on" : "off"} edges=${condition.edges ? "on" : "off"}`

export interface RetrievalScore {
  readonly questionID: string
  readonly kind: QuestionKind
  /** Did a gold memory come back AND every bridge it needs? */
  readonly hit: boolean
  /** Whether the far fact came back, regardless of whether the bridge did. */
  readonly goldPresent: boolean
  /** Whether every bridge came back. `true` for questions that need none. */
  readonly bridgePresent: boolean
  /** 1-based rank of the best gold hit; `undefined` when none came back. */
  readonly goldRank?: number
  /**
   * Did a stale answer outrank every gold one?
   *
   * ⚠️ Counted apart from a plain miss. "The answer was not retrieved" leaves a reader with nothing;
   * "a retired answer was retrieved ABOVE the current one" hands it something confidently wrong,
   * which is the failure the lifecycle exists to prevent and the one an ablation must be able to see.
   */
  readonly staleAboveGold: boolean
}

export const scoreRetrieval = (
  question: Question,
  hits: ReadonlyArray<MemoryClient.SearchHit>,
  keyOf: ReadonlyMap<string, string>,
): RetrievalScore => {
  const keys = hits.map((hit) => keyOf.get(hit.id))
  const present = new Set(keys.filter((key): key is string => key !== undefined))
  const goldRank = keys.findIndex((key) => key !== undefined && question.gold.includes(key))
  const staleRank = keys.findIndex((key) => key !== undefined && question.stale.includes(key))
  const bridgePresent = (question.bridge ?? []).every((key) => present.has(key))
  return {
    questionID: question.id,
    kind: question.kind,
    hit: goldRank >= 0 && bridgePresent,
    goldPresent: goldRank >= 0,
    bridgePresent,
    ...(goldRank >= 0 ? { goldRank: goldRank + 1 } : {}),
    staleAboveGold: staleRank >= 0 && (goldRank < 0 || staleRank < goldRank),
  }
}

/**
 * Grade one reader answer — by SUBSTRING, deterministically.
 *
 * 🔴 **No model judges this.** A judge is a second stochastic system whose errors correlate with the
 * subject's, and grading eight fixed questions does not need one: each has a short answer whose
 * presence or absence in the reply is decidable. The wrong answers are equally decidable, which is
 * what makes "answered from the retired claim" a countable outcome rather than an impression.
 *
 * ⚠️ An EMPTY reply is a failure, not a neutral. A thinking model on too small a budget returns
 * nothing at all, and scoring that as "no wrong answer" would flatter a run that produced no answers.
 */
export const gradeAnswer = (question: Question, reply: string): { readonly ok: boolean; readonly wrong: boolean } => {
  const text = reply.toLowerCase()
  if (text.trim() === "") return { ok: false, wrong: false }
  const wrong = question.wrong !== undefined && text.includes(question.wrong.toLowerCase())
  return { ok: text.includes(question.answer.toLowerCase()) && !wrong, wrong }
}

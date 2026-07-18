export * as KbLinearize from "./linearize"

// KB-V — the triple→document linearizer (notes/kb-vector-plan.md P4): one document per
// SUBJECT, title = its `name` fact (fallback: the slug), body = one "predicate: object" line
// per fact. Shared by the P4 kb_fact migration and the P5 retrieval eval so the corpus the
// eval measures IS the corpus migration produces. Pure; input order is preserved within a
// subject (stable output for a stable input).

export interface Triple {
  readonly subject: string
  readonly predicate: string
  readonly object: string
}

export interface EntityDoc {
  readonly subject: string
  readonly title: string
  readonly text: string
}

export const entityDocs = (triples: ReadonlyArray<Triple>): EntityDoc[] => {
  const bySubject = new Map<string, Triple[]>()
  for (const triple of triples) {
    const list = bySubject.get(triple.subject)
    if (list === undefined) bySubject.set(triple.subject, [triple])
    else list.push(triple)
  }
  return [...bySubject.entries()].map(([subject, facts]) => {
    const title = facts.find((fact) => fact.predicate === "name")?.object ?? subject
    return {
      subject,
      title,
      text: facts.map((fact) => `${fact.predicate}: ${fact.object}`).join("\n"),
    }
  })
}

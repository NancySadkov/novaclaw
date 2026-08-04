export type ChangeMode = "git" | "branch" | "turn"
export type ReviewSource = {
  mode: ChangeMode
  kind: "workspace" | "branch" | "recorded" | "live" | "incomplete"
}

export function resolveReviewSource(input: {
  selected: ChangeMode
  status?: string
  summaryComplete?: boolean
  hasVcs: boolean
}): ReviewSource {
  if (input.selected === "git") return { mode: "git", kind: "workspace" }
  if (input.selected === "branch") return { mode: "branch", kind: "branch" }

  const active = input.status === "busy" || input.status === "retry"
  const incomplete = input.summaryComplete === false
  if ((active || incomplete) && input.hasVcs) return { mode: "git", kind: "live" }
  if (active || incomplete) return { mode: "turn", kind: "incomplete" }
  return { mode: "turn", kind: "recorded" }
}

export function createReviewController<T>(input: {
  source: () => ReviewSource
  recorded: () => T[]
  recordedRevision: () => string | undefined
  vcs: () => T[] | undefined
  vcsFetched: () => boolean
  vcsPending: () => boolean
  vcsError: () => unknown
}) {
  const usesVcs = () => input.source().mode === "git" || input.source().mode === "branch"
  const diffs = () => {
    if (!usesVcs()) return input.recorded()
    if (!input.vcsFetched() || input.vcsError()) return []
    return input.vcs() ?? []
  }

  return {
    source: input.source,
    usesVcs,
    diffs,
    count: () => diffs().length,
    ready: () => !usesVcs() || !input.vcsPending(),
    error: () => (usesVcs() ? input.vcsError() : undefined),
    revision: () => (input.source().kind === "recorded" ? input.recordedRevision() : undefined),
  }
}

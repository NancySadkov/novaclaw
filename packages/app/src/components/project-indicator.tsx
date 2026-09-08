import { createMemo, createResource, For, Show, type Accessor, type Component } from "solid-js"
import type { ServerConnection } from "@/context/server"
import { useLanguage } from "@/context/language"
import { pathKey } from "@/utils/path-key"
import { projectState, type ProjectState } from "@/utils/project-api"
import { PROJECT_DETAIL_LABELS, projectSummary, type ProjectScope, type ProjectSummary } from "./project-summary"

/**
 * **The Project indicator, shared by Chats and Files.**
 *
 * The rule: *"never make a person infer project state from a hidden dotfile."* This is the
 * at-a-glance half — a chip that states what governs the folder — plus one compact detail block that
 * names the file. It is deliberately NOT a second Settings → Project panel: it reports, it does not
 * edit, and every sentence it shows comes from `project-summary.ts`.
 *
 * ⚠️ Read-only by construction. The `novaclaw.json` write path is a separate surface; a second
 * writer is how two screens end up disagreeing about what is on disk.
 */

/** The chip's colours per tone. Tokens only — never a literal hex (uix.md §2: theme by remapping). */
const TONE_CLASS: Record<ProjectSummary["tone"], string> = {
  // A Project is a fact, not an alert: the muted layer chip the rest of the row meta uses.
  project: "bg-v2-background-bg-layer-01 text-v2-text-text-muted",
  plain: "bg-transparent text-v2-text-text-faint",
  // ⚠️ Warning, not danger. A file that will not parse is something to fix, not a failure of the
  // app — and AGENTS.md asks for "a calm message, never a stack trace". Red would overstate it.
  warning: "bg-v2-state-bg-warning text-v2-state-fg-warning",
}

/**
 * The one-word state chip. `title` carries the headline so the answer is available on hover even
 * where there is no room for a detail block (a Chats row).
 */
export const ProjectChip: Component<{ summary: ProjectSummary; class?: string }> = (props) => (
  <span
    data-component="project-chip"
    data-kind={props.summary.kind}
    data-tone={props.summary.tone}
    title={props.summary.headline}
    class={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] leading-none [font-weight:530] ${TONE_CLASS[props.summary.tone]} ${props.class ?? ""}`}
  >
    {props.summary.label}
  </span>
)

/** One labelled path line — the root and the file, which is what makes a refusal traceable. */
const PathLine: Component<{ label: string; value: string; slot: string }> = (props) => (
  <div class="flex min-w-0 items-baseline gap-2">
    <span class="shrink-0 text-[11px] leading-4 text-v2-text-text-faint [font-weight:470]">{props.label}</span>
    <span data-slot={props.slot} class="min-w-0 break-all font-mono text-[11px] leading-4 text-v2-text-text-muted">
      {props.value}
    </span>
  </div>
)

/**
 * The detail: what is in force, which file said so, what it contributes, and one sentence teaching
 * what a Project is. Small enough to sit inside a dialog row or under a toolbar.
 */
export const ProjectDetail: Component<{ summary: ProjectSummary; showChip?: boolean }> = (props) => {
  const language = useLanguage()
  return (
    <div data-component="project-detail" data-kind={props.summary.kind} class="flex min-w-0 flex-col gap-1">
      <div class="flex min-w-0 items-start gap-2">
        <Show when={props.showChip !== false}>
          <ProjectChip summary={props.summary} class="mt-px" />
        </Show>
        {/* Principle 12(d): what is in force RIGHT NOW, before any detail or control. */}
        <span data-slot="project-headline" class="min-w-0 text-[12px] leading-4 text-v2-text-text-base">
          {props.summary.headline}
        </span>
      </div>
      <Show when={props.summary.root}>
        {(root) => <PathLine label={language.t(PROJECT_DETAIL_LABELS.root)} value={root()} slot="project-root" />}
      </Show>
      <Show when={props.summary.file}>
        {(file) => <PathLine label={language.t(PROJECT_DETAIL_LABELS.file)} value={file()} slot="project-file" />}
      </Show>
      <For each={props.summary.contributes}>
        {(line) => (
          <span data-slot="project-contributes" class="text-[11px] leading-4 text-v2-text-text-muted">
            {line}
          </span>
        )}
      </For>
      {/* Principle 8 — teach, don't gatekeep. A curious non-expert should leave this block knowing
          what a Project is, without having read the roadmap. */}
      <span data-slot="project-teach" class="text-[11px] leading-4 text-v2-text-text-faint">
        {props.summary.teach}
      </span>
    </div>
  )
}

/** One folder's project state, refetched when the folder or the server changes. */
export function useProjectState(source: Accessor<{ http: ServerConnection.HttpBase; directory: string } | undefined>) {
  const [state] = createResource(source, (value) =>
    // ⚠️ A failed lookup resolves to `undefined`, not a throw. `createResource` turns a rejection
    // into an error state that Solid re-throws at the nearest boundary, and losing the whole Files
    // app because a project probe 404'd is exactly the dead end AGENTS.md forbids. Saying nothing is
    // the honest degrade: the surface only claims "not a Project" when the server said so.
    projectState(value.http, value.directory).catch(() => undefined),
  )
  return state
}

/** The summary for one folder, or `undefined` while the answer is still in flight. */
export function useProjectSummary(
  source: Accessor<{ http: ServerConnection.HttpBase; directory: string } | undefined>,
  scope: ProjectScope,
) {
  const language = useLanguage()
  const state = useProjectState(source)
  // `.latest`, not `state()`: calling the resource SUSPENDS while it refetches, which would blank
  // the chip on every folder change in Files (`pages/files.tsx` documents the same trap).
  return createMemo(() => projectSummary(state.latest, language.t, scope))
}

/**
 * Project state for MANY folders at once, as a lookup.
 *
 * The Chats list spans every open folder, so a per-row fetch would be one request per chat. This
 * takes the page's already-computed folder set — bounded by how many folders are open, not by how
 * many chats exist — and answers each row from one round of requests.
 */
export function useProjectStates(
  source: Accessor<{ http: ServerConnection.HttpBase; directories: readonly string[] } | undefined>,
) {
  // ⚠️ A memo with EXPLICIT equality, not the raw accessor. `createResource` compares its source
  // by `===`, and the caller’s folder set is re-derived from a store — a fresh array on every
  // unrelated store write. Handing that straight to the resource would refetch every folder
  // continuously. Keying on the sorted, normalized list makes "the same folders, re-derived" a no-op.
  const stable = createMemo(
    () => {
      const value = source()
      if (!value || value.directories.length === 0) return undefined
      const unique = [...new Set(value.directories)].sort()
      const key = unique.map((directory) => pathKey(directory)).join("|")
      return { http: value.http, directories: unique, key: `${value.http.url} ${key}` }
    },
    undefined,
    { equals: (a, b) => a?.key === b?.key },
  )
  const [states] = createResource(stable, async (value) => {
    const seen = new Map<string, ProjectState>()
    await Promise.all(
      value.directories.map(async (directory) => {
        const answer = await projectState(value.http, directory).catch(() => undefined)
        if (answer) seen.set(pathKey(directory), answer)
      }),
    )
    return seen
  })
  return (directory: string | undefined) =>
    directory === undefined ? undefined : states.latest?.get(pathKey(directory))
}

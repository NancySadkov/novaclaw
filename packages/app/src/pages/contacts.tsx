import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { GoldGlyph } from "@/components/gold-glyph"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { AppPage } from "@/components/app-page"
import { agentColor } from "@/utils/agent"
import { memoryDisclosure, roster, searchRoster, type AgentLike, type ContactView } from "@/apps/contacts"

// The Contacts app — the roster of colleagues this instance employs (AGENTS.md → *the structural
// metaphor*; `todo/named-agents.md`).
//
// This replaces "a list of chats that only grows" with "the people you work with", and the swap is
// the point: a session list is a machine's view of history, while a roster is a person's view of an
// organization. Nova (the CEO) is the first row and cannot be retired; every other row is a colleague
// the user hired and may re-brief or retire.
//
// ⚠️ Two rules run through this page and must survive any edit:
//   1. **Memory is disclosed in BOTH halves** — what a colleague keeps to itself AND what every
//      colleague can see. The surveyed competitor's roster names only the first while sharing the
//      machine underneath (`notes/survey/grokbot-research.md`); a row that reads the same way here
//      would be promising an isolation we did not build.
//   2. **A control the API will refuse is not rendered.** Nova has no Retire button, and the endpoint
//      refuses it too — the UI is not the enforcement, it is the honest face of it.
//
// The ordering, filtering and disclosure decisions live in `@/apps/contacts` where tests reach them.

/** The V2 agent list, which is the ONE shape carrying the roster profile.
 *
 *  ⚠️ Deliberately NOT the global sync store's `data.agent`: that reads the legacy `GET /agent`
 *  projection whose entries are keyed by `name` and carry no `title`, `personality`, `avatar` or
 *  `memory`. Two shapes for one concept is a migration this page must not silently depend on — filed
 *  in `todo/named-agents.md`. */
const listAgents = async (sdk: { agent: { list: () => Promise<{ data?: unknown }> } }): Promise<AgentLike[]> => {
  const response = await sdk.agent.list()
  // ⚠️ TWO `data` hops, and they are different things. The SDK wraps the HTTP body as
  // `{ data: body }`, and every V2 location-scoped endpoint wraps its payload again as
  // `{ location, data }` (`Location.response`). Reading one hop yields the ENVELOPE — an object, not
  // an array — which `Array.isArray` then rejects into an empty roster that looks like "you have no
  // colleagues". Measured against the live instance: `GET /api/agent` returned build, plan, nova,
  // general and explore while this page rendered the empty state.
  const body = response.data as { readonly data?: unknown } | undefined
  const rows = (Array.isArray(body) ? body : (body?.data ?? [])) as ReadonlyArray<Record<string, unknown>>
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const id = typeof row["id"] === "string" ? row["id"] : undefined
    const mode = row["mode"]
    if (id === undefined || (mode !== "primary" && mode !== "subagent" && mode !== "all")) return []
    const text = (key: string) => (typeof row[key] === "string" ? (row[key] as string) : undefined)
    const memory = row["memory"] === "none" ? ("none" as const) : row["memory"] === "own" ? ("own" as const) : undefined
    return [
      {
        id,
        mode,
        hidden: row["hidden"] === true,
        title: text("title"),
        description: text("description"),
        personality: text("personality"),
        avatar: text("avatar"),
        color: text("color"),
        memory,
      } satisfies AgentLike,
    ]
  })
}

export function ContactsPage() {
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<string | undefined>(undefined)

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const current = conn()
    return current ? global.ensureServerCtx(current) : undefined
  })

  // ⚠️ NO `.catch(() => [])` here, and that is deliberate. A swallowed failure renders the empty
  // state — "No colleagues yet" — which is a LIE when the request failed: it tells the user their
  // organization is empty rather than that we could not read it. Measured the hard way: the first
  // draft of this page called the wrong client namespace, the catch turned a TypeError into an empty
  // roster, and the screen looked like a working feature with nobody hired.
  const [agents] = createResource(ctx, (current) => listAgents(current.sdk.client.v2))

  const views = createMemo(() => roster(agents() ?? []))
  const shown = createMemo(() => searchRoster(views(), query()))
  const open = createMemo(() => views().find((view) => view.id === selected()))

  return (
    <AppPage class="flex flex-col overflow-hidden">
      <div class="flex items-center gap-3 border-b border-v2-border-border-base px-4 py-2.5">
        <GoldGlyph name="user" class="size-6" />
        <span class="text-[15px] font-semibold">{language.t("contacts.title")}</span>
        <span class="min-w-0 flex-1 truncate text-xs text-v2-text-text-faint">{language.t("contacts.hint")}</span>
      </div>

      <div class="border-b border-v2-border-border-base px-4 py-2">
        <TextInputV2
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder={language.t("contacts.search")}
        />
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show
          when={shown().length > 0}
          fallback={
            <p class="px-4 py-6 text-sm text-v2-text-text-faint">
              {/* Four distinct situations, four distinct sentences. An empty roster, a search that
                  matched nothing, a roster still loading and a roster we FAILED to read are not the
                  same fact, and collapsing them is how a broken request reads as "you have nobody". */}
              {agents.error !== undefined
                ? language.t("contacts.loadFailed")
                : agents.loading
                  ? language.t("contacts.loading")
                  : views().length === 0
                    ? language.t("contacts.empty")
                    : language.t("contacts.noMatch")}
            </p>
          }
        >
          <For each={shown()}>{(view) => <ContactRow view={view} onOpen={() => setSelected(view.id)} />}</For>
        </Show>
      </div>

      <Show when={open()}>{(view) => <ContactConfig view={view()} onClose={() => setSelected(undefined)} />}</Show>
    </AppPage>
  )
}

function ContactRow(props: { view: ContactView; onOpen: () => void }) {
  const language = useLanguage()
  const disclosure = createMemo(() => memoryDisclosure(props.view.memory))
  return (
    <button
      type="button"
      onClick={props.onOpen}
      class="flex w-full items-center gap-3 border-b border-v2-border-border-base px-4 py-3 text-left transition-colors hover:bg-v2-background-bg-layer-02"
    >
      <span
        class="flex size-9 shrink-0 items-center justify-center rounded-full text-base"
        style={{ "background-color": agentColor(props.view.id, props.view.color) }}
      >
        {props.view.avatar ?? props.view.name.charAt(0)}
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-2">
          <span class="truncate text-sm font-medium">{props.view.name}</span>
          <Show when={props.view.kind === "governing"}>
            <span class="rounded-full bg-v2-background-bg-layer-02 px-2 py-0.5 text-[10px] uppercase tracking-wide text-v2-text-text-muted">
              {language.t("contacts.governing")}
            </span>
          </Show>
        </span>
        <span class="block truncate text-xs text-v2-text-text-muted">
          {props.view.title ?? language.t("contacts.noTitle")}
        </span>
        {/* Both halves, on the row itself — not behind the detail view. */}
        <span class="block truncate text-[11px] text-v2-text-text-faint">
          {language.t(disclosure().privateKey)} · {language.t(disclosure().sharedKey)}
        </span>
      </span>
      <Icon name="chevron-right" class="size-4 shrink-0 text-v2-text-text-faint" />
    </button>
  )
}

/** The agent's configuration — the destination the composer's Tune button is being moved onto
 *  (`todo/named-agents.md`). Today it shows identity and memory; the model/agent picker and the Tune
 *  toggles land here next, so that one dialog answers "who is this colleague and how does it work". */
function ContactConfig(props: { view: ContactView; onClose: () => void }) {
  const language = useLanguage()
  const disclosure = createMemo(() => memoryDisclosure(props.view.memory))
  return (
    <div class="border-t border-v2-border-border-base bg-v2-background-bg-layer-01 px-4 py-3">
      <div class="flex items-center gap-2">
        <span class="text-sm font-semibold">{props.view.name}</span>
        <span class="min-w-0 flex-1 truncate text-xs text-v2-text-text-muted">{props.view.title ?? ""}</span>
        <button type="button" class="text-xs text-v2-text-text-muted hover:underline" onClick={props.onClose}>
          {language.t("contacts.close")}
        </button>
      </div>
      <p class="mt-2 text-xs text-v2-text-text-muted">
        {language.t(disclosure().privateKey)} {language.t(disclosure().sharedKey)}
      </p>
      <Show
        when={props.view.removable}
        fallback={
          // Stated, not merely omitted: a missing button is a puzzle, a sentence is an explanation.
          <p class="mt-2 text-xs text-v2-text-text-faint">{language.t("contacts.governingLocked")}</p>
        }
      >
        <p class="mt-2 text-xs text-v2-text-text-faint">{language.t("contacts.retireHint")}</p>
      </Show>
    </div>
  )
}

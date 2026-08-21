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
import { listAgents } from "@/apps/agent-list"
import { AgentConfigDialog } from "@/components/agent-config-dialog"

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

      {/* The SAME dialog the composer's Tune button opens — one place to learn what a colleague is
          and how it behaves. Contacts passes no `tuning` section: there is no chat here to tune, and
          an empty section would imply one. */}
      <Show when={open()}>
        {(view) => <AgentConfigDialog agentID={view().id} onDismiss={() => setSelected(undefined)} />}
      </Show>
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

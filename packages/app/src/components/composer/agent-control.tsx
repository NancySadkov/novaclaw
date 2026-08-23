import { For, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { selectedOption, type ComposerAgentControlState } from "./agent-option"

// WHO the prompt is for (owner, 2026-08-21: *"the prompt area, both in chat and at the bottom of
// home screen, needs an agent selector, instead of a folder selector"*).
//
// 🔴 **This replaces the folder chip, and the replacement is the point.** Asking which FOLDER a chat
// runs in made "where does this work happen" a question the user answered again for every
// conversation — and left a named officer with no project of its own. The folder is now part of a
// colleague's configuration, so the prompt area asks the question that is actually left: *whose
// desk does this go on?* The folder follows from the answer.
//
// ⚠️ It shows the colleague's own FOLDER as the secondary line rather than hiding it. A user picking
// "Theron" needs to know they are about to work in `d/books`, and a chip that names only the person
// makes the working directory something you discover after the fact.

export function ComposerAgentControl(props: { state: ComposerAgentControlState }) {
  const language = useLanguage()
  const current = () => selectedOption(props.state)
  return (
    <Show when={props.state.options.length > 0}>
      <TooltipV2
        placement="top"
        gutter={4}
        value={language.t(props.state.working ? "prompt.agent.tooltip.working" : "prompt.agent.tooltip")}
      >
        <label class="flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-[440] leading-5 text-v2-text-text-faint hover:bg-v2-background-bg-layer-02">
          <Show when={current()?.avatar} fallback={<Icon name="user" class="size-3.5 shrink-0" />}>
            {(avatar) => <span class="shrink-0">{avatar()}</span>}
          </Show>
          {/* 🔴 In a chat the NAME IS NOT REPEATED here (owner, 2026-08-23: *"the prompt area
              doesn't really need to have the agent's name, since it is already in the tab title"*).
              The tab strip above now says who you are talking to, and saying it twice on one screen
              spends the composer's scarcest width on a fact already in view. The avatar stays —
              it is the glance-level identity — and the tooltip still names them for anyone who
              needs the word rather than the mark. On HOME this branch never runs: there the chip is
              a real selector, and a selector with no label is a puzzle. */}
          <Show when={props.state.readOnly}>
            <span data-slot="prompt-agent-name" class="sr-only">
              {current()?.name}
            </span>
          </Show>
          <Show when={!props.state.readOnly}>
            <select
              data-action="prompt-agent"
              disabled={props.state.working}
              class="max-w-[12rem] truncate bg-transparent outline-none disabled:cursor-not-allowed disabled:opacity-60"
              onChange={(event) => props.state.onSelect(event.currentTarget.value)}
            >
              <For each={props.state.options}>
                {(option) => (
                  // ⚠️ `selected` per option, not `value` on the select: the options arrive with the
                  // roster, AFTER the element is created, and a browser keeps `selectedIndex` at 0 when
                  // children appear later. Measured on the Memory app's owner picker 2026-08-21 — it
                  // read "Nova" over somebody else's memories.
                  <option value={option.id} selected={option.id === current()?.id}>
                    {option.name}
                    {option.ownScratch ? "" : ` · ${option.folder}`}
                  </option>
                )}
              </For>
            </select>
          </Show>
        </label>
      </TooltipV2>
    </Show>
  )
}

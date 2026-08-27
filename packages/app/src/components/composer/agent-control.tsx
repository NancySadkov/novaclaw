import { For, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { selectedOption, type ComposerAgentControlState } from "./agent-option"
import { AgentPortrait } from "@/components/agent-portrait"

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
        <label
          data-action={props.state.onOpenConfig ? "prompt-agent-config" : undefined}
          data-mode={props.state.unattended?.() ? "unattended" : undefined}
          // The whole chip is the target, portrait and name alike — the owner asked for "clicking any
          // of them". A `<label>` is still correct on HOME, where it labels the real `<select>`; the
          // click handler only exists on the read-only in-chat branch, where there is no control to
          // label and the chip IS the button.
          onClick={props.state.readOnly ? props.state.onOpenConfig : undefined}
          role={props.state.readOnly && props.state.onOpenConfig ? "button" : undefined}
          tabindex={props.state.readOnly && props.state.onOpenConfig ? 0 : undefined}
          onKeyDown={(event) => {
            if (!props.state.readOnly || !props.state.onOpenConfig) return
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            props.state.onOpenConfig()
          }}
          class="flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-[440] leading-5 text-v2-text-text-faint hover:bg-v2-background-bg-layer-02"
          classList={{ "cursor-pointer": !!(props.state.readOnly && props.state.onOpenConfig) }}>
          <Show when={current()} fallback={<Icon name="user" class="size-3.5 shrink-0" />}>
            {(agent) => (
              <AgentPortrait id={agent().id} name={agent().name} avatar={agent().avatar} class="size-4 text-[9px]" />
            )}
          </Show>
          {/* 🔴 **The name is BACK, and it supersedes the 2026-08-23 ruling that removed it.** That
              call — *"the prompt area doesn't really need to have the agent's name, since it is
              already in the tab title"* — was made when this chip was inert. Now it is the door to
              the colleague's configuration (owner, 2026-08-27), and a door needs a handle you can
              read: an unlabelled avatar that opens a settings dialog is a puzzle, which is the same
              objection that kept the label on HOME's selector all along. The tab title still names
              the colleague; this names what the CONTROL acts on, which is a different job. */}
          <Show when={props.state.readOnly}>
            <span data-slot="prompt-agent-name" class="truncate">
              {current()?.name}
              {props.state.modeSuffix?.() ?? ""}
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

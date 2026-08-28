import { For, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { selectedOption, type ComposerAgentControlState } from "./agent-option"
import { displayName as folderName } from "@/pages/layout/helpers"
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
  const tooltip = () => language.t(props.state.working ? "prompt.agent.tooltip.working" : "prompt.agent.tooltip")

  /**
   * 🔴 **Two controls, two hover targets** (owner, 2026-08-28: *"when you hover over the agent's
   * project folder button, it also highlights its name, and when you hover over it's name it
   * highlight the project. Please decouple."*).
   *
   * The chip was ONE element carrying the hover background, with the project button nested inside it,
   * so either pointer lit the whole thing. A highlight that spans two controls says they ARE one
   * control — the exact impression the split existed to remove: pressing the name opens WHO this is,
   * pressing the folder changes WHAT they work on.
   *
   * ⚠️ The container keeps NO hover of its own. Giving it one would light both again the moment the
   * pointer crossed the separator.
   *
   * ⚠️ The in-chat branch is now its own markup rather than a `<label>` bent into shape by `Dynamic`.
   * A label FORWARDS activation to the control inside it, which is why pressing the chip used to fire
   * the project picker; a real `<button>` needs no `role`, no `tabindex` and no hand-written Enter/
   * Space handler, and cannot forward anything. The HOME branch stays a `<label>`, where it labels a
   * real `<select>` and is correct.
   */
  return (
    <Show when={props.state.options.length > 0}>
      <Show
        when={props.state.readOnly}
        fallback={
          <TooltipV2 placement="top" gutter={4} value={tooltip()}>
            <label
              data-mode={props.state.unattended?.() ? "unattended" : undefined}
              class="flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-[440] leading-5 text-v2-text-text-faint hover:bg-v2-background-bg-layer-02"
            >
              <Show when={current()} fallback={<Icon name="user" class="size-3.5 shrink-0" />}>
                {(agent) => (
                  <AgentPortrait
                    id={agent().id}
                    name={agent().name}
                    avatar={agent().avatar}
                    class="size-4 text-[9px]"
                  />
                )}
              </Show>
              <select
                data-action="prompt-agent"
                disabled={props.state.working}
                class="max-w-[12rem] truncate bg-transparent outline-none disabled:cursor-not-allowed disabled:opacity-60"
                onChange={(event) => props.state.onSelect(event.currentTarget.value)}
              >
                <For each={props.state.options}>
                  {(option) => (
                    // ⚠️ `selected` per option, not `value` on the select: the options arrive with the
                    // roster, AFTER the element is created, and a browser keeps `selectedIndex` at 0
                    // when children appear later. Measured on the Memory app's owner picker
                    // 2026-08-21 — it read "Nova" over somebody else's memories.
                    <option value={option.id} selected={option.id === current()?.id}>
                      {option.name}
                      {option.ownScratch ? "" : ` · ${option.folder}`}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </TooltipV2>
        }
      >
        <div
          data-mode={props.state.unattended?.() ? "unattended" : undefined}
          class="flex h-7 items-center text-[13px] font-[440] leading-5 text-v2-text-text-faint"
        >
          {/* 🔴 **The name is BACK, and it supersedes the 2026-08-23 ruling that removed it.** That
              call — *"the prompt area doesn't really need to have the agent's name, since it is
              already in the tab title"* — was made when this chip was inert. Now it is the door to
              the colleague's configuration (owner, 2026-08-27), and a door needs a handle you can
              read: an unlabelled avatar that opens a settings dialog is a puzzle, which is the same
              objection that kept the label on HOME's selector all along. The tab title still names
              the colleague; this names what the CONTROL acts on, which is a different job. */}
          <TooltipV2 placement="top" gutter={4} value={tooltip()}>
            <button
              type="button"
              data-action={props.state.onOpenConfig ? "prompt-agent-config" : undefined}
              onClick={() => props.state.onOpenConfig?.()}
              class="flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-v2-background-bg-layer-02"
              classList={{ "cursor-pointer": !!props.state.onOpenConfig }}
            >
              <Show when={current()} fallback={<Icon name="user" class="size-3.5 shrink-0" />}>
                {(agent) => (
                  <AgentPortrait
                    id={agent().id}
                    name={agent().name}
                    avatar={agent().avatar}
                    class="size-4 text-[9px]"
                  />
                )}
              </Show>
              <span data-slot="prompt-agent-name" class="truncate">
                {current()?.name}
                {props.state.modeSuffix?.() ?? ""}
              </span>
            </button>
          </TooltipV2>
          {/* 🔴 **THE PROJECT, on screen the whole conversation** (owner, 2026-08-28). It used to live
              only inside Tune, three sections down, so "what is this colleague working on right now"
              cost a dialog open and a scroll — while this chip had the answer already resolved and
              showed nothing. A colleague's folder is part of its job, and the composer is the one
              surface that is never not visible. */}
          <Show when={current() && props.state.onPickProject}>
            <span aria-hidden="true" class="px-0.5 text-v2-text-text-faint">
              ·
            </span>
            <button
              type="button"
              data-action="prompt-agent-project"
              class="max-w-[14rem] truncate rounded px-1 text-v2-text-text-faint hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-base"
              title={current()!.ownScratch ? language.t("prompt.agent.project.own") : current()!.folder}
              onClick={() => props.state.onPickProject?.()}
            >
              {current()!.ownScratch
                ? language.t("prompt.agent.project.none")
                : folderName({ worktree: current()!.folder })}
            </button>
          </Show>
        </div>
      </Show>
    </Show>
  )
}

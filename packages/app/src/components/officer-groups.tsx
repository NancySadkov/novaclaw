import { For, Show, type JSX } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { AgentPortrait } from "./agent-portrait"
import { groupMembers, type ContactGroup, type ContactView } from "@/apps/contacts"
import { useLanguage } from "@/context/language"

export function OfficerGroups(props: {
  groups: readonly ContactGroup[]
  expanded: ReadonlySet<string>
  onToggle: (id: string) => void
  renderCard: (view: ContactView) => JSX.Element
  attention: (ids: readonly string[]) => number
}) {
  const language = useLanguage()
  return (
    <For each={props.groups}>
      {(group) => {
        let toggle: HTMLButtonElement | undefined
        const open = () => props.expanded.has(group.id)
        const label = () => language.t("contacts.team.title", { name: group.name })
        const close = () => {
          props.onToggle(group.id)
          toggle?.focus()
        }
        const count = () => groupMembers(group).length
        const attention = () => props.attention(groupMembers(group).map((member) => member.id))
        return (
          <>
            <div class="officer-group" data-officer-group={group.id}>
              {props.renderCard(group)}
              <Show when={group.children.length > 0}>
                <button
                  ref={toggle}
                  type="button"
                  class="officer-team-stack"
                  data-open={open()}
                  aria-label={label()}
                  aria-expanded={open()}
                  aria-controls={`officer-team-${group.id}`}
                  onClick={() => props.onToggle(group.id)}
                >
                  <span class="officer-team-faces" aria-hidden="true">
                    <For each={group.children.slice(0, 3)}>
                      {(child) => <AgentPortrait id={child.id} avatar={child.avatar} name={child.name} />}
                    </For>
                  </span>
                  <span class="officer-team-count">{language.t("contacts.team.count", { count: count() })}</span>
                  <Show when={attention() > 0}>
                    <span
                      class="officer-team-attention"
                      aria-label={language.t("contacts.team.unread", { count: attention() })}
                    >
                      {attention()}
                    </span>
                  </Show>
                  <Icon name="chevron-down" size="small" />
                </button>
              </Show>
            </div>
            <Show when={open() && group.children.length > 0}>
              <section
                id={`officer-team-${group.id}`}
                class="officer-team-panel"
                aria-label={label()}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || event.defaultPrevented) return
                  event.preventDefault()
                  event.stopPropagation()
                  close()
                }}
              >
                <div class="officer-team-heading">
                  <span>{label()}</span>
                  <button
                    type="button"
                    aria-label={language.t("contacts.team.close", { name: group.name })}
                    onClick={close}
                  >
                    <Icon name="close" size="small" />
                  </button>
                </div>
                <div class="officer-roster-grid">
                  <OfficerGroups {...props} groups={group.children} />
                </div>
              </section>
            </Show>
          </>
        )
      }}
    </For>
  )
}

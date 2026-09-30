import { Index, Show } from "solid-js"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import type { RecipeNudge, RecipeOfficer } from "@novaclaw/schema/recipe-officer"

const triggers = [
  { id: "after-compaction", label: "After context is summarized" },
  { id: "new-day", label: "A new day begins" },
  { id: "interval", label: "Every few minutes" },
  { id: "tool-call", label: "A tool is called" },
  { id: "file-write", label: "After writing a file type" },
] as const
const toolPhases = [
  { id: "before", label: "Before" },
  { id: "after", label: "After" },
] as const

export function RecipeOfficersEditor(props: {
  officers: readonly RecipeOfficer[]
  onChange: (officers: readonly RecipeOfficer[]) => void
}) {
  const update = (index: number, patch: Partial<RecipeOfficer>) =>
    props.onChange(props.officers.map((officer, i) => (i === index ? { ...officer, ...patch } : officer)))
  const nudgeChange = (index: number, n: number, patch: Partial<RecipeNudge>) =>
    update(index, {
      nudges: props.officers[index]!.nudges.map((nudge, i) => (i === n ? { ...nudge, ...patch } : nudge)),
    })
  return (
    <section class="recipe-team-editor" aria-label="Recipe officers">
      <div class="recipe-team-heading">
        <div>
          <span class="recipe-studio-eyebrow">PROJECT TEAM</span>
          <h3>Project team</h3>
        </div>
        <button
          type="button"
          class="project-button"
          disabled={props.officers.length >= 16}
          onClick={() => props.onChange([...props.officers, { title: "", description: "", nudges: [] }])}
        >
          + Add officer
        </button>
      </div>
      <p class="recipe-studio-muted">A Manager is included. Add the specialist roles your recipe needs.</p>
      <div class="recipe-reporting-line">
        <span>Nova</span>
        <span>→</span>
        <strong>Manager</strong>
        <span>→</span>
        <span>
          {props.officers.length
            ? `${props.officers.length} ${props.officers.length === 1 ? "officer" : "officers"}`
            : "Works on the recipe"}
        </span>
      </div>
      <Index each={props.officers}>
        {(officer, index) => (
          <article class="recipe-officer-card">
            <div class="recipe-team-heading">
              <strong>Officer {index + 1}</strong>
              <button
                type="button"
                class="project-button"
                aria-label={`Remove officer ${index + 1}`}
                onClick={() => props.onChange(props.officers.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </div>
            <label>
              Job title
              <input
                class="project-field"
                maxLength={160}
                value={officer().title}
                placeholder="e.g. Researcher"
                onInput={(event) => update(index, { title: event.currentTarget.value })}
              />
            </label>
            <label>
              Job description
              <textarea
                class="project-field"
                rows={3}
                maxLength={16000}
                value={officer().description}
                placeholder="What this officer owns and how they should work"
                onInput={(event) => update(index, { description: event.currentTarget.value })}
              />
            </label>
            <details class="recipe-nudges">
              <summary>
                Custom nudges{officer().nudges.length ? ` · ${officer().nudges.length}` : " · Optional"}
              </summary>
              <p class="recipe-studio-muted">Reminders delivered to this officer at the moments you choose.</p>
              <div class="recipe-team-heading">
                <strong>Custom nudges</strong>
                <button
                  type="button"
                  class="project-button"
                  disabled={officer().nudges.length >= 32}
                  onClick={() =>
                    update(index, {
                      nudges: [...officer().nudges, { name: "", text: "", hook: { type: "after-compaction" } }],
                    })
                  }
                >
                  + Add nudge
                </button>
              </div>
              <Index each={officer().nudges}>
                {(nudge, n) => (
                  <div class="recipe-nudge-card">
                    <label>
                      Name
                      <input
                        class="project-field"
                        value={nudge().name}
                        maxLength={160}
                        onInput={(event) => nudgeChange(index, n, { name: event.currentTarget.value })}
                      />
                    </label>
                    <label>
                      When
                      <SelectV2
                        aria-label={`When officer ${index + 1} nudge ${n + 1} fires`}
                        options={[...triggers]}
                        current={triggers.find((trigger) => trigger.id === nudge().hook.type)}
                        value={(trigger) => trigger.id}
                        label={(trigger) => trigger.label}
                        onSelect={(trigger) => {
                          if (!trigger) return
                          const type = trigger.id
                          nudgeChange(index, n, {
                            hook:
                              type === "interval"
                                ? { type, minutes: 60 }
                                : type === "tool-call"
                                  ? { type, tool: "bash", phase: "after" }
                                  : type === "file-write"
                                    ? { type, extension: "ts" }
                                    : { type },
                          })
                        }}
                      />
                    </label>
                    <Show when={nudge().hook.type === "interval"}>
                      <label>
                        Minutes
                        <input
                          class="project-field"
                          type="number"
                          min={1}
                          max={1440}
                          value={(nudge().hook as { minutes: number }).minutes}
                          onInput={(event) =>
                            nudgeChange(index, n, {
                              hook: { type: "interval", minutes: Number(event.currentTarget.value) },
                            })
                          }
                        />
                      </label>
                    </Show>
                    <Show when={nudge().hook.type === "tool-call"}>
                      <label>
                        Timing
                        <SelectV2
                          aria-label="Tool nudge timing"
                          options={[...toolPhases]}
                          current={toolPhases.find((phase) => phase.id === (nudge().hook as { phase: string }).phase)}
                          value={(phase) => phase.id}
                          label={(phase) => phase.label}
                          onSelect={(phase) => {
                            if (phase)
                              nudgeChange(index, n, {
                                hook: {
                                  ...(nudge().hook as Extract<RecipeNudge["hook"], { type: "tool-call" }>),
                                  phase: phase.id,
                                },
                              })
                          }}
                        />
                      </label>
                      <label>
                        Tool
                        <input
                          class="project-field"
                          value={(nudge().hook as { tool: string }).tool}
                          onInput={(event) =>
                            nudgeChange(index, n, {
                              hook: {
                                type: "tool-call",
                                tool: event.currentTarget.value,
                                phase: (nudge().hook as { phase: "before" | "after" }).phase,
                              },
                            })
                          }
                        />
                      </label>
                    </Show>
                    <Show when={nudge().hook.type === "file-write"}>
                      <label>
                        File extension
                        <input
                          class="project-field"
                          value={(nudge().hook as { extension: string }).extension}
                          onInput={(event) =>
                            nudgeChange(index, n, {
                              hook: { type: "file-write", extension: event.currentTarget.value },
                            })
                          }
                        />
                      </label>
                    </Show>
                    <label>
                      Instruction
                      <textarea
                        class="project-field"
                        rows={2}
                        maxLength={16000}
                        value={nudge().text}
                        onInput={(event) => nudgeChange(index, n, { text: event.currentTarget.value })}
                      />
                    </label>
                    <button
                      type="button"
                      class="project-button"
                      onClick={() => update(index, { nudges: officer().nudges.filter((_, i) => i !== n) })}
                    >
                      Remove nudge
                    </button>
                  </div>
                )}
              </Index>
            </details>
          </article>
        )}
      </Index>
    </section>
  )
}

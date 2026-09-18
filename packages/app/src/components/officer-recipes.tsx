import { For, Show, createSignal } from "solid-js"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { Switch as SwitchToggle } from "@novaclaw/ui/v2/switch-v2"
import { useConfirm } from "@/components/dialog-confirm"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { planRecipeSave, type Recipe as AdhocRecipe } from "@/components/settings-v2/tools-draft"

/**
 * One officer's private ad-hoc recipes: list, add, edit, delete, enable.
 *
 * 🔴 **Extracted, not inlined in the officer dialog, so the failed-write pin survives the
 * Settings tab's deletion.** `test-browser/settings-failed-write-render.test.tsx` proved the
 * deleted tab kept the editor open (with the draft intact) when the write was rejected — an
 * up-to-8 KB manual lost to an unmount is not a failure a toast makes up for. This component
 * mounts standalone under the same context stubs, so that file keeps proving it here: every
 * write below reports its verdict, and the editor closes ONLY on a landed write.
 *
 * All writes are live (like Nudges), not through the dialog's Save button: recipes are
 * replace-semantics lists, and a second save path for the same struct is how one of them
 * silently wins.
 *
 * ⚠️ The recipes come from the CALLER, which reads the same officer record the rest of the
 * dialog reads. A second read here (`sync().data.config.agents[id]`) would make the horizon
 * and the recipe list disagree about whose tuning is on screen.
 */
export function OfficerRecipes(props: { agentID: string | undefined; recipes: () => AdhocRecipe[] }) {
  const language = useLanguage()
  const sync = useServerSync()
  const confirm = useConfirm()

  const [editing, setEditing] = createSignal<string | undefined>()
  const [draftName, setDraftName] = createSignal("")
  const [draftDescription, setDraftDescription] = createSignal("")
  const [draftManual, setDraftManual] = createSignal("")
  const [draftError, setDraftError] = createSignal<string | undefined>()

  const recipes = () => props.recipes()

  /** The write verdict, said aloud: `true` landed, `false` toasted and must keep the draft. */
  const persist = async (next: readonly AdhocRecipe[]): Promise<boolean> => {
    const target = props.agentID
    if (target === undefined) return false
    try {
      // An emptied list deletes the key rather than storing `[]`: an officer that never had
      // recipes and one that removed them all must read the same.
      if (next.length === 0) await sync().removeConfig([["agents", target, "adhocTools"]])
      else await sync().updateConfig({ agents: { [target]: { adhocTools: [...next] } } } as never)
      return true
    } catch (error) {
      showToast({ variant: "error", title: language.t("agentConfig.saveFailed"), description: String(error) })
      return false
    }
  }

  const openEditor = (recipe?: AdhocRecipe) => {
    setDraftName(recipe?.name ?? "")
    setDraftDescription(recipe?.description ?? "")
    setDraftManual(recipe?.manual ?? "")
    setDraftError(undefined)
    setEditing(recipe?.name ?? "")
  }

  const saveDraft = async () => {
    // `planRecipeSave` is the ONLY way through: the collision refusal lives in it, so a rename
    // onto an existing recipe cannot delete its namesake — the defect its header records.
    const plan = planRecipeSave({
      recipes: recipes(),
      editing: editing() ?? "",
      name: draftName(),
      description: draftDescription(),
      manual: draftManual(),
    })
    if (!plan.ok) {
      setDraftError(
        plan.reason === "duplicate"
          ? "Another recipe already answers to that name."
          : plan.reason === "name"
            ? "Lowercase slug, a–z 0–9 - _, up to 64 chars."
            : plan.reason === "description"
              ? "One line, up to 300 chars."
              : "The manual is required, up to 8192 chars.",
      )
      return
    }
    setDraftError(undefined)
    // 🔴 The editor closes ONLY on a landed write (see the header): the draft is the user's,
    // so a rejection is named where the draft still is rather than only in a toast.
    const saved = await persist(plan.next)
    if (!saved) {
      setDraftError("Could not save the recipe — it is unchanged on the instance. Nothing was lost; try again.")
      return
    }
    setEditing(undefined)
  }

  const remove = async (recipe: AdhocRecipe) => {
    if (
      !(await confirm({
        title: `Delete ${recipe.name}?`,
        description: "The model will no longer be told about this recipe. This cannot be undone.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return
    await persist(recipes().filter((entry) => entry.name !== recipe.name))
  }

  return (
    <>
      <h4 class="mt-4 text-xs font-medium">This officer's own recipes</h4>
      <p class="mt-1 text-[11px] leading-relaxed text-v2-text-text-faint">
        Listed only in this officer's prompt — never instance-wide. Changes save immediately.
      </p>
      <div class="mt-2 flex flex-col gap-1.5">
        <For each={recipes()}>
          {(recipe) => (
            <div class="flex items-center justify-between gap-2 text-xs">
              <span class="min-w-0">
                <span class="block truncate font-medium">{recipe.name}</span>
                <span class="block truncate text-[11px] text-v2-text-text-faint">{recipe.description}</span>
              </span>
              <span class="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  class="rounded-md px-2 py-1 text-[11px] text-v2-text-text-muted hover:bg-v2-background-bg-layer-02"
                  onClick={() => openEditor(recipe)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  class="rounded-md px-2 py-1 text-[11px] text-v2-text-text-muted hover:bg-v2-background-bg-layer-02"
                  onClick={() => void remove(recipe)}
                >
                  Delete
                </button>
                <SwitchToggle
                  aria-label={`${recipe.name} enabled`}
                  checked={recipe.enabled !== false}
                  onChange={(checked) =>
                    void persist(
                      recipes().map((entry) => (entry.name === recipe.name ? { ...entry, enabled: checked } : entry)),
                    )
                  }
                />
              </span>
            </div>
          )}
        </For>
        <Show when={editing() === undefined}>
          <div>
            <button
              type="button"
              data-action="agent-recipe-add"
              class="rounded-md bg-v2-background-bg-layer-03 px-2.5 py-1.5 text-xs"
              onClick={() => openEditor()}
            >
              Add a recipe
            </button>
          </div>
        </Show>
      </div>
      <Show when={editing() !== undefined}>
        <div
          class="mt-3 rounded-xl border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3"
          data-component="officer-recipe-editor"
        >
          <TextInputV2
            class="w-full"
            value={draftName()}
            placeholder="Tool name (lowercase slug)"
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            onInput={(event) => setDraftName(event.currentTarget.value)}
            aria-label="Recipe name"
          />
          <TextInputV2
            class="mt-2 w-full"
            value={draftDescription()}
            placeholder="One-line description"
            spellcheck={false}
            onInput={(event) => setDraftDescription(event.currentTarget.value)}
            aria-label="Recipe description"
          />
          <textarea
            aria-label="Recipe manual"
            class="mt-2 min-h-20 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
            value={draftManual()}
            onInput={(event) => setDraftManual(event.currentTarget.value)}
            placeholder="API shape plus 1–2 curl/shell examples"
          />
          <Show when={draftError()}>
            <p class="mt-1 text-[11px] text-v2-state-fg-danger">{draftError()}</p>
          </Show>
          <div class="mt-2 flex gap-2">
            <button
              type="button"
              data-action="agent-recipe-save"
              class="rounded-md bg-v2-background-bg-layer-03 px-2.5 py-1.5 text-xs font-medium"
              onClick={() => void saveDraft()}
            >
              Save recipe
            </button>
            <button
              type="button"
              class="rounded-md px-2.5 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02"
              onClick={() => setEditing(undefined)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </>
  )
}

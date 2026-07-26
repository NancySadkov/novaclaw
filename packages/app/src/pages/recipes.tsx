import { useNavigate } from "@solidjs/router"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/icon"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { sessionHref } from "@/utils/session-route"
import {
  duplicateRecipe,
  listRecipes,
  removeRecipe,
  runRecipe,
  saveRecipe,
  type Recipe,
} from "@/utils/recipe-api"

// The Recipes app (AGENTS.md → *Recipes are source code for the AI era*). A recipe is a folder of prompt +
// assets; this page is where a normal person reads, edits, copies and COOKS one.
//
// Cooking never mutates the recipe: the server copies its assets into a work dir and starts a session
// there. That is also why there is no "migrate" button — "Run in…" already lets you cook straight into a
// permanent folder, so moving a result somewhere real is just choosing where to run it.

const BTN =
  "rounded-md border border-v2-border-border-strong bg-v2-background-bg-layer-02 px-3 py-1.5 text-sm font-medium hover:bg-v2-background-bg-layer-03 disabled:opacity-50"
const PRIMARY =
  "rounded-md border border-v2-border-border-focus bg-v2-background-bg-layer-03 px-3 py-1.5 text-sm font-semibold hover:bg-v2-background-bg-layer-04 disabled:opacity-50"
const CARD = "rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3"
const FIELD =
  "rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2.5 py-1.5 text-sm text-v2-text-text-base outline-none focus:border-v2-border-border-focus"

export function RecipesPage() {
  const sdk = useServerSDK()
  const server = useServer()
  const navigate = useNavigate()
  const pickDirectory = useDirectoryPicker()
  const httpBase = createMemo(() => sdk()?.server?.http)
  const conn = createMemo(() => server.current)

  const [recipes, { refetch }] = createResource(
    () => httpBase(),
    async (base) => {
      try {
        return await listRecipes(base)
      } catch {
        return [] as Recipe[]
      }
    },
    { initialValue: [] as Recipe[] },
  )

  const [selected, setSelected] = createSignal<string | undefined>()
  const [draftName, setDraftName] = createSignal("")
  const [draftDescription, setDraftDescription] = createSignal("")
  const [draftPrompt, setDraftPrompt] = createSignal("")
  const [dirty, setDirty] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  /** Per-cook Strict opt-in (off = inherit Settings → Strict mode). */
  const [strictCook, setStrictCook] = createSignal(false)
  const [creating, setCreating] = createSignal(false)

  const current = createMemo(() => recipes().find((recipe) => recipe.slug === selected()))

  const open = (recipe: Recipe) => {
    setCreating(false)
    setSelected(recipe.slug)
    setDraftName(recipe.name)
    setDraftDescription(recipe.description ?? "")
    setDraftPrompt(recipe.prompt)
    setDirty(false)
  }

  const startNew = () => {
    setCreating(true)
    setSelected(undefined)
    setDraftName("")
    setDraftDescription("")
    setDraftPrompt("")
    setDirty(true)
  }

  const fail = (error: unknown) =>
    showToast({
      variant: "error",
      title: "Recipe action failed",
      description: error instanceof Error ? error.message : String(error),
    })

  async function save() {
    const base = httpBase()
    if (!base || !draftName().trim() || !draftPrompt().trim()) return
    setBusy(true)
    try {
      const saved = await saveRecipe(base, {
        // Editing keeps the slug (so the folder is updated in place); a new recipe derives it from the name.
        ...(creating() ? {} : { slug: selected() }),
        name: draftName().trim(),
        ...(draftDescription().trim() ? { description: draftDescription().trim() } : {}),
        prompt: draftPrompt(),
      })
      await refetch()
      open(saved)
      showToast({ title: `Saved “${saved.name}”` })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function copy(recipe: Recipe) {
    const base = httpBase()
    if (!base) return
    setBusy(true)
    try {
      const made = await duplicateRecipe(base, recipe.slug)
      await refetch()
      open(made)
      showToast({ title: `Copied to “${made.name}”`, description: "Edit it freely — the original is untouched." })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function remove(recipe: Recipe) {
    const base = httpBase()
    if (!base) return
    setBusy(true)
    try {
      await removeRecipe(base, recipe.slug)
      await refetch()
      if (selected() === recipe.slug) setSelected(undefined)
      showToast({
        title: `Deleted “${recipe.name}”`,
        ...(recipe.builtin ? { description: "It ships with NovaClaw, so it will return on next start." } : {}),
      })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  /** Cook it. `directory` unset = a fresh folder in the scratch workspace. */
  async function cook(recipe: Recipe, directory?: string) {
    const base = httpBase()
    if (!base) return
    setBusy(true)
    try {
      const result = await runRecipe(base, recipe.slug, {
        ...(directory ? { directory } : {}),
        // Per-cook Strict, the same switch the composer offers a chat. It has to ride the run call:
        // the cook's prompt is queued by that same request, so flipping a per-session override
        // afterwards would race the drain — before this, the ONLY way to cook a recipe under Strict
        // was to turn the instance-global setting on first.
        ...(strictCook() ? { strict: { enabled: true } } : {}),
      })
      showToast({ title: `Cooking “${recipe.name}”`, description: result.directory })
      navigate(sessionHref(server.key, result.sessionID))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const cookElsewhere = (recipe: Recipe) => {
    const c = conn()
    if (!c) return
    pickDirectory({
      server: c,
      title: `Choose a folder to cook “${recipe.name}” in`,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) void cook(recipe, directory)
      },
    })
  }

  const canSave = createMemo(() => draftName().trim().length > 0 && draftPrompt().trim().length > 0 && dirty())

  return (
    <div class="flex min-h-0 flex-1 flex-col self-stretch m-2 rounded-[10px] overflow-hidden bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] text-v2-text-text-base">
      <div class="flex items-center gap-3 border-b border-v2-border-border-base px-4 py-2.5">
        <Icon name="checklist" size="normal" class="shrink-0 text-v2-text-text-muted" />
        <span class="text-[15px] font-semibold">Recipes</span>
        <span class="min-w-0 flex-1 truncate text-xs text-v2-text-text-faint">
          Ready-made prompts an agent cooks for you. Source code rots; a good recipe stays fresh.
        </span>
        <button class={BTN} onClick={startNew}>
          New recipe
        </button>
      </div>

      <div class="flex min-h-0 flex-1 overflow-hidden">
        {/* The list */}
        <div class="w-72 shrink-0 overflow-auto border-r border-v2-border-border-base p-2">
          <Show
            when={recipes().length}
            fallback={<div class="p-2 text-sm text-v2-text-text-muted">No recipes yet — make one.</div>}
          >
            <For each={recipes()}>
              {(recipe) => (
                <button
                  class="mb-1.5 block w-full rounded-md border px-2.5 py-2 text-left transition-colors"
                  classList={{
                    "border-v2-border-border-focus bg-v2-background-bg-layer-02": selected() === recipe.slug,
                    "border-transparent hover:bg-v2-background-bg-layer-01": selected() !== recipe.slug,
                  }}
                  onClick={() => open(recipe)}
                >
                  <div class="flex items-center gap-1.5">
                    <span class="min-w-0 flex-1 truncate text-sm font-medium">{recipe.name}</span>
                    <Show when={recipe.builtin}>
                      <span class="rounded bg-v2-background-bg-layer-03 px-1.5 py-0.5 text-[10px] text-v2-text-text-faint">
                        shipped
                      </span>
                    </Show>
                  </div>
                  <Show when={recipe.description}>
                    <div class="mt-0.5 line-clamp-2 text-xs text-v2-text-text-muted">{recipe.description}</div>
                  </Show>
                  <Show when={recipe.assets.length}>
                    <div class="mt-0.5 text-[11px] text-v2-text-text-faint">{recipe.assets.length} asset(s)</div>
                  </Show>
                </button>
              )}
            </For>
          </Show>
        </div>

        {/* The detail / editor */}
        <div class="min-w-0 flex-1 overflow-auto p-4">
          <Show
            when={creating() || current()}
            fallback={
              <div class="text-sm text-v2-text-text-muted">
                Pick a recipe on the left, or make a new one. Running a recipe copies it into a work folder and
                starts a chat there — the recipe itself is never changed, so you can cook it again any time.
              </div>
            }
          >
            <div class="flex flex-col gap-3">
              <div class="flex flex-wrap items-center gap-2">
                <TextInputV2
                  type="text"
                  appearance="large"
                  class="!min-w-[240px] flex-1"
                  placeholder="Recipe name"
                  value={draftName()}
                  onInput={(event) => {
                    setDraftName(event.currentTarget.value)
                    setDirty(true)
                  }}
                />
                <Show when={current()}>
                  {(recipe) => (
                    <>
                      <button class={PRIMARY} disabled={busy()} onClick={() => void cook(recipe())}>
                        Run
                      </button>
                      <button class={BTN} disabled={busy() || !conn()} onClick={() => cookElsewhere(recipe())}>
                        Run in…
                      </button>
                      {/* Anti-obscurantist: a VISIBLE switch next to the button it changes, not a
                          hidden menu — the same Strict lever the composer gives a chat. */}
                      <button
                        class={BTN}
                        aria-pressed={strictCook()}
                        data-action="recipe-strict-toggle"
                        title="Cook under the Strict harness: the run is decomposed into small steps, each verified before the next. Slower, and it can race several attempts."
                        onClick={() => setStrictCook((on) => !on)}
                      >
                        {strictCook() ? "🛡️ Strict on" : "Strict off"}
                      </button>
                      <button class={BTN} disabled={busy()} onClick={() => void copy(recipe())}>
                        Copy
                      </button>
                      <button class={BTN} disabled={busy()} onClick={() => void remove(recipe())} title="Delete recipe">
                        <Icon name="trash" size="small" />
                      </button>
                    </>
                  )}
                </Show>
              </div>

              <input
                class={`${FIELD} w-full`}
                placeholder="One-line description (optional)"
                value={draftDescription()}
                onInput={(event) => {
                  setDraftDescription(event.currentTarget.value)
                  setDirty(true)
                }}
              />

              <textarea
                class={`${FIELD} min-h-[320px] w-full font-mono text-[13px] leading-relaxed`}
                placeholder="The prompt. This IS the recipe — describe what you want cooked, precisely enough that an agent can do it without you."
                value={draftPrompt()}
                onInput={(event) => {
                  setDraftPrompt(event.currentTarget.value)
                  setDirty(true)
                }}
              />

              <div class="flex flex-wrap items-center gap-3">
                <button class={BTN} disabled={!canSave() || busy()} onClick={() => void save()}>
                  {creating() ? "Create recipe" : "Save changes"}
                </button>
                <Show when={dirty() && !creating()}>
                  <span class="text-xs text-v2-text-text-accent">Unsaved changes</span>
                </Show>
                <Show when={current()?.builtin}>
                  <span class="text-xs text-v2-text-text-faint">
                    Shipped with NovaClaw — edit freely, your version is kept on upgrade.
                  </span>
                </Show>
              </div>

              <Show when={current()?.assets.length}>
                <div class={CARD}>
                  <div class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint">Assets</div>
                  <div class="mt-1 text-sm text-v2-text-text-muted">{current()!.assets.join(", ")}</div>
                  <div class="mt-1 text-[11px] text-v2-text-text-faint">
                    Copied into the work folder alongside the prompt when you run it.
                  </div>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

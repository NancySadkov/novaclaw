import { useNavigate } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { sessionHref } from "@/utils/session-route"
import {
  duplicateRecipe,
  importRecipe,
  importRecipeArchive,
  listRecipes,
  MAX_RECIPE_ARCHIVE_BYTES,
  recipeArchive,
  recipeSource,
  removeRecipe,
  runRecipe,
  saveRecipe,
  updateRecipe,
  verifyRecipe,
  type Recipe,
  type VerifyResult,
} from "@/utils/recipe-api"
import {
  describeDeclared,
  describeExport,
  describeNeeds,
  describeVerdict,
  exportFilename,
  filterViews,
  forgetCook,
  groupViews,
  lastCook,
  previewImport,
  rememberCook,
  REPRODUCIBILITY,
  sortViews,
  toView,
  type CookRecord,
  type RecipeView,
  type VerdictView,
} from "@/apps/recipes"
import { AppPage, AppPageHeader } from "@/components/app-page"
import { createSettledResource } from "@/utils/settled-resource"
import { createListState } from "@/utils/list-state"

// The Recipes app (AGENTS.md → *Recipes are source code for the AI era*). A recipe is a folder of prompt +
// assets; this page is where a normal person reads, runs, copies, edits, shares and CHECKS one.
//
// ⚠️ **This surface has a teaching obligation, not just a functional one** (principle 8 — teach, don't
// gatekeep). A recipe buys DURABILITY and pays in EXACT REPRODUCIBILITY, and somebody pressing Run has to
// be able to learn in one sentence why they may get a different-but-working result each time. That copy
// sits BESIDE the Run button, not behind a help link, and it names who should keep real source instead.
//
// ⚠️ **The four verdicts may never collapse.** `not-available` (the MODEL cannot do this) rendered as
// `not-working` (your install is broken) would blame a user's machine for a model limit — the distinction
// is load-bearing in `core/src/recipe-verify.ts` and it is load-bearing here. `describeVerdict` carries
// the label, the sentence and the subject; the styling below never carries meaning the words do not.
//
// ⚠️ **A recipe is untrusted content.** An imported one was written by a stranger, so its name,
// description and prompt are attacker-controlled: everything read-only goes through `authorText`/
// `authorBody` in `@/apps/recipes` first, and this file builds NO markup from any of it (pinned by
// `apps/recipes.test.ts` → "recipes.tsx never assigns innerHTML"). The EDITOR binds to the raw prompt on
// purpose — flattening a string for display and then saving it back would delete characters from the
// author's file on every round trip.
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
const LABEL = "text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint"

/**
 * Colour per verdict — and colour ONLY. Every word a reader needs is in `describeVerdict`'s `label`,
 * `meaning` and `subject`, because a red badge and an amber badge are the same badge to a colour-blind
 * reader and to anything reading the page aloud.
 */
const TONE: Record<VerdictView["tone"], string> = {
  good: "border-v2-state-border-success bg-v2-state-bg-success text-v2-state-fg-success",
  bad: "border-v2-state-border-danger bg-v2-state-bg-danger text-v2-state-fg-danger",
  unsure: "border-v2-state-border-warning bg-v2-state-bg-warning text-v2-state-fg-warning",
  // ⚠️ NOT a danger colour. "The model cannot do this" is not a fault in the user's install, and a red
  // badge would say it was regardless of the sentence beside it.
  neutral: "border-v2-border-border-strong bg-v2-background-bg-layer-03 text-v2-text-text-muted",
}

const OUTCOME_WORD: Record<string, string> = {
  met: "found",
  unmet: "not found",
  unknown: "not checked",
}

export function RecipesPage() {
  const language = useLanguage()
  const sdk = useServerSDK()
  const server = useServer()
  const navigate = useNavigate()
  const pickDirectory = useDirectoryPicker()
  const httpBase = createMemo(() => sdk()?.server?.http)
  const conn = createMemo(() => server.current)
  const archiveTransfers = new AbortController()
  onCleanup(() => archiveTransfers.abort())

  /**
   * ⚠️ A failed listing used to become `[]`, and `[]` reads as *"No recipes yet — make one, or import
   * one."* The bundled recipes are this install's health check, so telling someone they have none is
   * telling them the install is bare when what actually happened is that the page could not ask.
   *
   * `initialValue: []` was not the guard it looked like: it sets Solid's `resolved` flag before
   * anything is requested, so the page claimed an empty shelf on a cold client too.
   */
  const [recipeRows, { refetch }] = createSettledResource(
    () => httpBase(),
    (base) => listRecipes(base),
  )
  const recipes = (): Recipe[] => recipeRows() ?? []
  const recipeListing = createListState<Recipe>(recipeRows)

  const [selected, setSelected] = createSignal<string | undefined>()
  const [query, setQuery] = createSignal("")
  const [draftName, setDraftName] = createSignal("")
  const [draftDescription, setDraftDescription] = createSignal("")
  const [draftPrompt, setDraftPrompt] = createSignal("")
  const [dirty, setDirty] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  /** Per-cook Strict opt-in (off = inherit Settings → Strict mode). */
  const [strictCook, setStrictCook] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [importing, setImporting] = createSignal(false)
  const [importText, setImportText] = createSignal("")
  const [importFile, setImportFile] = createSignal<File | undefined>()
  const [receipt, setReceipt] = createSignal<VerifyResult | undefined>()
  const [checking, setChecking] = createSignal(false)
  const [producesDraft, setProducesDraft] = createSignal("")
  const [producesDirty, setProducesDirty] = createSignal(false)

  const views = createMemo(() => sortViews(recipes().map(toView)))
  const shown = createMemo(() => filterViews(views(), query()))
  const groups = createMemo(() => groupViews(shown()))
  const current = createMemo(() => views().find((view) => view.key === selected()))

  /**
   * The author's own file, plus what it needs and produces. A SEPARATE read from the list on purpose: the
   * list record carries the prompt BODY only, so `needs:` / `produces:` and the editable markdown live
   * nowhere else. A failure here stays `undefined`, which every describe* function below reports as
   * *"I could not read this recipe's file"* rather than as *"it declares nothing"*.
   */
  const [source] = createResource(
    () => {
      const base = httpBase()
      const slug = current()?.key
      return base && slug ? ([base, slug] as const) : undefined
    },
    async ([base, slug]) => {
      try {
        return await recipeSource(base, slug)
      } catch {
        return undefined
      }
    },
  )

  const needs = createMemo(() => describeNeeds(source()))
  const declared = createMemo(() => describeDeclared(source()))
  const verdict = createMemo(() => {
    const result = receipt()
    return result ? describeVerdict(result) : undefined
  })
  /** The last cook of the SELECTED recipe, recomputed when the selection changes (see `rememberCook`). */
  const cooked = createMemo(() => {
    const key = current()?.key
    return key ? lastCook(key) : undefined
  })

  /**
   * ⚠️ **This is the "on settle" wiring.** Until now nothing ever called `verify`: the receipt existed and
   * was purely on demand, so the health check AGENTS.md promises *in one click* took a click nobody knew
   * to make. Pressing Run navigates to the cook's chat, so the moment this app can act on is the user
   * coming BACK to a recipe that cooked in this session — and at that moment the answer is free.
   *
   * Safe to fire without asking: `verify` runs nothing, writes nothing, and is a pure function of the
   * folder, so the worst case is one stat per declared file. It fires once per selection (`receipt()`
   * being set is the latch) and never overwrites a receipt the user asked for explicitly.
   */
  createEffect(() => {
    const recipe = current()
    const last = cooked()
    if (!recipe || !last || receipt() !== undefined || checking()) return
    void check(recipe, last.directory, last)
  })

  const open = (recipe: RecipeView) => {
    setCreating(false)
    setImporting(false)
    setSelected(recipe.key)
    setDraftName(recipe.rawName)
    setDraftDescription(recipe.description)
    // ⚠️ The RAW prompt, never the flattened one — see the header.
    setDraftPrompt(recipe.rawPrompt)
    setDirty(false)
    setProducesDirty(false)
    setReceipt(undefined)
    setChecking(false)
  }

  const startNew = () => {
    setCreating(true)
    setImporting(false)
    setSelected(undefined)
    setDraftName("")
    setDraftDescription("")
    setDraftPrompt("")
    setDirty(true)
  }

  const startImport = () => {
    setImportFile(undefined)
    setImportText("")
    setImporting(true)
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
      open(toView(saved))
      showToast({ title: `Saved “${saved.name}”` })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Change ONLY the `produces:` line — `Recipe.update`, the partial verb.
   *
   * ⚠️ Not `save`. A save takes the whole recipe, so adding one line would mean resending the prompt from
   * a textarea, and a caller that retypes prose it did not author is the lossy rewrite `Recipe.edit`
   * exists to prevent. This route edits that one line inside the author's own bytes and leaves every other
   * byte — their key order, their line endings, a BOM, unknown keys — exactly as it found them.
   */
  async function saveProduces() {
    const base = httpBase()
    const slug = current()?.key
    if (!base || !slug) return
    setBusy(true)
    try {
      const files = producesDraft()
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
      await updateRecipe(base, slug, { produces: files })
      await refetch()
      setProducesDirty(false)
      showToast({
        title: files.length ? "NovaClaw will check those files from now on" : "Cleared — nothing will be checked",
      })
      setSelected(undefined)
      setSelected(slug)
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function copy(recipe: RecipeView) {
    const base = httpBase()
    if (!base) return
    setBusy(true)
    try {
      const made = await duplicateRecipe(base, recipe.key)
      await refetch()
      open(toView(made))
      showToast({ title: `Copied to “${made.name}”`, description: "Edit it freely — the original is untouched." })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function remove(recipe: RecipeView) {
    const base = httpBase()
    if (!base) return
    setBusy(true)
    try {
      await removeRecipe(base, recipe.key)
      forgetCook(recipe.key)
      await refetch()
      if (selected() === recipe.key) setSelected(undefined)
      showToast({
        title: `Deleted “${recipe.name}”`,
        ...(recipe.shipped ? { description: "It ships with NovaClaw, so it will return on next start." } : {}),
      })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  /** Download the complete folder, not a reconstruction and not only its markdown. */
  async function exportRecipe(recipe: RecipeView) {
    const base = httpBase()
    if (!base) return
    setBusy(true)
    try {
      const archive = await recipeArchive(base, recipe.key, { signal: archiveTransfers.signal })
      const url = URL.createObjectURL(new Blob([archive], { type: "application/zip" }))
      const link = document.createElement("a")
      link.href = url
      link.download = exportFilename(recipe.key)
      link.click()
      URL.revokeObjectURL(url)
      showToast({ title: `Saved ${exportFilename(recipe.key)}`, description: describeExport(recipe) })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function doMarkdownImport() {
    const base = httpBase()
    const preview = previewImport(importText())
    if (!base || !preview.ok) return
    setBusy(true)
    try {
      const made = await importRecipe(base, { markdown: importText() })
      await refetch()
      setImportText("")
      setImporting(false)
      open(toView(made))
      showToast({
        title: `Imported “${made.name}”`,
        description: "Stored exactly as it was written. Pasted markdown carries no assets; read it before you run it.",
      })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function doArchiveImport() {
    const base = httpBase()
    const file = importFile()
    if (!base || !file) return
    if (file.size > MAX_RECIPE_ARCHIVE_BYTES) {
      fail(new Error(`That recipe ZIP is over ${MAX_RECIPE_ARCHIVE_BYTES / 1024 / 1024} MB`))
      return
    }
    setBusy(true)
    try {
      const made = await importRecipeArchive(base, new Uint8Array(await file.arrayBuffer()), {
        signal: archiveTransfers.signal,
      })
      await refetch()
      setImportFile(undefined)
      setImportText("")
      setImporting(false)
      open(toView(made))
      showToast({
        title: `Imported “${made.name}”`,
        description: "The complete folder arrived — recipe.md and all nested assets. Read it before you run it.",
      })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  /** Cook it. `directory` unset = a fresh folder in the scratch workspace. */
  async function cook(recipe: RecipeView, directory?: string) {
    const base = httpBase()
    if (!base) return
    setBusy(true)
    try {
      const result = await runRecipe(base, recipe.key, {
        ...(directory ? { directory } : {}),
        // Per-cook Strict, the same switch the composer offers a chat. It has to ride the run call:
        // the cook's prompt is queued by that same request, so flipping a per-session override
        // afterwards would race the drain — before this, the ONLY way to cook a recipe under Strict
        // was to turn the instance-global setting on first.
        ...(strictCook() ? { strict: { enabled: true } } : {}),
      })
      // Remember WHERE, so coming back to this app can offer the receipt instead of asking the user to
      // remember a path. Nothing else records it: a cook is not a property of a recipe.
      // ⚠️ `model` rides along, and it is load-bearing rather than informational: `verify` cannot reach
      // its NOT AVAILABLE arm without it, so a cook on a model that cannot call tools used to be
      // reported as a broken install. `recipe.run` answers with the model it actually resolved, which is
      // the only way this app can know — it names none when it starts a cook.
      rememberCook({
        slug: recipe.key,
        directory: result.directory,
        sessionID: result.sessionID,
        at: Date.now(),
        ...(result.model ? { model: result.model } : {}),
      })
      showToast({
        title: `Cooking “${recipe.name}”`,
        description: result.produces.length
          ? `${result.directory} — when it finishes, come back here and I will check for ${result.produces.join(", ")}.`
          : `${result.directory} — this recipe names no files, so I will not be able to tell you whether it worked.`,
      })
      navigate(sessionHref(server.key, result.sessionID))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const cookElsewhere = (recipe: RecipeView) => {
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

  /**
   * The receipt: read the work folder and answer from the FILESYSTEM, so the verdict does not depend on
   * what the model said about its own work. Read-only, runs nothing, and idempotent — pressing it twice
   * costs nothing and can never be the thing that broke the cook.
   */
  /**
   * ⚠️ `cook` is what makes the receipt honest, and passing it is not optional for a cook this app
   * started. Two facts the filesystem cannot hold ride on it:
   *
   *  - **`sessionID`** — whether the cook ever reached the model. A cook that died on a transport
   *    fault wrote nothing and proved nothing, and without this the app reported an empty folder as
   *    *"Did not work · this NovaClaw"*, blaming the user's install for a dead endpoint.
   *  - **`model`** — which model cooked, so a model that cannot call tools yields NOT AVAILABLE. That
   *    arm was structurally unreachable from this app before, for want of exactly this value.
   *
   * "Check another folder…" legitimately has neither: nobody knows which cook made that folder, so it
   * asks about the files alone and any gap reads as `not-measured`, never as a fault.
   */
  async function check(recipe: RecipeView, directory: string, cook?: CookRecord) {
    const base = httpBase()
    if (!base) return
    setChecking(true)
    try {
      setReceipt(
        await verifyRecipe(base, recipe.key, {
          directory,
          ...(cook?.model ? { model: cook.model } : {}),
          ...(cook?.sessionID ? { sessionID: cook.sessionID } : {}),
        }),
      )
    } catch (error) {
      fail(error)
    } finally {
      setChecking(false)
    }
  }

  const checkElsewhere = (recipe: RecipeView) => {
    const c = conn()
    if (!c) return
    pickDirectory({
      server: c,
      title: `Which folder did “${recipe.name}” run in?`,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) void check(recipe, directory)
      },
    })
  }

  const canSave = createMemo(() => draftName().trim().length > 0 && draftPrompt().trim().length > 0 && dirty())
  const preview = createMemo(() => previewImport(importText()))

  return (
    <AppPage class="flex flex-col overflow-hidden">
      <AppPageHeader
        glyph="recipes"
        title="Recipes"
        hint="Ready-made prompts an agent cooks for you. Source code rots; a good recipe stays fresh."
      >
        <button class={BTN} data-action="recipe-import-open" onClick={startImport}>
          {language.t("recipes.page.import")}
        </button>
        <button class={BTN} data-action="recipe-new" onClick={startNew}>
          {language.t("recipes.page.newRecipe")}
        </button>
      </AppPageHeader>

      <div class="flex min-h-0 flex-1 overflow-hidden">
        {/* ── The list, on its shelves ─────────────────────────────────────────────────────────── */}
        <div class="flex w-72 shrink-0 flex-col border-r border-v2-border-border-base">
          <div class="p-2">
            <TextInputV2
              type="text"
              class="w-full"
              placeholder={language.t("recipes.page.searchRecipes")}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <div class="min-h-0 flex-1 overflow-auto px-2 pb-2">
            <Switch>
              <Match when={recipeListing().kind === "failed"}>
                <div class="p-2 text-sm text-v2-state-fg-danger" data-slot="recipes-failed">
                  {language.t("recipes.page.couldNotReadYourRecipesYour")}
                </div>
              </Match>
              <Match when={recipeListing().kind === "idle" || recipeListing().kind === "loading"}>
                <div class="p-2 text-sm text-v2-text-text-muted">{language.t("recipes.page.loadingYourRecipes")}</div>
              </Match>
              <Match when={groups().length === 0}>
                {/* Two empties, and only one of them is a recipe count: nothing installed, versus
                    nothing matching the search. Neither may stand in for a failed read above. */}
                <div class="p-2 text-sm text-v2-text-text-muted" data-slot="recipes-empty">
                  {recipes().length === 0 ? "No recipes yet — make one, or import one." : "Nothing matches that."}
                </div>
              </Match>
              <Match when={groups().length}>
                <For each={groups()}>
                  {(group) => (
                    <div class="mb-3">
                      {/* A shelf, not a profile: a title and a line about what lives here, no settings.
                          Membership is decided by the build — a recipe cannot declare its own shelf. */}
                      <div class={LABEL} data-slot="recipe-shelf">
                        {group.collection.title}
                      </div>
                      <div class="mt-0.5 mb-1.5 text-[11px] text-v2-text-text-faint">{group.collection.note}</div>
                      <For each={group.recipes}>
                        {(recipe) => (
                          <button
                            class="mb-1.5 block w-full rounded-md border px-2.5 py-2 text-left transition-colors"
                            classList={{
                              "border-v2-border-border-focus bg-v2-background-bg-layer-02": selected() === recipe.key,
                              "border-transparent hover:bg-v2-background-bg-layer-01": selected() !== recipe.key,
                            }}
                            data-slot="recipe-row"
                            onClick={() => open(recipe)}
                          >
                            <div class="flex items-center gap-1.5">
                              <span class="min-w-0 flex-1 truncate text-sm font-medium">{recipe.name}</span>
                              <Show when={recipe.assets.length}>
                                <span class="shrink-0 rounded bg-v2-background-bg-layer-03 px-1.5 py-0.5 text-[10px] text-v2-text-text-faint">
                                  {recipe.assets.length} file{recipe.assets.length === 1 ? "" : "s"}
                                </span>
                              </Show>
                            </div>
                            <Show when={recipe.hasDescription}>
                              <div class="mt-0.5 line-clamp-2 text-xs text-v2-text-text-muted">
                                {recipe.description}
                              </div>
                            </Show>
                          </button>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </Match>
            </Switch>
          </div>
        </div>

        {/* ── The detail ───────────────────────────────────────────────────────────────────────── */}
        <div class="min-w-0 flex-1 overflow-auto p-4">
          <Show when={importing()}>
            <div class="max-w-2xl">
              <ImportPanel
                file={importFile()}
                onFile={setImportFile}
                text={importText()}
                onText={setImportText}
                preview={preview()}
                busy={busy()}
                onCancel={() => {
                  setImportFile(undefined)
                  setImportText("")
                  setImporting(false)
                }}
                onArchiveImport={() => void doArchiveImport()}
                onMarkdownImport={() => void doMarkdownImport()}
              />
            </div>
          </Show>

          <Show when={!importing()}>
            <Show
              when={creating() || current()}
              fallback={
                <div class="max-w-2xl text-sm text-v2-text-text-muted" data-slot="recipes-intro">
                  <p>{language.t("recipes.page.pickARecipeOnTheLeft")}</p>
                  <p class="mt-2">{REPRODUCIBILITY.headline}</p>
                  <p class="mt-2">{REPRODUCIBILITY.gain}</p>
                  <p class="mt-2">{REPRODUCIBILITY.reassurance}</p>
                </div>
              }
            >
              <div class="flex max-w-3xl flex-col gap-3">
                <div class="flex flex-wrap items-center gap-2">
                  <TextInputV2
                    type="text"
                    appearance="large"
                    class="!min-w-[240px] flex-1"
                    placeholder={language.t("recipes.page.recipeName")}
                    value={draftName()}
                    onInput={(event) => {
                      setDraftName(event.currentTarget.value)
                      setDirty(true)
                    }}
                  />
                  <Show when={current()}>
                    {(recipe) => (
                      <>
                        <button
                          class={PRIMARY}
                          data-action="recipe-run"
                          disabled={busy()}
                          onClick={() => void cook(recipe())}
                        >
                          {language.t("recipes.page.run")}
                        </button>
                        <button class={BTN} disabled={busy() || !conn()} onClick={() => cookElsewhere(recipe())}>
                          {language.t("recipes.page.runIn")}
                        </button>
                        {/* Anti-obscurantist: a VISIBLE switch next to the button it changes, not a
                            hidden menu — the same Strict lever the composer gives a chat. */}
                        <button
                          class={BTN}
                          aria-pressed={strictCook()}
                          data-action="recipe-strict-toggle"
                          title={language.t("recipes.page.cookUnderTheStrictHarnessThe")}
                          onClick={() => setStrictCook((on) => !on)}
                        >
                          {strictCook() ? "🛡️ Strict on" : "Strict off"}
                        </button>
                        <button class={BTN} disabled={busy()} onClick={() => void copy(recipe())}>
                          {language.t("recipes.page.copy")}
                        </button>
                        <button
                          class={BTN}
                          data-action="recipe-export"
                          disabled={busy() || !httpBase()}
                          title={describeExport(recipe())}
                          onClick={() => void exportRecipe(recipe())}
                        >
                          {language.t("recipes.page.export")}
                        </button>
                        <button
                          class={BTN}
                          disabled={busy()}
                          onClick={() => void remove(recipe())}
                          title={language.t("recipes.page.deleteRecipe")}
                        >
                          <Icon name="trash" size="normal" />
                        </button>
                      </>
                    )}
                  </Show>
                </div>

                {/* ── 1. The trade, beside the button it is about. ─────────────────────────────── */}
                <section
                  class="rounded-lg border border-v2-border-border-focus bg-v2-background-bg-layer-02 p-3"
                  data-slot="recipe-reproducibility"
                >
                  <h2 class="text-xs font-semibold tracking-wide text-v2-text-text-accent uppercase">
                    {language.t("recipes.page.whatRunningThisActuallyDoes")}
                  </h2>
                  <p class="mt-1.5 text-sm text-v2-text-text-base">{REPRODUCIBILITY.headline}</p>
                  <p class="mt-1.5 text-sm text-v2-text-text-base">{REPRODUCIBILITY.gain}</p>
                  <p class="mt-1.5 text-sm text-v2-text-text-muted" data-slot="recipe-reproducibility-price">
                    {REPRODUCIBILITY.price}
                  </p>
                  <p class="mt-1.5 text-xs text-v2-text-text-faint">{REPRODUCIBILITY.reassurance}</p>
                </section>

                {/* ── 2. Before you run: what this machine has. OUR observation. ───────────────── */}
                <Show when={current()}>
                  <section class={CARD} data-slot="recipe-needs">
                    <h2 class={LABEL}>{language.t("recipes.page.beforeYouRun")}</h2>
                    <p
                      class="mt-1.5 text-sm"
                      classList={{
                        "text-v2-state-fg-danger": needs().blocksRun,
                        "text-v2-text-text-base": !needs().blocksRun,
                      }}
                      data-slot="recipe-needs-sentence"
                    >
                      {needs().sentence}
                    </p>
                    <Show when={needs().looked.length}>
                      <p class="mt-1 text-[11px] break-all text-v2-text-text-faint">
                        {`I looked for: ${needs().looked.join(", ")}. If it is installed somewhere I did not look, delete this recipe's “needs:” line and run it anyway — the recipe is yours.`}
                      </p>
                    </Show>
                  </section>
                </Show>

                {/* ── 3. What a finished run should leave behind, and how to say so. ───────────── */}
                <Show when={current()}>
                  {(_recipe) => (
                    <section class={CARD} data-slot="recipe-produces">
                      <h2 class={LABEL}>{language.t("recipes.page.whatAFinishedRunShouldLeave")}</h2>
                      <p class="mt-1.5 text-sm text-v2-text-text-base" data-slot="recipe-produces-sentence">
                        {declared().sentence}
                      </p>
                      <Show when={declared().advice}>
                        <p class="mt-1 text-xs text-v2-text-text-muted">{declared().advice}</p>
                      </Show>
                      <Show when={declared().state !== "unreadable"}>
                        <div class="mt-2 flex flex-wrap items-center gap-2">
                          <input
                            class={`${FIELD} min-w-[260px] flex-1 font-mono text-[12px]`}
                            placeholder={language.t("recipes.page.reportMdChartHtml")}
                            data-slot="recipe-produces-input"
                            value={producesDirty() ? producesDraft() : declared().files.join(", ")}
                            onInput={(event) => {
                              setProducesDraft(event.currentTarget.value)
                              setProducesDirty(true)
                            }}
                          />
                          <button
                            class={BTN}
                            data-action="recipe-produces-save"
                            disabled={busy() || !producesDirty()}
                            onClick={() => void saveProduces()}
                          >
                            {language.t("recipes.page.saveFileNames")}
                          </button>
                        </div>
                        <p class="mt-1 text-[11px] text-v2-text-text-faint">
                          {language.t("recipes.page.justFileNamesSeparatedByCommas")}
                        </p>
                      </Show>
                    </section>
                  )}
                </Show>

                {/* ── 4. The receipt. Four verdicts, kept apart. ───────────────────────────────── */}
                <Show when={current()}>
                  {(recipe) => (
                    <section class={CARD} data-slot="recipe-receipt">
                      <div class="flex flex-wrap items-center gap-2">
                        <h2 class={`${LABEL} flex-1`}>{language.t("recipes.page.didItWork")}</h2>
                        <Show when={cooked()}>
                          {(last) => (
                            <button
                              class={BTN}
                              data-action="recipe-check"
                              disabled={checking()}
                              onClick={() => void check(recipe(), last().directory)}
                            >
                              {checking() ? "Checking…" : "Check the last run again"}
                            </button>
                          )}
                        </Show>
                        <button
                          class={BTN}
                          data-action="recipe-check-elsewhere"
                          disabled={checking() || !conn()}
                          onClick={() => checkElsewhere(recipe())}
                        >
                          {language.t("recipes.page.checkAFolder")}
                        </button>
                      </div>

                      <Show
                        when={verdict()}
                        fallback={
                          <p class="mt-1.5 text-sm text-v2-text-text-muted" data-slot="recipe-receipt-none">
                            {cooked()
                              ? "This ran in this session — checking the work folder now."
                              : "Run it, then come back here. NovaClaw looks in the work folder itself and tells you what it found — it does not take the model's word for it."}
                          </p>
                        }
                      >
                        {(view) => (
                          <div class="mt-2">
                            <div class="flex flex-wrap items-center gap-2">
                              <span
                                class={`rounded border px-2 py-0.5 text-xs font-semibold ${TONE[view().tone]}`}
                                data-slot="recipe-verdict-label"
                              >
                                {view().label}
                              </span>
                              <span class="text-xs text-v2-text-text-faint" data-slot="recipe-verdict-subject">
                                {`about: ${view().subject}`}
                              </span>
                            </div>
                            <p class="mt-1.5 text-sm text-v2-text-text-base" data-slot="recipe-verdict-meaning">
                              {view().meaning}
                            </p>
                            <p class="mt-1 text-sm text-v2-text-text-muted" data-slot="recipe-verdict-advice">
                              {view().advice}
                            </p>
                            <Show when={view().rows.length}>
                              <ul class="mt-2 flex flex-col gap-1" data-slot="recipe-verdict-rows">
                                <For each={view().rows}>
                                  {(row) => (
                                    <li class="text-xs text-v2-text-text-muted">
                                      {/* The separator is real TEXT, not margin: read aloud or copied, a
                                          bare margin makes this "pi.txtnot found". */}
                                      <span class="font-mono text-v2-text-text-base">{row.path || row.declared}</span>
                                      <span>{" — "}</span>
                                      <span>{OUTCOME_WORD[row.outcome] ?? row.outcome}</span>
                                      <span>{": "}</span>
                                      <span>{row.checked}</span>
                                      <Show when={row.size}>
                                        <span>{` (${row.size})`}</span>
                                      </Show>
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </Show>
                            <p class="mt-2 text-[11px] break-all text-v2-text-text-faint">
                              {`Checked ${view().directory}`}
                            </p>
                            <p class="mt-1 text-[11px] text-v2-text-text-faint" data-slot="recipe-verdict-summary">
                              {view().summary}
                            </p>
                          </div>
                        )}
                      </Show>
                    </section>
                  )}
                </Show>

                {/* ── 5. The recipe itself — the author's words, and the editor. ───────────────── */}
                <div class="flex flex-col gap-2">
                  <h2 class={LABEL}>{language.t("recipes.page.theRecipe")}</h2>
                  <Show when={current()?.shipped}>
                    <p class="text-xs text-v2-text-text-faint">
                      {language.t("recipes.page.thisOneShippedWithNovaclawEdit")}
                    </p>
                  </Show>
                  <Show when={current() && !current()!.shipped}>
                    <p class="text-xs text-v2-text-text-faint" data-slot="recipe-authorship">
                      {language.t("recipes.page.theTextBelowIsWhoeverWrote")}
                    </p>
                  </Show>
                  {/* ⚠️ The boxes below hold the RAW text, because whatever is in them is what Save writes
                      back — flattening here would delete characters from the file on every round trip. So
                      the surface says out loud that the text is not what it looks like. */}
                  <Show when={current()?.hiddenCharacters}>
                    <p class="text-xs text-v2-state-fg-warning" data-slot="recipe-hidden-characters">
                      {language.t("recipes.page.carefulThisRecipeSOwnText")}
                    </p>
                  </Show>
                  <input
                    class={`${FIELD} w-full`}
                    placeholder={language.t("recipes.page.oneLineDescriptionOptional")}
                    value={draftDescription()}
                    onInput={(event) => {
                      setDraftDescription(event.currentTarget.value)
                      setDirty(true)
                    }}
                  />
                  <textarea
                    class={`${FIELD} min-h-[320px] w-full font-mono text-[13px] leading-relaxed`}
                    placeholder={language.t("recipes.page.thePromptThisIsTheRecipe")}
                    data-slot="recipe-prompt"
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
                      <span class="text-xs text-v2-text-text-accent">{language.t("recipes.page.unsavedChanges")}</span>
                    </Show>
                  </div>
                </div>

                <Show when={current()?.assets.length}>
                  <div class={CARD}>
                    <div class={LABEL}>{language.t("recipes.page.filesThatTravelWithIt")}</div>
                    <div class="mt-1 text-sm break-all text-v2-text-text-muted">{current()!.assets.join(", ")}</div>
                    <div class="mt-1 text-[11px] text-v2-text-text-faint">
                      {language.t("recipes.page.copiedIntoTheWorkFolderAlongside")}
                    </div>
                  </div>
                </Show>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </AppPage>
  )
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Import a complete folder ZIP, or paste an explicitly asset-free `recipe.md` convenience.
 *
 * ⚠️ Everything shown here is a stranger's text, labelled as such. The parse is a PREVIEW, not the
 * authority: the server reads the file again and stores the BYTES, so a disagreement between the two can
 * only ever mislabel this panel — it can never write something other than what was pasted.
 */
function ImportPanel(props: {
  file: File | undefined
  onFile: (value: File | undefined) => void
  text: string
  onText: (value: string) => void
  preview: ReturnType<typeof previewImport>
  busy: boolean
  onCancel: () => void
  onArchiveImport: () => void
  onMarkdownImport: () => void
}) {
  const language = useLanguage()
  return (
    <div class="flex flex-col gap-3" data-component="recipe-import">
      <div>
        <h1 class="text-lg font-semibold">{language.t("recipes.page.importARecipe")}</h1>
        <p class="mt-1 text-sm text-v2-text-text-muted">{language.t("recipes.page.aRecipeIsAFolderChoose")}</p>
      </div>

      <section class={CARD} data-slot="recipe-import-archive">
        <h2 class={LABEL}>{language.t("recipes.page.completeRecipeFolder")}</h2>
        <input
          class="mt-2 block w-full text-sm text-v2-text-text-muted"
          type="file"
          accept=".zip,application/zip"
          data-action="recipe-import-archive-file"
          onChange={(event) => props.onFile(event.currentTarget.files?.[0])}
        />
        <p class="mt-1 text-xs text-v2-text-text-faint">
          Up to {MAX_RECIPE_ARCHIVE_BYTES / 1024 / 1024} MB compressed. NovaClaw checks paths, file count, expanded size
          and checksums before the folder appears.
        </p>
        <button
          class={`${PRIMARY} mt-3`}
          data-action="recipe-import-archive-confirm"
          disabled={props.busy || !props.file}
          onClick={() => props.onArchiveImport()}
        >
          {language.t("recipes.page.importFolder")}
        </button>
      </section>

      <div>
        <h2 class={LABEL}>{language.t("recipes.page.pasteRecipeMdOnly")}</h2>
        <p class="mt-1 text-sm text-v2-text-text-muted" data-slot="recipe-import-markdown-limit">
          {language.t("recipes.page.useThisForAProseOnly")}
        </p>
      </div>

      <textarea
        class={`${FIELD} min-h-[220px] w-full font-mono text-[12px] leading-relaxed`}
        placeholder={"---\nname: Their recipe\nproduces: report.md\n---\n\nWhat they want cooked…"}
        data-slot="recipe-import-text"
        value={props.text}
        onInput={(event) => props.onText(event.currentTarget.value)}
      />

      <Show when={props.text.trim() !== ""}>
        <section class={CARD} data-slot="recipe-import-preview">
          <h2 class={LABEL}>{language.t("recipes.page.whatThisFileSays")}</h2>
          <Show
            when={props.preview.ok}
            fallback={
              <p class="mt-1.5 text-sm text-v2-state-fg-danger" data-slot="recipe-import-problem">
                {props.preview.problem}
              </p>
            }
          >
            <p class="mt-1.5 text-sm text-v2-text-text-base">
              <span class="text-v2-text-text-faint">{"It calls itself: "}</span>
              {props.preview.name || "(no name — it will be filed as “imported-recipe”)"}
            </p>
            <Show when={props.preview.description}>
              <p class="mt-1 text-sm text-v2-text-text-muted">
                <span class="text-v2-text-text-faint">{"Its own description: "}</span>
                {props.preview.description}
              </p>
            </Show>
            <Show when={props.preview.needs.length}>
              <p class="mt-1 text-sm text-v2-text-text-muted">
                {`It says it needs: ${props.preview.needs.join(", ")}. NovaClaw checks that itself before it runs.`}
              </p>
            </Show>
            <Show when={props.preview.produces.length}>
              <p class="mt-1 text-sm text-v2-text-text-muted">
                {`It says a finished run leaves: ${props.preview.produces.join(", ")}.`}
              </p>
            </Show>
            <Show when={props.preview.unmodelled.length}>
              <p class="mt-1 text-xs text-v2-text-text-faint" data-slot="recipe-import-unmodelled">
                {`It also carries lines NovaClaw does not use: ${props.preview.unmodelled.join(" · ")}. They are kept in the file exactly as written.`}
              </p>
            </Show>
            <p class="mt-2 text-[11px] text-v2-text-text-faint">
              {language.t("recipes.page.somebodyElseWroteThisNothingIn")}
            </p>
            <pre class="mt-1.5 max-h-[240px] overflow-auto rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-02 p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-v2-text-text-muted">
              {props.preview.body}
            </pre>
          </Show>
        </section>
      </Show>

      <div class="flex flex-wrap items-center gap-3">
        <button
          class={PRIMARY}
          data-action="recipe-import-markdown-confirm"
          disabled={props.busy || !props.preview.ok || props.text.trim() === ""}
          onClick={() => props.onMarkdownImport()}
        >
          {language.t("recipes.page.importPastedMarkdownNoAssets")}
        </button>
        <button class={BTN} onClick={() => props.onCancel()}>
          {language.t("recipes.page.cancel")}
        </button>
        <span class="text-xs text-v2-text-text-faint">
          {language.t("recipes.page.importingNeverReplacesARecipeYou")}
        </span>
      </div>
    </div>
  )
}

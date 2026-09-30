import { useBeforeLeave } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { decodeRecipeOfficers, type RecipeOfficer } from "@novaclaw/schema/recipe-officer"
import { AppPage } from "./app-page"
import { RecipeOfficersEditor } from "./recipe-officers"
import type { ConfirmOptions } from "./dialog-confirm"
import { createSettledResource } from "@/utils/settled-resource"
import { recipeFileBytes, recipeFileImage, type RecipeStudioApi } from "@/utils/recipe-studio"
import {
  MAX_RECIPE_ARCHIVE_BYTES,
  type Recipe,
  type RecipeAsset,
  type RecipeAssetContent,
  type RecipeArchivePreview,
} from "@/utils/recipe-api"
import { exportFilename } from "@/apps/recipes"

type Check = <T>(operation: T | PromiseLike<T>) => Promise<T>

type Draft = {
  slug?: string
  name: string
  description: string
  prompt: string
  officers: readonly RecipeOfficer[]
  needs: string
  produces: string
}
const lines = (value: string) =>
  value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
const blank = (): Draft => ({ name: "", description: "", prompt: "", officers: [], needs: "", produces: "" })
const download = (bytes: Uint8Array<ArrayBuffer>, name: string) => {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function RecipeStudio(props: {
  api?: RecipeStudioApi
  confirm: (options: ConfirmOptions) => Promise<boolean>
  selectedSlug?: string
  onDeployed: (id: string) => void
}) {
  const [rows, { refetch }] = createSettledResource(
    () => props.api,
    (api) => api.list(),
  )
  const [query, setQuery] = createSignal("")
  const [draft, setDraft] = createSignal<Draft>()
  const [dirty, setDirty] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [saved, setSaved] = createSignal(false)
  const [assets, setAssets] = createSignal<readonly RecipeAsset[]>([])
  const [pending, setPending] = createSignal<Record<string, RecipeAssetContent>>({})
  const [removed, setRemoved] = createSignal<string[]>([])
  const [asset, setAsset] = createSignal<RecipeAssetContent>()
  const [imageURL, setImageURL] = createSignal<string>()
  const [packagePreview, setPackagePreview] = createSignal<{
    name: string
    bytes: Uint8Array<ArrayBuffer>
    recipe: RecipeArchivePreview
    imported?: Recipe
  }>()
  const [deploying, setDeploying] = createSignal(false)
  const [deployDirectory, setDeployDirectory] = createSignal("")
  let importInput: HTMLInputElement | undefined
  let deployDialog: HTMLDialogElement | undefined
  const closeDeployment = () => {
    deployDialog?.close()
    setDeploying(false)
  }
  let loadGeneration = 0
  let connectionGeneration = 0
  const visible = createMemo(() =>
    (rows() ?? []).filter((recipe) =>
      `${recipe.name} ${recipe.description ?? ""}`.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase()),
    ),
  )
  const files = createMemo(() => {
    const result = new Map(
      assets()
        .filter((entry) => !removed().includes(entry.path))
        .map((entry) => [entry.path, entry]),
    )
    for (const entry of Object.values(pending()))
      result.set(entry.path, { path: entry.path, bytes: recipeFileBytes(entry).length })
    return [...result.values()].sort((a, b) => a.path.localeCompare(b.path))
  })
  const fail = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    setError(message.replaceAll("recipe.json", "recipe package"))
  }
  const change = (patch: Partial<Draft>) => {
    setDraft((value) => value && { ...value, ...patch })
    setDirty(true)
    setSaved(false)
  }
  const leave = async () =>
    !busy() &&
    (!dirty() ||
      (await props.confirm({
        title: "Discard recipe changes?",
        description: "Your latest edits have not been saved.",
        confirmLabel: "Discard changes",
        destructive: true,
      })))
  useBeforeLeave((event) => {
    if (!dirty() && !busy()) return
    event.preventDefault()
    if (!busy())
      void leave().then((allowed) => {
        if (allowed) event.retry(true)
      })
  })
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (dirty() || busy()) {
      event.preventDefault()
      event.returnValue = ""
    }
  }
  window.addEventListener("beforeunload", beforeUnload)
  onCleanup(() => {
    loadGeneration++
    connectionGeneration++
    window.removeEventListener("beforeunload", beforeUnload)
    deployDialog?.close()
  })
  const reset = () => {
    setError(undefined)
    setSaved(false)
    setDirty(false)
    setAsset(undefined)
    setAssets([])
    setPending({})
    setRemoved([])
    setPackagePreview(undefined)
    setDeploying(false)
    setDeployDirectory("")
  }
  const loadedDraft = (recipe: Recipe, loaded: Awaited<ReturnType<RecipeStudioApi["load"]>>) => {
    setDraft({
      slug: recipe.slug,
      name: recipe.name,
      description: recipe.description ?? "",
      prompt: recipe.prompt,
      officers: recipe.officers ?? [],
      needs: loaded.needs.join("\n"),
      produces: loaded.produces.join("\n"),
    })
    setAssets(loaded.assets)
  }
  const open = async (recipe: Recipe) => {
    if (!(await leave())) return
    const api = props.api
    if (!api) return
    const generation = ++loadGeneration
    reset()
    setDraft(undefined)
    setLoading(true)
    try {
      const loaded = await api.load(recipe.slug)
      if (generation === loadGeneration && props.api === api) loadedDraft(recipe, loaded)
    } catch (cause) {
      if (generation === loadGeneration) fail(cause)
    } finally {
      if (generation === loadGeneration) setLoading(false)
    }
  }
  const newRecipe = async () => {
    if (await leave()) {
      loadGeneration++
      setLoading(false)
      reset()
      setDraft(blank())
    }
  }
  const closeEditor = async () => {
    if (await leave()) {
      loadGeneration++
      setLoading(false)
      reset()
      setDraft(undefined)
    }
  }
  createEffect(() => {
    const api = props.api
    connectionGeneration++
    loadGeneration++
    reset()
    setBusy(false)
    setDraft(undefined)
    setLoading(false)
    if (!api) return
    const timer = setInterval(() => {
      if (!rows.loading && !busy()) void refetch()
    }, 5000)
    onCleanup(() => clearInterval(timer))
  })
  let openedSlug: string | undefined
  createEffect(() => {
    const slug = props.selectedSlug
    const recipe = rows()?.find((item) => item.slug === slug)
    if (slug && recipe && openedSlug !== slug) {
      openedSlug = slug
      void open(recipe)
    }
  })
  createEffect(() => {
    const value = asset()
    const type = value && recipeFileImage(value.path)
    if (!value || !type) {
      setImageURL(undefined)
      return
    }
    const url = URL.createObjectURL(new Blob([recipeFileBytes(value)], { type }))
    setImageURL(url)
    onCleanup(() => URL.revokeObjectURL(url))
  })
  const persist = async (api: RecipeStudioApi, check: Check) => {
    let value = draft()
    if (!value) throw new Error("Choose a recipe first.")
    if (!value.name.trim()) throw new Error("Give your recipe a name.")
    if (!value.prompt.trim()) throw new Error("Add instructions so the team knows what to create.")
    try {
      decodeRecipeOfficers(value.officers)
    } catch {
      const incomplete = value.officers.findIndex((officer) => !officer.title.trim() || !officer.description.trim())
      throw new Error(
        incomplete >= 0
          ? `Officer ${incomplete + 1} needs a job title and description.`
          : "Check the custom nudges. Each needs a name, an instruction and a valid trigger.",
      )
    }
    if (!value.slug) {
      const created = await check(
        api.create({
          name: value.name.trim(),
          description: value.description.trim() || undefined,
          prompt: value.prompt,
          officers: value.officers,
        }),
      )
      value = { ...value, slug: created.slug }
      setDraft(value)
      setDirty(true)
    }
    const slug = value.slug!
    const recipe = await check(
      api.update(slug, {
        name: value.name.trim(),
        description: value.description.trim() || null,
        prompt: value.prompt,
        officers: value.officers,
        needs: lines(value.needs),
        produces: lines(value.produces),
      }),
    )
    for (const entry of Object.values(pending())) {
      await check(api.writeAsset(slug, entry))
      setAssets((previous) => [
        ...previous.filter((item) => item.path !== entry.path),
        { path: entry.path, bytes: recipeFileBytes(entry).length },
      ])
      setPending((previous) => {
        const next = { ...previous }
        delete next[entry.path]
        return next
      })
    }
    for (const path of removed()) {
      await check(api.deleteAsset(slug, path))
      setAssets((previous) => previous.filter((entry) => entry.path !== path))
      setRemoved((previous) => previous.filter((entry) => entry !== path))
    }
    setDraft((previous) => previous && { ...previous, name: recipe.name })
    setDirty(false)
    setSaved(true)
    await check(refetch())
    return recipe
  }
  const perform = async (action: (api: RecipeStudioApi, check: Check) => Promise<void>) => {
    const api = props.api
    if (!api || busy()) return
    const generation = connectionGeneration
    const current = () => generation === connectionGeneration && api === props.api
    const check: Check = async (operation) => {
      const result = await operation
      if (!current()) throw new Error("The instance changed while the operation was running.")
      return result
    }
    setBusy(true)
    setError(undefined)
    try {
      await action(api, check)
    } catch (cause) {
      if (current()) fail(cause)
    } finally {
      if (current()) setBusy(false)
    }
  }
  const save = () =>
    perform(async (api, check) => {
      await persist(api, check)
    })
  const share = () =>
    perform(async (api, check) => {
      const recipe = await persist(api, check)
      download(await check(api.export(recipe.slug)), exportFilename(recipe.slug))
    })
  const deploy = () =>
    perform(async (api, check) => {
      let slug: string
      const preview = packagePreview()
      if (preview) {
        const imported = preview.imported ?? (await check(api.import(preview.bytes)))
        slug = imported.slug
        setPackagePreview({ ...preview, imported })
        await check(refetch())
      } else slug = (await persist(api, check)).slug
      const deployed = await check(api.deploy(slug, deployDirectory().trim() || undefined))
      setDeploying(false)
      setBusy(false)
      props.onDeployed(deployed.projectID)
    })
  const importPackage = async (name: string, bytes: Uint8Array<ArrayBuffer>) => {
    if (!(await leave())) return
    await perform(async (api, check) => {
      const recipe = await check(api.preview(bytes))
      loadGeneration++
      reset()
      setDraft(undefined)
      setLoading(false)
      setPackagePreview({ name, bytes, recipe })
    })
  }
  const readPackage = async (file: File) => {
    if (file.size > MAX_RECIPE_ARCHIVE_BYTES) {
      fail(new Error("This package is too large. Choose a .nova file up to 32 MB."))
      return
    }
    try {
      await importPackage(file.name, new Uint8Array(await file.arrayBuffer()))
    } catch (cause) {
      fail(cause)
    }
  }
  const acceptPackage = () =>
    perform(async (api, check) => {
      const preview = packagePreview()
      if (!preview) return
      const recipe = preview.imported ?? (await check(api.import(preview.bytes)))
      reset()
      setDraft(undefined)
      await check(refetch())
      loadedDraft(recipe, await check(api.load(recipe.slug)))
    })
  const packageEvent = (event: Event) => {
    const detail = (event as CustomEvent<{ name?: string; bytes: Uint8Array<ArrayBuffer> }>).detail
    if (detail?.bytes && props.api) {
      const queue = (window as Window & { __NOVACLAW__?: { recipePackages?: (typeof detail)[] } }).__NOVACLAW__
        ?.recipePackages
      const index = queue?.findIndex((entry) => entry.bytes === detail.bytes) ?? -1
      if (index >= 0) queue?.splice(index, 1)
      void importPackage(detail.name ?? "Recipe package", detail.bytes)
    }
  }
  window.addEventListener("novaclaw:recipe-package", packageEvent)
  onCleanup(() => window.removeEventListener("novaclaw:recipe-package", packageEvent))
  createEffect(() => {
    if (!props.api) return
    const queue = (
      window as Window & { __NOVACLAW__?: { recipePackages?: { name?: string; bytes: Uint8Array<ArrayBuffer> }[] } }
    ).__NOVACLAW__?.recipePackages
    const item = queue?.splice(0).at(-1)
    if (item) void importPackage(item.name ?? "Recipe package", item.bytes)
  })
  const addFiles = async (selected: FileList | null) => {
    if (!selected || busy()) return
    const entries = Array.from(selected)
    for (const file of entries) {
      if (file.name.toLowerCase() === "recipe.json") {
        fail(new Error("That name is reserved by the package. Rename the attachment first."))
        return
      }
      if (file.size > MAX_RECIPE_ARCHIVE_BYTES) {
        fail(new Error(`${file.name} is too large. Choose a file up to 32 MB.`))
        return
      }
    }
    await perform(async (_, check) => {
      for (const file of entries) {
        const bytes = new Uint8Array(await check(file.arrayBuffer()))
        let binary = ""
        for (let offset = 0; offset < bytes.length; offset += 8192)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
        setPending((previous) => ({
          ...previous,
          [file.name]: { path: file.name, encoding: "base64", content: btoa(binary) },
        }))
        setRemoved((previous) => previous.filter((path) => path !== file.name))
      }
      setDirty(true)
      setSaved(false)
    })
  }
  const openFile = async (path: string) =>
    perform(async (api, check) => {
      const staged = pending()[path]
      if (staged) {
        let value = staged
        if (!recipeFileImage(path)) {
          try {
            const content = new TextDecoder("utf-8", { fatal: true }).decode(recipeFileBytes(staged))
            if (!content.includes("\0")) value = { path, encoding: "utf8", content }
          } catch {}
        }
        setAsset(value)
      } else if (draft()?.slug) setAsset(await check(api.readAsset(draft()!.slug!, path)))
    })
  const editFile = (content: string) => {
    const current = asset()
    if (!current) return
    const value: RecipeAssetContent = { path: current.path, encoding: "utf8", content }
    setAsset(value)
    setPending((previous) => ({ ...previous, [value.path]: value }))
    setDirty(true)
    setSaved(false)
  }
  const removeFile = async (path: string) => {
    if (
      busy() ||
      !(await props.confirm({
        title: `Remove ${path}?`,
        description: "It will be removed from this recipe when you save.",
        confirmLabel: "Remove file",
        destructive: true,
      }))
    )
      return
    setPending((previous) => {
      const next = { ...previous }
      delete next[path]
      return next
    })
    if (assets().some((entry) => entry.path === path)) setRemoved((previous) => [...previous, path])
    if (asset()?.path === path) setAsset(undefined)
    setDirty(true)
    setSaved(false)
  }
  const copy = () =>
    perform(async (api, check) => {
      const original = await persist(api, check)
      const recipe = await check(api.duplicate(original.slug))
      setDraft((previous) => previous && { ...previous, slug: recipe.slug, name: recipe.name })
      await refetch()
    })
  const remove = async () => {
    const value = draft()
    if (
      !value?.slug ||
      busy() ||
      !(await props.confirm({
        title: `Delete “${value.name}”?`,
        description: "Remove this recipe from the library. Deployed projects keep their own copies.",
        confirmLabel: "Delete recipe",
        destructive: true,
      }))
    )
      return
    await perform(async (api, check) => {
      await check(api.remove(value.slug!))
      reset()
      setDraft(undefined)
      await refetch()
    })
  }

  return (
    <AppPage class="recipe-studio">
      <header class="studio-header">
        <div>
          <h1>Recipe Studio</h1>
          <p>Describe the work. Shape the team. Share the whole recipe.</p>
        </div>
        <div class="studio-actions">
          <button class="project-button" disabled={busy() || !props.api} onClick={() => importInput?.click()}>
            Import .nova
          </button>
          <button class="project-button primary" disabled={busy() || !props.api} onClick={() => void newRecipe()}>
            New recipe
          </button>
        </div>
        <input
          ref={importInput}
          class="studio-file-input"
          type="file"
          accept=".nova"
          aria-label="Import recipe package"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ""
            if (file) void readPackage(file)
          }}
        />
      </header>
      <Show when={error()}>
        <div class="studio-notice" role="alert">
          <span>{error()}</span>
          <button type="button" class="project-button" onClick={() => setError(undefined)}>
            Dismiss
          </button>
        </div>
      </Show>
      <Show when={rows.failed}>
        <div class="studio-notice" role="status">
          Connection lost — reconnecting. Your edits are still here.
          <button class="project-button" onClick={() => void refetch()}>
            Retry now
          </button>
        </div>
      </Show>
      <div class="studio-workspace" data-editing={!!draft() || !!packagePreview() || loading()}>
        <aside class="studio-library" aria-label="Recipe library">
          <input
            class="project-field"
            type="search"
            aria-label="Search recipes"
            placeholder="Find a recipe…"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <Show when={rows.idle || (rows.loading && !rows())}>
            <p class="studio-muted" role="status">
              Connecting to your recipes…
            </p>
          </Show>
          <For each={[false, true]}>
            {(builtin) => (
              <Show when={visible().some((recipe) => recipe.builtin === builtin)}>
                <h2>{builtin ? "Included recipes" : "Your recipes"}</h2>
                <For
                  each={visible()
                    .filter((recipe) => recipe.builtin === builtin)
                    .map((recipe) => recipe.slug)}
                >
                  {(slug) => {
                    const recipe = () => rows()!.find((item) => item.slug === slug)!
                    return (
                      <button
                        type="button"
                        class="studio-library-item"
                        classList={{ selected: draft()?.slug === recipe().slug }}
                        aria-pressed={draft()?.slug === recipe().slug}
                        disabled={busy()}
                        onClick={() => void open(recipe())}
                      >
                        <strong>{recipe().name}</strong>
                        <span>{recipe().description || "A recipe for your project team."}</span>
                        <small>
                          {recipe().officers?.length
                            ? `${recipe().officers!.length} officer ${recipe().officers!.length === 1 ? "role" : "roles"}`
                            : "Manager-led"}
                          {recipe().assets.length
                            ? ` · ${recipe().assets.length} ${recipe().assets.length === 1 ? "file" : "files"}`
                            : ""}
                        </small>
                      </button>
                    )
                  }}
                </For>
              </Show>
            )}
          </For>
          <Show when={rows() && visible().length === 0}>
            <p class="studio-muted">
              {query() ? "No recipes match your search." : "Your first recipe starts with an idea."}
            </p>
          </Show>
        </aside>
        <main class="studio-canvas">
          <Show when={loading()}>
            <p class="studio-empty" role="status">
              Opening recipe…
            </p>
          </Show>
          <Show when={!loading() && !draft() && !packagePreview()}>
            <div class="studio-empty">
              <span class="studio-kicker">FROM INTENT TO REALITY</span>
              <h2>What should your team create?</h2>
              <p>
                Choose a recipe or start with your own idea. Its instructions, officer roles and files travel together
                in one .nova package.
              </p>
              <button class="project-button primary" disabled={!props.api || busy()} onClick={() => void newRecipe()}>
                Create a recipe
              </button>
            </div>
          </Show>
          <Show when={packagePreview()}>
            {(preview) => (
              <section class="studio-package">
                <button class="project-button studio-back" onClick={() => void closeEditor()}>
                  Back to recipes
                </button>
                <span class="studio-kicker">RECIPE PACKAGE</span>
                <h2>{preview().recipe.name}</h2>
                <p>{preview().recipe.description || "A shared recipe for your project team."}</p>
                <div class="studio-actions">
                  <button class="project-button primary" disabled={busy()} onClick={() => void acceptPackage()}>
                    Add to library
                  </button>
                  <button class="project-button" disabled={busy()} onClick={() => setDeploying(true)}>
                    Deploy…
                  </button>
                </div>
                <section class="studio-section">
                  <h3>Instructions</h3>
                  <p class="studio-instructions-preview">{preview().recipe.prompt}</p>
                </section>
                <section class="studio-section">
                  <h3>Project team</h3>
                  <p class="studio-muted">A Manager coordinates the work and reports to Nova.</p>
                  <For each={preview().recipe.officers}>
                    {(officer) => (
                      <div class="studio-role-preview">
                        <strong>{officer.title}</strong>
                        <p>{officer.description}</p>
                        <For each={officer.nudges}>
                          {(nudge) => (
                            <p class="studio-muted">
                              {nudge.name}: {nudge.text}
                            </p>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </section>
                <section class="studio-section">
                  <h3>Included files · {preview().recipe.assets.length}</h3>
                  <For each={preview().recipe.assets}>{(path) => <p class="studio-file-name">{path}</p>}</For>
                </section>
              </section>
            )}
          </Show>
          <Show when={draft()}>
            {(value) => (
              <form
                class="studio-editor"
                onSubmit={(event) => {
                  event.preventDefault()
                  void save()
                }}
              >
                <div class="studio-editor-bar">
                  <button
                    type="button"
                    class="project-button studio-back"
                    aria-label="Back to recipes"
                    disabled={busy()}
                    onClick={() => void closeEditor()}
                  >
                    Recipes
                  </button>
                  <span role="status">
                    {busy() ? "Working…" : dirty() ? "Unsaved changes" : saved() ? "All changes saved" : ""}
                  </span>
                  <div class="studio-actions">
                    <button
                      type="button"
                      class="project-button"
                      disabled={busy() || !value().name.trim() || !value().prompt.trim()}
                      onClick={() => void share()}
                    >
                      Share<span class="studio-share-extension"> .nova</span>
                    </button>
                    <button type="submit" class="project-button" disabled={busy() || (!dirty() && !!value().slug)}>
                      Save
                    </button>
                    <button
                      type="button"
                      class="project-button primary"
                      disabled={busy() || !value().name.trim() || !value().prompt.trim()}
                      onClick={() => setDeploying(true)}
                    >
                      Deploy…
                    </button>
                  </div>
                </div>
                <fieldset disabled={busy()}>
                  <section class="studio-section studio-intent">
                    <label class="studio-name-label">
                      Recipe name
                      <input
                        aria-label="Recipe name"
                        class="studio-name"
                        required
                        maxLength={160}
                        placeholder="Give your idea a name"
                        value={value().name}
                        onInput={(event) => change({ name: event.currentTarget.value })}
                      />
                    </label>
                    <label class="studio-label">
                      Description
                      <textarea
                        rows={2}
                        class="project-field"
                        placeholder="What will this recipe create, and who is it for?"
                        value={value().description}
                        onInput={(event) => change({ description: event.currentTarget.value })}
                      />
                    </label>
                    <label class="studio-label">
                      Instructions
                      <span class="studio-muted">
                        Describe the result, the steps that matter and how the team should check its work.
                      </span>
                      <textarea
                        class="project-field studio-instructions"
                        required
                        rows={7}
                        placeholder="Create…"
                        value={value().prompt}
                        onInput={(event) => change({ prompt: event.currentTarget.value })}
                      />
                    </label>
                  </section>
                  <RecipeOfficersEditor officers={value().officers} onChange={(officers) => change({ officers })} />
                  <section class="studio-section" aria-label="Recipe files">
                    <div class="studio-section-heading">
                      <div>
                        <h2>Files & materials</h2>
                        <p>Images, reference documents and other files the team needs.</p>
                      </div>
                      <label class="project-button studio-upload">
                        Add files
                        <input
                          type="file"
                          multiple
                          class="studio-file-input"
                          aria-label="Add recipe files"
                          onChange={(event) => {
                            void addFiles(event.currentTarget.files)
                            event.currentTarget.value = ""
                          }}
                        />
                      </label>
                    </div>
                    <div class="studio-files">
                      <For
                        each={files()}
                        fallback={<p class="studio-muted">No files needed? Instructions alone are enough.</p>}
                      >
                        {(file) => (
                          <div class="studio-file-row">
                            <button type="button" class="studio-file-open" onClick={() => void openFile(file.path)}>
                              <strong>{file.path}</strong>
                              <small>
                                {file.bytes < 1024 ? `${file.bytes} B` : `${Math.ceil(file.bytes / 1024)} KB`}
                                {pending()[file.path] ? " · Changed" : ""}
                              </small>
                            </button>
                            <button
                              class="project-button subtle"
                              type="button"
                              aria-label={`Remove ${file.path}`}
                              onClick={() => void removeFile(file.path)}
                            >
                              Remove
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                    <Show when={asset()}>
                      {(file) => (
                        <section class="studio-file-preview" aria-label={`Preview ${file().path}`}>
                          <div class="studio-section-heading">
                            <h3>{file().path}</h3>
                            <button type="button" class="project-button" onClick={() => setAsset(undefined)}>
                              Close file
                            </button>
                          </div>
                          <Show when={imageURL()}>{(url) => <img src={url()} alt={file().path} />}</Show>
                          <Show when={!imageURL() && file().encoding === "utf8"}>
                            <label class="studio-label">
                              File contents
                              <textarea
                                class="project-field"
                                rows={9}
                                value={file().content}
                                onInput={(event) => editFile(event.currentTarget.value)}
                              />
                            </label>
                          </Show>
                          <Show when={!imageURL() && file().encoding !== "utf8"}>
                            <p class="studio-muted">
                              This file is included in your package. Add a file with the same name to replace it.
                            </p>
                          </Show>
                        </section>
                      )}
                    </Show>
                  </section>
                  <details class="studio-section studio-options">
                    <summary>
                      Requirements & expected files <span>Optional</span>
                    </summary>
                    <div class="studio-option-grid">
                      <label class="studio-label">
                        What needs to be available?
                        <span class="studio-muted">
                          One requirement per line, such as a compiler or a local service.
                        </span>
                        <textarea
                          class="project-field"
                          rows={3}
                          value={value().needs}
                          onInput={(event) => change({ needs: event.currentTarget.value })}
                        />
                      </label>
                      <label class="studio-label">
                        Which files should the team deliver?
                        <span class="studio-muted">One filename per line. Use names inside the project folder.</span>
                        <textarea
                          class="project-field"
                          rows={3}
                          value={value().produces}
                          onInput={(event) => change({ produces: event.currentTarget.value })}
                        />
                      </label>
                    </div>
                  </details>
                  <Show when={value().slug}>
                    <details class="studio-section studio-options">
                      <summary>Manage recipe</summary>
                      <div class="studio-actions">
                        <button type="button" class="project-button" onClick={() => void copy()}>
                          Make a copy
                        </button>
                        <button type="button" class="project-button danger" onClick={() => void remove()}>
                          Delete recipe
                        </button>
                      </div>
                    </details>
                  </Show>
                </fieldset>
              </form>
            )}
          </Show>
        </main>
      </div>
      <Show when={deploying()}>
        <dialog
          ref={(element) => {
            deployDialog = element
            queueMicrotask(() => {
              if (element.isConnected) element.showModal()
            })
          }}
          class="studio-deploy"
          aria-label="Deploy recipe"
          onCancel={(event) => {
            event.preventDefault()
            if (!busy()) closeDeployment()
          }}
        >
          <span class="studio-kicker">NEW PROJECT</span>
          <h2>Deploy {draft()?.name || packagePreview()?.recipe.name}</h2>
          <p>A Manager will lead the team and report to Nova. Follow their progress in Projects.</p>
          <details>
            <summary>
              Choose a project folder <span>Optional</span>
            </summary>
            <label class="studio-label">
              New folder on this instance
              <input
                class="project-field"
                value={deployDirectory()}
                disabled={busy()}
                onInput={(event) => setDeployDirectory(event.currentTarget.value)}
                placeholder="Leave blank for the default"
              />
            </label>
            <p class="studio-muted">
              Leave blank to create a folder in your NovaClaw home’s projects directory. A custom path must name a new
              folder.
            </p>
          </details>
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
          <div class="studio-actions">
            <button class="project-button" disabled={busy()} onClick={closeDeployment}>
              Cancel
            </button>
            <button class="project-button primary" autofocus disabled={busy()} onClick={() => void deploy()}>
              {busy() ? "Preparing…" : "Deploy recipe"}
            </button>
          </div>
        </dialog>
      </Show>
    </AppPage>
  )
}

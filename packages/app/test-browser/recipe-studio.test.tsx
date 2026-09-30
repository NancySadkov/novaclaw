import { afterEach, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { MemoryRouter, Route, useNavigate } from "@solidjs/router"
import { RecipeStudio } from "@/components/recipe-studio"
import type { RecipeStudioApi } from "@/utils/recipe-studio"
import type { Recipe, RecipeAssetContent, UpdateRecipeInput } from "@/utils/recipe-api"

let host: HTMLDivElement
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  host?.remove()
  dispose = undefined
})
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const recipe: Recipe = {
  slug: "observatory",
  name: "Observatory",
  description: "A view of the sky",
  prompt: "Build an offline observatory.",
  officers: [],
  assets: ["brief.txt"],
  builtin: false,
  updatedAt: 1,
}
const makeApi = () => {
  const calls: string[] = []
  const updates: UpdateRecipeInput[] = []
  const writes: RecipeAssetContent[] = []
  let current = { ...recipe }
  const api: RecipeStudioApi = {
    list: async () => [current, { ...recipe, slug: "garden", name: "Garden" }],
    load: async () => ({ needs: ["A browser"], produces: ["index.html"], assets: [{ path: "brief.txt", bytes: 3 }] }),
    create: async (input) => {
      calls.push("create")
      current = { ...recipe, ...input, slug: "created" }
      return current
    },
    update: async (slug, input) => {
      calls.push(`update:${slug}`)
      updates.push(input)
      current = { ...current, ...input, description: input.description ?? undefined }
      return current
    },
    readAsset: async (_, path) => ({ path, content: "old", encoding: "utf8" }),
    writeAsset: async (_, asset) => {
      calls.push("write")
      writes.push(asset)
      return asset
    },
    deleteAsset: async () => {
      calls.push("delete-file")
    },
    preview: async () => ({
      name: "Shared sky",
      description: "Offline sky",
      prompt: "Build the sky.",
      officers: [],
      assets: ["sky.png"],
    }),
    import: async () => {
      calls.push("import")
      return { ...recipe, slug: "shared", name: "Shared sky" }
    },
    export: async () => {
      calls.push("export")
      return new Uint8Array([80, 75, 3, 4])
    },
    duplicate: async () => ({ ...recipe, slug: "copy", name: "Observatory copy" }),
    remove: async () => {},
    deploy: async (slug, directory) => {
      calls.push(`deploy:${slug}:${directory ?? "default"}`)
      return {
        projectID: "prj_sky",
        slug: "prj_sky",
        name: "Sky",
        manager: "iris",
        directory: directory ?? "/home/projects/sky",
        state: "deploying",
      }
    },
  }
  return { api, calls, updates, writes }
}
const mount = async (
  api: RecipeStudioApi | (() => RecipeStudioApi),
  confirm = async () => true,
  onDeployed = (_: string) => {},
  navigateOnDeploy = false,
) => {
  host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () => (
      <MemoryRouter>
        <Route
          path="/"
          component={() => {
            const navigate = useNavigate()
            return (
              <RecipeStudio
                api={typeof api === "function" ? api() : api}
                confirm={confirm}
                onDeployed={(id) => {
                  onDeployed(id)
                  if (navigateOnDeploy) navigate("/deployed")
                }}
              />
            )
          }}
        />
        <Route path="/deployed" component={() => <p>Project opened</p>} />
      </MemoryRouter>
    ),
    host,
  )
  await settle()
}
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === label)!
const input = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  element.value = value
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
const open = async () => {
  host.querySelector<HTMLButtonElement>(".studio-library-item")!.click()
  await settle()
}

test("edits a whole recipe through friendly fields and preserves requirements without exposing the manifest", async () => {
  const { api, updates } = makeApi()
  await mount(api)
  const libraryItem = host.querySelector(".studio-library-item")
  await open()
  expect(host.textContent).not.toContain("recipe.json")
  expect(host.querySelector('[role="tablist"]')).toBeNull()
  expect(host.querySelector('input[aria-label="Import recipe package"]')?.getAttribute("accept")).toBe(".nova")
  input(host.querySelector<HTMLInputElement>('[aria-label="Recipe name"]')!, "Night sky")
  input(host.querySelector<HTMLTextAreaElement>(".studio-instructions")!, "Build a star chart.")
  button("Save").click()
  await settle()
  expect(host.querySelector(".studio-library-item")).toBe(libraryItem)
  expect(updates[0]).toMatchObject({
    name: "Night sky",
    prompt: "Build a star chart.",
    needs: ["A browser"],
    produces: ["index.html"],
  })
  expect(host.textContent).toContain("All changes saved")
})

test("sharing saves instruction and attachment edits before packing the recipe", async () => {
  const { api, calls, writes } = makeApi()
  await mount(api)
  await open()
  host.querySelector<HTMLButtonElement>(".studio-file-open")!.click()
  await settle()
  input(host.querySelector<HTMLTextAreaElement>(".studio-file-preview textarea")!, "new reference")
  input(host.querySelector<HTMLTextAreaElement>(".studio-instructions")!, "Follow the reference.")
  button("Share .nova").click()
  await settle()
  expect(calls).toEqual(["update:observatory", "write", "export"])
  expect(writes).toEqual([{ path: "brief.txt", encoding: "utf8", content: "new reference" }])
  expect(host.textContent).toContain("All changes saved")
})

test("a failed attachment save blocks deployment and retains edits for retry", async () => {
  const { api, calls } = makeApi()
  const write = api.writeAsset
  api.writeAsset = async () => {
    throw new Error("Disk is full")
  }
  let opened = ""
  await mount(
    api,
    async () => true,
    (id) => {
      opened = id
    },
  )
  await open()
  host.querySelector<HTMLButtonElement>(".studio-file-open")!.click()
  await settle()
  input(host.querySelector<HTMLTextAreaElement>(".studio-file-preview textarea")!, "keep this")
  button("Deploy…").click()
  await settle()
  button("Deploy recipe").click()
  await settle()
  expect(opened).toBe("")
  expect(calls.some((call) => call.startsWith("deploy:"))).toBe(false)
  expect(host.textContent).toContain("Disk is full")
  expect(host.textContent).toContain("Unsaved changes")
  api.writeAsset = write
  button("Deploy recipe").click()
  await settle()
  expect(calls.at(-1)).toBe("deploy:observatory:default")
  expect(opened).toBe("prj_sky")
})

test("a new recipe survives a later save failure without creating duplicates", async () => {
  const { api, calls } = makeApi()
  const update = api.update
  api.update = async () => {
    throw new Error("Connection lost")
  }
  await mount(api)
  button("New recipe").click()
  await settle()
  input(host.querySelector<HTMLInputElement>('[aria-label="Recipe name"]')!, "Aurora")
  input(host.querySelector<HTMLTextAreaElement>(".studio-instructions")!, "Build an aurora.")
  button("Save").click()
  await settle()
  expect(host.textContent).toContain("Connection lost")
  api.update = update
  button("Save").click()
  await settle()
  expect(calls.filter((call) => call === "create")).toHaveLength(1)
  expect(calls.at(-1)).toBe("update:created")
})

test("a cancelled recipe switch keeps unsaved edits and late reads cannot replace the selected recipe", async () => {
  const { api } = makeApi()
  await mount(api, async () => false)
  await open()
  input(host.querySelector<HTMLInputElement>('[aria-label="Recipe name"]')!, "Unsaved sky")
  host.querySelectorAll<HTMLButtonElement>(".studio-library-item")[1]!.click()
  await settle()
  expect(host.querySelector<HTMLInputElement>('[aria-label="Recipe name"]')!.value).toBe("Unsaved sky")
  dispose?.()
  host.remove()
  let resolveFirst!: (value: Awaited<ReturnType<RecipeStudioApi["load"]>>) => void
  api.load = (slug) =>
    slug === "observatory"
      ? new Promise((resolve) => {
          resolveFirst = resolve
        })
      : Promise.resolve({ needs: [], produces: [], assets: [] })
  await mount(api)
  host.querySelectorAll<HTMLButtonElement>(".studio-library-item")[0]!.click()
  await settle()
  host.querySelectorAll<HTMLButtonElement>(".studio-library-item")[1]!.click()
  await settle()
  resolveFirst({ needs: ["stale"], produces: [], assets: [] })
  await settle()
  expect(host.querySelector<HTMLInputElement>('[aria-label="Recipe name"]')!.value).toBe("Garden")
})

test("a shared package is reviewed as instructions, roles and files before import", async () => {
  const { api, calls } = makeApi()
  await mount(api)
  window.dispatchEvent(
    new CustomEvent("novaclaw:recipe-package", { detail: { name: "sky.nova", bytes: new Uint8Array([80, 75]) } }),
  )
  await settle()
  expect(host.textContent).toContain("Shared sky")
  expect(host.textContent).toContain("Build the sky.")
  expect(host.textContent).toContain("sky.png")
  expect(host.textContent).not.toContain("recipe.json")
  expect(calls).not.toContain("import")
  button("Add to library").click()
  await settle()
  expect(calls).toEqual(["import"])
  expect(host.querySelector<HTMLInputElement>('[aria-label="Recipe name"]')!.value).toBe("Shared sky")
})

test("switching instances cancels the remaining save steps and ignores the old result", async () => {
  const first = makeApi()
  const second = makeApi()
  let complete!: (value: Recipe) => void
  first.api.update = async () =>
    new Promise<Recipe>((resolve) => {
      complete = resolve
    })
  const [api, setApi] = createSignal(first.api)
  await mount(api)
  await open()
  button("Share .nova").click()
  await settle()
  setApi(second.api)
  await settle()
  await open()
  input(host.querySelector<HTMLInputElement>('[aria-label="Recipe name"]')!, "Second instance")
  complete({ ...recipe, name: "Old response" })
  await settle()
  expect(host.querySelector<HTMLInputElement>('[aria-label="Recipe name"]')!.value).toBe("Second instance")
  expect(first.calls).not.toContain("export")
  expect(host.querySelector('[role="alert"]')).toBeNull()
  button("Save").click()
  await settle()
  expect(second.updates[0]?.name).toBe("Second instance")
})

test("an imported package stays in the library when its first editor read fails", async () => {
  const { api, calls } = makeApi()
  api.import = async () => {
    calls.push("import")
    api.list = async () => [{ ...recipe, slug: "shared", name: "Shared sky" }]
    return { ...recipe, slug: "shared", name: "Shared sky" }
  }
  api.load = async () => {
    throw new Error("Connection interrupted")
  }
  await mount(api)
  window.dispatchEvent(
    new CustomEvent("novaclaw:recipe-package", { detail: { name: "sky.nova", bytes: new Uint8Array([1]) } }),
  )
  await settle()
  button("Add to library").click()
  await settle()
  expect(host.textContent).toContain("Connection interrupted")
  expect(button("Add to library")).toBeUndefined()
  expect(host.querySelector(".studio-library-item")?.textContent).toContain("Shared sky")
  api.load = async () => ({ needs: ["A telescope"], produces: ["chart.html"], assets: [] })
  await open()
  expect(host.querySelector<HTMLInputElement>('[aria-label="Recipe name"]')?.value).toBe("Shared sky")
  expect(calls.filter((value) => value === "import")).toHaveLength(1)
})

test("retrying a shared package deployment keeps the imported recipe and custom destination", async () => {
  const { api, calls } = makeApi()
  const deploy = api.deploy
  api.deploy = async () => {
    throw new Error("Could not prepare the folder")
  }
  let opened = ""
  await mount(
    api,
    async () => true,
    (id) => {
      opened = id
    },
  )
  window.dispatchEvent(
    new CustomEvent("novaclaw:recipe-package", { detail: { name: "sky.nova", bytes: new Uint8Array([1]) } }),
  )
  await settle()
  button("Deploy…").click()
  await settle()
  input(host.querySelector<HTMLInputElement>(".studio-deploy input")!, "/custom/night-sky")
  button("Deploy recipe").click()
  await settle()
  expect(host.textContent).toContain("Could not prepare the folder")
  api.deploy = deploy
  button("Deploy recipe").click()
  await settle()
  expect(calls.filter((value) => value === "import")).toHaveLength(1)
  expect(calls.at(-1)).toBe("deploy:shared:/custom/night-sky")
  expect(opened).toBe("prj_sky")
})

test("successful deployment opens the project despite the editor's busy navigation guard", async () => {
  const { api } = makeApi()
  await mount(
    api,
    async () => true,
    () => {},
    true,
  )
  await open()
  button("Deploy…").click()
  await settle()
  button("Deploy recipe").click()
  await settle()
  expect(host.textContent).toContain("Project opened")
  expect(host.querySelector(".studio-editor")).toBeNull()
})

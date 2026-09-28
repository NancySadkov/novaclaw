import { afterEach, expect, test } from "bun:test"
import { render } from "solid-js/web"
import type { WorkProject } from "@novaclaw/schema/work-project"
import { ProjectsPanel } from "@/pages/projects"
import { dict } from "@/i18n/en"
import type { ProjectsApi } from "@/utils/projects-api"

let host: HTMLDivElement
let base: HTMLBaseElement | undefined
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  host?.remove()
  base?.remove()
  base = undefined
  dispose = undefined
})
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const dictionary: Record<string, string> = dict
const t = (key: string, params?: Record<string, string | number | boolean>) =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
    dictionary[key] ?? key,
  )
const project: WorkProject.Info = {
  id: "prj_one",
  name: "Observatory",
  objective: "Map the night sky",
  directory: "/srv/observatory",
  phases: [
    { id: "design", name: "Design", status: "complete" },
    { id: "build", name: "Build", status: "pending" },
  ],
  paused: false,
  revision: 3,
  completedPhases: 1,
  totalPhases: 2,
  workingOfficers: 1,
  totalOfficers: 2,
}
const snapshot: WorkProject.Snapshot = {
  projects: [project],
  officers: [
    { id: "iris", name: "Iris", title: "Engineer", paused: false, working: true, projectID: project.id },
    { id: "lyra", name: "Lyra", title: "Researcher", paused: true, working: false, projectID: project.id },
    { id: "thea", name: "Thea", title: "Designer", paused: false, working: false, projectID: null },
  ],
}
const mount = async (
  api: ProjectsApi,
  confirm = async () => true,
  pickDirectory?: (select: (directory: string) => void) => void,
) => {
  if (!base) {
    base = document.createElement("base")
    base.href = "http://localhost/"
    document.head.append(base)
  }
  host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <ProjectsPanel api={api} t={t} confirm={confirm} pickDirectory={pickDirectory} />, host)
  await settle()
}
const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text)!
const input = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  element.value = value
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
const selectProject = async () => {
  host.querySelector<HTMLButtonElement>(".project-card")!.click()
  await settle()
}

test("edits the server folder through the picker, restores it on reopen and clears it explicitly", async () => {
  let state = structuredClone(snapshot)
  const commands: WorkProject.Command[] = []
  await mount(
    {
      list: async () => state,
      execute: async (command) => {
        commands.push(command)
        if (command.op === "edit")
          state = { ...state, projects: [{ ...state.projects[0]!, directory: command.directory ?? null }] }
        return state
      },
    },
    async () => true,
    (select) => select("/srv/sky survey"),
  )
  await selectProject()
  expect(host.textContent).toContain("/srv/observatory")
  button("Edit project").click()
  await settle()
  button("Browse folders…").click()
  const folder = () =>
    [...host.querySelectorAll<HTMLLabelElement>("label")]
      .find((label) => label.textContent?.includes("Folder on server"))!
      .querySelector("input")!
  expect(folder().value).toBe("/srv/sky survey")
  host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await settle()
  expect(commands.at(-1)).toMatchObject({ op: "edit", directory: "/srv/sky survey" })
  expect(host.textContent).toContain("/srv/sky survey")
  button("Edit project").click()
  await settle()
  expect(folder().value).toBe("/srv/sky survey")
  button("Clear folder").click()
  host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await settle()
  expect(commands.at(-1)).toMatchObject({ op: "edit", directory: null })
})

test("shows real progress and officer counts; pause/resume and phase checkboxes call the project API", async () => {
  const commands: WorkProject.Command[] = []
  let state = structuredClone(snapshot)
  await mount({
    list: async () => state,
    execute: async (command) => {
      commands.push(command)
      if (command.op === "pause") state = { ...state, projects: [{ ...state.projects[0]!, paused: command.paused }] }
      if (command.op === "phase")
        state = {
          ...state,
          projects: [
            {
              ...state.projects[0]!,
              completedPhases: 2,
              phases: project.phases.map((phase) => ({ ...phase, status: "complete" })),
            },
          ],
        }
      return state
    },
  })
  expect(host.textContent).toContain("1 of 2 phases")
  expect(host.textContent).toContain("50%")
  await selectProject()
  expect(host.textContent).toContain("1 working · 2 total")
  expect(host.textContent).toContain("Individually paused")
  button("Pause").click()
  await settle()
  expect(commands.at(-1)).toEqual({ op: "pause", id: project.id, paused: true })
  expect(host.textContent).toContain("current step finishes")
  button("Resume").click()
  await settle()
  expect(commands.at(-1)).toEqual({ op: "pause", id: project.id, paused: false })
  const phase = host.querySelectorAll<HTMLInputElement>(".project-plan input")[1]!
  phase.checked = true
  phase.dispatchEvent(new Event("change", { bubbles: true }))
  await settle()
  expect(commands.at(-1)).toEqual({ op: "phase", id: project.id, phaseID: "build", status: "complete" })
  expect(host.textContent).toContain("100%")
})

test("creates a structured plan and edits its order without losing focus or stable phase IDs", async () => {
  const commands: WorkProject.Command[] = []
  await mount({
    list: async () => snapshot,
    execute: async (command) => {
      commands.push(command)
      return snapshot
    },
  })
  button("New project").click()
  await settle()
  const name = host.querySelector<HTMLInputElement>("form .project-label input")!
  input(name, "New observatory")
  input(host.querySelector<HTMLTextAreaElement>("textarea")!, "Observe the sky")
  button("Add phase").click()
  button("Add phase").click()
  await settle()
  const phases = host.querySelectorAll<HTMLInputElement>(
    ".project-phase-editor input[type=text], .project-phase-editor input:not([type])",
  )
  phases[0]!.focus()
  input(phases[0]!, "Research")
  expect(document.activeElement).toBe(phases[0])
  input(phases[1]!, "Build")
  host.querySelector<HTMLButtonElement>('[aria-label="Move phase 2 up"]')!.click()
  await settle()
  host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await settle()
  const command = commands[0]!
  expect(command.op).toBe("create")
  if (command.op !== "create") throw new Error("missing create")
  expect(command.name).toBe("New observatory")
  expect(command.phases.map((phase) => phase.name)).toEqual(["Build", "Research"])
  expect(new Set(command.phases.map((phase) => phase.id)).size).toBe(2)
  await selectProject()
  button("Edit project").click()
  await settle()
  host.querySelector<HTMLButtonElement>('[aria-label="Move phase 2 up"]')!.click()
  host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await settle()
  expect(commands[1]).toMatchObject({
    op: "edit",
    id: project.id,
    revision: 3,
    phases: [
      { id: "build", name: "Build", status: "pending" },
      { id: "design", name: "Design", status: "complete" },
    ],
  })
})

test("assigns and releases officers and requires confirmation before deletion", async () => {
  const commands: WorkProject.Command[] = []
  let confirmed = false
  await mount(
    {
      list: async () => snapshot,
      execute: async (command) => {
        commands.push(command)
        return snapshot
      },
    },
    async () => confirmed,
  )
  await selectProject()
  const assign = host.querySelector<HTMLButtonElement>(".project-assign")!
  assign.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
  )
  await Promise.resolve()
  assign.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }))
  await settle()
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
    option.textContent?.includes("Thea"),
  )!
  option.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
  )
  await Promise.resolve()
  option.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }))
  await settle()
  expect(commands.at(-1)).toEqual({ op: "assign", officer: "thea", projectID: project.id })
  host.querySelector<HTMLButtonElement>('[aria-label="Release Iris from this project"]')!.click()
  await settle()
  expect(commands.at(-1)).toEqual({ op: "assign", officer: "iris", projectID: null })
  button("Delete").click()
  await settle()
  expect(commands).toHaveLength(2)
  confirmed = true
  button("Delete").click()
  await settle()
  expect(commands.at(-1)).toEqual({ op: "delete", id: project.id, revision: 3 })
})

test("keeps edits and reports a concurrent update; a failed listing never claims an empty project list", async () => {
  await mount({
    list: async () => snapshot,
    execute: async () => {
      throw new Error("This project changed while you were editing. Reload it before saving or deleting.")
    },
  })
  await selectProject()
  button("Edit project").click()
  await settle()
  input(host.querySelector<HTMLInputElement>("form .project-label input")!, "Unsaved observatory")
  host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await settle()
  expect(host.querySelector<HTMLInputElement>("form .project-label input")!.value).toBe("Unsaved observatory")
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("changed while you were editing")
  dispose?.()
  host.remove()
  await mount({
    list: async () => {
      throw new Error("offline")
    },
    execute: async () => snapshot,
  })
  expect(host.textContent).toContain("reconnecting")
  expect(host.textContent).not.toContain("Make room for the next ambition")
  expect(button("Retry now")).toBeDefined()
})

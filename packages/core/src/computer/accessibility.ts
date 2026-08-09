export * as ComputerAccessibility from "./accessibility"

import type { ComputerActions } from "./actions"
import type { ComputerCoordinates } from "./coordinates"

/** Roles/names that identify a whole surface rather than an actionable control. */
export const CONTAINER_ANTI_PATTERNS = ["RootWebArea", "Chrome Legacy Window", "BrowserWindow"] as const
const CONTAINER_ROLES = new Set(["application", "desktop frame", "frame", "panel", "section", "viewport", "window"])

export interface Candidate {
  readonly id: string
  readonly role: string
  readonly name: string
  readonly bounds: ComputerActions.Region
  /** AT-SPI action names advertised by this exact node. */
  readonly actions: ReadonlyArray<string>
}

export interface RejectedCandidate {
  readonly index: number
  readonly reason: string
}

export interface CandidateSet {
  readonly candidates: ReadonlyArray<Candidate>
  readonly rejected: ReadonlyArray<RejectedCandidate>
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized === "" ? undefined : normalized
}

const region = (value: unknown, viewport: ComputerCoordinates.Viewport): ComputerActions.Region | undefined => {
  if (!record(value)) return undefined
  const { x, y, width, height } = value
  if (![x, y, width, height].every((part) => typeof part === "number" && Number.isInteger(part))) return undefined
  if ((x as number) < 0 || (y as number) < 0 || (width as number) < 1 || (height as number) < 1) return undefined
  if ((x as number) + (width as number) > viewport.width || (y as number) + (height as number) > viewport.height)
    return undefined
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

/**
 * Turn an untrusted AT-SPI enumeration into the only candidates the planner may cite.
 *
 * Duplicate ids reject every colliding node: accepting the first would make the same model reply
 * select a different control when traversal order changes. Containers, nameless nodes and invalid
 * bounds are absent rather than shown as tempting but unusable targets.
 */
export function normalize(
  input: ReadonlyArray<unknown>,
  viewport: ComputerCoordinates.Viewport,
): CandidateSet {
  const ids = new Map<string, number>()
  for (const raw of input) {
    if (!record(raw)) continue
    const id = text(raw.id)
    if (id !== undefined) ids.set(id, (ids.get(id) ?? 0) + 1)
  }

  const candidates: Candidate[] = []
  const rejected: RejectedCandidate[] = []
  input.forEach((raw, index) => {
    if (!record(raw)) return rejected.push({ index, reason: "not an object" })
    const id = text(raw.id)
    const name = text(raw.name)
    const role = text(raw.role)
    const bounds = region(raw.bounds, viewport)
    if (id === undefined) return rejected.push({ index, reason: "missing unique id" })
    if ((ids.get(id) ?? 0) !== 1) return rejected.push({ index, reason: `duplicate id: ${id}` })
    if (name === undefined) return rejected.push({ index, reason: "missing own name" })
    if (role === undefined) return rejected.push({ index, reason: "missing role" })
    if ((CONTAINER_ANTI_PATTERNS as ReadonlyArray<string>).some((value) => value === role || value === name))
      return rejected.push({ index, reason: `container anti-pattern: ${role}/${name}` })
    if (CONTAINER_ROLES.has(role.toLowerCase()))
      return rejected.push({ index, reason: `container role: ${role}` })
    if (bounds === undefined) return rejected.push({ index, reason: "invalid or off-screen bounds" })
    const actions = Array.isArray(raw.actions)
      ? raw.actions.map(text).filter((value): value is string => value !== undefined)
      : []
    candidates.push({ id, role, name, bounds, actions: [...new Set(actions)] })
  })
  return { candidates, rejected }
}

export type Selection =
  | { readonly ok: true; readonly candidate: Candidate }
  | { readonly ok: false; readonly reason: string }

/** A tree selection is legal only when id AND the node's own name agree. */
export function select(candidates: ReadonlyArray<Candidate>, id: string, target: string): Selection {
  const matches = candidates.filter((candidate) => candidate.id === id.trim())
  if (matches.length !== 1) return { ok: false, reason: `element_id does not name exactly one supplied candidate: ${id}` }
  const candidate = matches[0]!
  if (candidate.name !== target.replace(/\s+/g, " ").trim())
    return { ok: false, reason: `element_id ${candidate.id} is named ${JSON.stringify(candidate.name)}, not ${JSON.stringify(target)}` }
  return { ok: true, candidate }
}

/** Centre of application-supplied bounds, in screen pixels. */
export const center = (candidate: Candidate): ComputerCoordinates.Point => ({
  x: Math.round(candidate.bounds.x + candidate.bounds.width / 2),
  y: Math.round(candidate.bounds.y + candidate.bounds.height / 2),
})

/**
 * Prefer a semantic AT-SPI action for a left click. The exact advertised spelling is returned so
 * the adapter invokes what the application exposed, never an action name the harness invented.
 */
export function semanticAction(
  candidate: Candidate,
  kind: "move" | "click" | "double_click",
  button?: ComputerActions.Button,
): string | undefined {
  if (kind !== "click" || (button ?? "left") !== "left") return undefined
  for (const preferred of ["click", "press", "activate"]) {
    const action = candidate.actions.find((value) => value.toLowerCase() === preferred)
    if (action !== undefined) return action
  }
  return undefined
}

/** Compact, bounded planner projection. Bounds remain pixels supplied by the application. */
export function render(candidates: ReadonlyArray<Candidate>, limit = 80): string {
  if (candidates.length === 0) return "(none — use the screenshot channel)"
  const visible = candidates.slice(0, limit)
  const lines = visible.map(
    (candidate) =>
      `${candidate.id}\t${candidate.role}\t${JSON.stringify(candidate.name)}\t` +
      `${candidate.bounds.x},${candidate.bounds.y},${candidate.bounds.width},${candidate.bounds.height}\t` +
      (candidate.actions.length === 0 ? "-" : candidate.actions.join(",")),
  )
  if (visible.length < candidates.length) lines.push(`… ${candidates.length - visible.length} more omitted`)
  return lines.join("\n")
}

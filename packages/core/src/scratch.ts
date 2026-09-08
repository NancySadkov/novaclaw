/**
 * The shared **default working directory** for folder-less agents — a "New Agent" started
 * without picking a project/folder still gets a real, safe, app-managed cwd here, so EVERY
 * agent always has a folder where it can do basic work (write & run a python script, jot a
 * file, etc.). Uniform handling: even a "basic chat" is an agent bound to a folder.
 *
 * It is a REAL host directory under `<data>/scratch` that the app fully controls — NOT the
 * user's home dir (safe by construction), and distinct from the FS-3 `vfs` (which is the
 * no-browsable-FS fallback). Env override exists for tests.
 */
export * as Scratch from "./scratch"

import fsp from "node:fs/promises"
import path from "node:path"
import { Global } from "./global"

/** The app-managed default scratch working directory. */
export function root(): string {
  return process.env.NOVACLAW_SCRATCH_ROOT ?? path.join(Global.Path.data, "scratch")
}

/**
 * Ensure the scratch dir exists. Idempotent; returns the absolute path. Cheap to call on every
 * `/path` request (like `VirtualFs.ensure`).
 *
 * 🔴 **It seeds NOTHING, and that is the point** (owner, 2026-08-27). Both scratch `ensure`s used to
 * write a README explaining what the folder was. The reader that copy cost was never the user — it
 * was the AGENT. `session/runner/project-grounding.ts` hands the model a listing of its working
 * directory on purpose (*"a listing is the horizon, so the harness carries it rather than asking for
 * it"*), so a seeded file is something every colleague sees in every fresh context, forever. A brand
 * new officer's folder held exactly one file, so a model orienting itself read the only thing there —
 * measured on a plain *"hi"*, which is the cheapest turn there is.
 *
 * ⚠️ This is `uix.md` §1.4's measured lesson relocated to the filesystem. There, told to explain and
 * given no mechanism, agents wrote *"another paragraph in the DOM, for every user on every visit"*;
 * here it was a paragraph in the WORKSPACE, for every agent on every grounding. The folder's purpose
 * already has an on-demand home — the colleague's own configuration names its workspace and offers to
 * point it at a real project — and a README cannot be the answer to a question the UI already answers.
 *
 * **If a colleague or a user wants a README, they will write one.** An empty folder is the honest
 * starting state and costs nobody a token.
 */
export async function ensure(): Promise<string> {
  const base = root()
  await fsp.mkdir(base, { recursive: true })
  return base
}

/**
 * A COLLEAGUE's own scratch folder — `<data>/scratch/<agentID>`.
 *
 * 🔴 Per agent, not shared, because the folder is now part of a colleague's configuration (owner,
 * 2026-08-21: *"the folder an agent works on is now part of its configuration, defaulting to that
 * agent's scratch"*). A roster of officers sharing one scratch dir is a filing cabinet with no
 * drawers: the bookkeeper's notes and the dungeon master's land in the same place, and neither can
 * be moved or cleared without touching the other. The id is the key here exactly as it is for memory
 * (`agent:<id>`) and for the chat, so a colleague's three belongings agree on what identifies it.
 */
export function forAgent(agentID: string): string {
  return path.join(root(), agentID)
}

/**
 * Ensure a colleague's own scratch folder exists — EMPTY. Idempotent; returns the absolute path.
 *
 * 🔴 See `ensure` above for why nothing is seeded here. This was the folder that showed it: a newly
 * hired officer's workspace contained one README, the grounding listing put it in front of the model,
 * and the model spent a tool call reading it before answering *"hi"*.
 *
 * ⚠️ `displayName` is kept in the signature deliberately. It has no use while the folder starts
 * empty, and every caller already has the name — dropping it would make re-introducing a per-colleague
 * seed a signature change across the callers rather than a decision made here, and the decision is the
 * thing that should be hard to reverse by accident.
 */
export async function ensureForAgent(agentID: string, _displayName?: string): Promise<string> {
  const dir = forAgent(agentID)
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

/** True when an absolute path is inside the scratch root (containment guard reuse). */
export function contains(target: string): boolean {
  const base = path.resolve(root())
  const resolved = path.resolve(target)
  return resolved === base || resolved.startsWith(base + path.sep)
}

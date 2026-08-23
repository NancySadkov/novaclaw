import { describe, expect, test } from "bun:test"

/**
 * LIVE: officers doing officer things, on a real instance with a real model.
 *
 * Three claims the unit tests structurally cannot make, because each depends on a MODEL deciding to
 * act — and each of them was measured failing before it passed:
 *
 *   1. **A direct order to spawn a fleet produces a fleet.** Measured 2026-08-22 on Qwen3.6-35B: the
 *      officer first reached for `colleague` and addressed ITSELF six times, then hunted for `spawn`
 *      with `tool_search` and looped. Two fixes later (a delegation section in the prompt, and an
 *      exemption so an explicit delegation order does not trip the set gate that WITHHOLDS `spawn`)
 *      the same prompt produces six completed spawns.
 *   2. **An officer with a project folder knows it also has its own workspace**, and puts a private
 *      note there rather than in the user's project.
 *   3. **A colleague hand-off round-trips**, and the sender is told where the answer will arrive.
 *
 * Run:  bun test ./test/agent-officer-live.smoke.ts
 *
 * ⚠️ Needs a RUNNING instance and a reachable model. Both are checked first and the file SKIPS with a
 * reason rather than failing: a red smoke that only means "nothing was running" trains people to
 * ignore it. Point it elsewhere with NOVACLAW_URL / SMOKE_MODEL.
 */

const URL_BASE = process.env.NOVACLAW_URL ?? "http://127.0.0.1:4096"
/** `providerID/modelID` as the agent config takes it. Default is the DGX Spark's vLLM Qwen3.6. */
const MODEL = process.env.SMOKE_MODEL ?? "192.168.178.40:8000/qwen3.6-35b"
/** A model on a home LAN answers in tens of seconds, not hundreds of milliseconds. */
const TURN_MS = Number(process.env.SMOKE_TURN_MS ?? 240_000)

type Json = Record<string, unknown>

const call = async (method: string, route: string, body?: unknown): Promise<Json> => {
  const response = await fetch(`${URL_BASE}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}`)
  const text = await response.text()
  return text ? (JSON.parse(text) as Json) : {}
}

/**
 * The rows of a list response.
 *
 * ⚠️ Two shapes exist in this API and a smoke must survive both: `/api/agent` answers
 * `{location, data: [...]}` while the message route answers `{data: {data: [...]}}`. Assuming one
 * cost this file a red run that looked like a product failure and was a reader bug.
 */
const rowsOf = (payload: Json): ReadonlyArray<Json> => {
  const data = payload["data"]
  if (Array.isArray(data)) return data as Json[]
  const inner = (data as Json | undefined)?.["data"]
  return Array.isArray(inner) ? (inner as Json[]) : []
}

const reachable = async (): Promise<string | undefined> => {
  try {
    await call("GET", "/api/agent")
  } catch {
    return `no instance at ${URL_BASE} — start one with \`bun run dev\``
  }
  const host = MODEL.split("/")[0] ?? ""
  try {
    const probe = await fetch(`http://${host}/v1/models`, { signal: AbortSignal.timeout(8_000) })
    if (!probe.ok) return `model host ${host} answered ${probe.status}`
  } catch {
    return `model host ${host} is unreachable`
  }
  return undefined
}

const skip = await reachable()
if (skip !== undefined) console.warn(`[agent-officer-live] SKIPPED — ${skip}`)

/** Configure one officer. Returns nothing; the roster is read back where it matters. */
const officer = (id: string, fields: Json) => call("PATCH", "/config", { agents: { [id]: { ...fields, model: MODEL } } })

const openChat = async (agent: string): Promise<string> => {
  const created = await call("POST", "/api/session", { agent, title: `${agent} smoke` })
  return String((created["data"] as Json)["id"])
}

/**
 * Send a prompt and wait for the turn to actually END.
 *
 * ⚠️ **The end of a turn is a STATE, not a pause.** The first version waited for the message count to
 * stop moving for fifteen seconds and called that settled — which is a proxy, and a bad one against a
 * model that takes ~40s per step. It read half-finished turns as finished: a session whose last
 * message was `finish: "tool-calls"` (still mid-chain) counted as done, so a fleet that had spawned
 * two of six looked like a fleet of two, and the assertions failed as though the product had. Three
 * of these tests passed once and then failed on the same code, which is what a proxy signal buys you.
 *
 * A turn is over when the LAST assistant message stops asking for more work — `finish` is `stop`
 * (spoke and finished) or `error` (died). `tool-calls` means the runner is still going.
 */
const turn = async (session: string, text: string): Promise<ReadonlyArray<Json>> => {
  await call("POST", `/api/session/${session}/prompt`, { prompt: { text, files: [], agents: [] } })
  const deadline = Date.now() + TURN_MS
  while (Date.now() < deadline) {
    await Bun.sleep(5_000)
    const rows = rowsOf(await call("GET", `/api/session/${session}/message?limit=80`))
    const assistants = rows.filter((row) => row["type"] === "assistant")
    const finish = assistants.at(-1)?.["finish"]
    if (finish === "stop" || finish === "error") return rows
  }
  throw new Error(`turn did not finish within ${TURN_MS}ms`)
}

const toolCalls = (rows: ReadonlyArray<Json>, name: string) =>
  rows
    .filter((row) => row["type"] === "assistant")
    .flatMap((row) => ((row["content"] as Json[]) ?? []).filter((part) => part["type"] === "tool"))
    .filter((part) => (part["name"] ?? (part["state"] as Json)?.["name"]) === name)

const completed = (calls: ReadonlyArray<Json>) => calls.filter((c) => (c["state"] as Json)?.["status"] === "completed")

const spoken = (rows: ReadonlyArray<Json>) =>
  rows
    .filter((row) => row["type"] === "assistant")
    .flatMap((row) => ((row["content"] as Json[]) ?? []).filter((part) => part["type"] === "text"))
    .map((part) => String(part["text"] ?? ""))
    .join("\n")

describe.skipIf(skip !== undefined)("an officer with a real model", () => {
  test(
    "follows a direct order to spawn a FLEET",
    async () => {
      await officer("smoke_marshal", {
        name: "SmokeMarshal",
        title: "Fleet Coordinator",
        mode: "primary",
        directory: "C:/Users/nangl/d/code/llm",
        permissionMode: "bypass",
        system:
          "You are a coordinator. When work splits into independent parts you spawn one sub-agent per part and let them work in parallel. You do not do the parts yourself.",
      })
      const chat = await openChat("smoke_marshal")
      const rows = await turn(
        chat,
        "The file notes/attic/test-3e-monster-manual-iii.txt is about 26000 lines of monster entries. " +
          "Spawn a fleet of 6 sub-agents, each summarising a different sixth of the file, and tell me you have " +
          "done it. Do not summarise it yourself.",
      )

      const spawns = toolCalls(rows, "spawn")
      // 🔴 SIX, and all of them successful. The first measured run made six calls that ALL failed with
      // "Unknown tool: spawn" — the set gate had withheld the tool because the order says "each" — so
      // counting calls alone would have reported that failure as a pass.
      expect({ calls: spawns.length, completed: completed(spawns).length }).toEqual({ calls: 6, completed: 6 })
      // ⚠️ And it delegated rather than doing the work: no `read` of the manual itself.
      expect(spoken(rows).toLowerCase()).not.toContain("monster manual iii is a")
    },
    TURN_MS + 60_000,
  )

  test(
    "puts a private note in its OWN workspace, not the project it was assigned",
    async () => {
      await officer("smoke_scribe", {
        name: "SmokeScribe",
        title: "Note taker",
        mode: "primary",
        directory: "C:/Users/nangl/d/code/llm/novaclaw",
        permissionMode: "bypass",
        system: "You are a note taker. You keep working notes for the team.",
      })
      const roster = rowsOf(await call("GET", "/api/agent"))
      const workspace = String(roster.find((r) => r["id"] === "smoke_scribe")?.["workspace"] ?? "")
      expect(workspace).toContain("scratch")

      const chat = await openChat("smoke_scribe")
      const rows = await turn(
        chat,
        'I want a scratch note that is NOT part of this project: write a file called smoke-note.md containing the ' +
          'single line "workspace reachable", somewhere that belongs to you rather than to the project I assigned ' +
          "you. Then tell me the full path you used.",
      )

      // 🔴 The claim: the model KNEW it had a second folder. Before `workspaceSection` the prompt named
      // only the project, and the only honest thing a model could do was write there.
      const writes = toolCalls(rows, "write")
      const paths = writes.map((c) => String(((c["state"] as Json)?.["input"] as Json)?.["path"] ?? ""))
      const normalise = (value: string) => value.replaceAll("\\", "/").toLowerCase()
      expect(paths.some((p) => normalise(p).includes(normalise(workspace)))).toBe(true)
      // …and NOT into the assigned project.
      expect(paths.some((p) => normalise(p).includes("/d/code/llm/novaclaw/smoke-note"))).toBe(false)
    },
    TURN_MS + 60_000,
  )

  test(
    "🔴 a spawned SUB-AGENT runs on its officer's model, not the instance default",
    async () => {
      // The defect this guards, measured 2026-08-23: six sub-agents spawned correctly and every one
      // ran as the INSTANCE DEFAULT, against a provider that had been down for days, while the
      // officer reported the fleet launched. A child stores `agent: null` and inherits its officer
      // through the parent chain; `SessionEffectiveConfig` was folding the colleague from the session
      // ROW, so the child lost its officer's model, floor, memory stance and posture.
      //
      // ⚠️ Only a LIVE run sees this. Every unit test passed throughout, because for a root chat the
      // row and the chain agree — it is exactly the case a fleet creates that they do not.
      await officer("smoke_inherit", {
        name: "SmokeInherit",
        title: "Coordinator",
        mode: "primary",
        permissionMode: "bypass",
        system: "You are a coordinator. You spawn sub-agents for independent work.",
      })
      const chat = await openChat("smoke_inherit")
      const rows = await turn(
        chat,
        'Spawn 2 sub-agents in parallel. Give each one this exact task: reply with the single word ACK ' +
          "and stop. Then tell me you have done it.",
      )
      expect(completed(toolCalls(rows, "spawn")).length).toBeGreaterThanOrEqual(1)

      const children = rowsOf(await call("GET", "/api/session?limit=80")).filter(
        (row) => String(row["parentID"] ?? "") === chat,
      )
      expect(children.length).toBeGreaterThanOrEqual(1)

      // What the CHILD actually ran on. The officer's model is `MODEL` (`providerID/modelID`), and the
      // child's assistant message records the model that served it.
      const [providerID, ...rest] = MODEL.split("/")
      const modelID = rest.join("/")
      for (const child of children.slice(0, 2)) {
        const messages = rowsOf(await call("GET", `/api/session/${String(child["id"])}/message?limit=20`))
        const assistant = messages.find((row) => row["type"] === "assistant")
        const ran = (assistant?.["model"] ?? {}) as Json
        expect({ provider: ran["providerID"], id: ran["id"] }).toEqual({ provider: providerID, id: modelID })
      }
    },
    TURN_MS + 60_000,
  )

  test(
    "hands work to a COLLEAGUE and is told where the answer arrives",
    async () => {
      await officer("smoke_aris", {
        name: "SmokeAris",
        title: "Coordinator",
        mode: "primary",
        permissionMode: "bypass",
        system: "You are a coordinator. Work that belongs to another colleague goes to them.",
      })
      await officer("smoke_theron", {
        name: "SmokeTheron",
        title: "Bookkeeper",
        mode: "primary",
        permissionMode: "bypass",
        system: "You are the bookkeeper. You own the ledger.",
      })
      // The recipient needs an open chat — a colleague with nowhere to receive is a fact, not a failure,
      // and `deliver` reports it as such.
      await openChat("smoke_theron")

      const chat = await openChat("smoke_aris")
      const rows = await turn(
        chat,
        "Ask smoke_theron, our bookkeeper, whether the ledger balanced this month. Use the colleague tool. " +
          "Do not answer it yourself.",
      )

      const asks = completed(toolCalls(rows, "colleague"))
      expect(asks.length).toBeGreaterThanOrEqual(1)
      // 🔴 The DEFECT this pins is a false promise, so it is asserted as a negative. Measured
      // 2026-08-21: told only that the colleague "answers in their own time", the model told the user
      // *"I'll relay the answer to you"* — and nothing could keep that promise. The note now says the
      // reply arrives in this chat as a message from them.
      //
      // ⚠️ Asserted on SUBSTANCE, not wording. The first version of this test looked for the literal
      // "their own chat"/"here"/"later" and went red on *"They're working on it and will reply in
      // their own time. You'll see their answer come through as a message from them"* — which is
      // exactly right. A live smoke that pins a model's phrasing measures the phrasing.
      const said = spoken(rows).toLowerCase()
      expect(said).toMatch(/reply|answer|respond/)
      for (const promise of ["i'll relay", "i will relay", "i'll forward", "i will forward", "let you know once"])
        expect({ promise, present: said.includes(promise) }).toEqual({ promise, present: false })
    },
    TURN_MS + 60_000,
  )
})

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
 *
 * ⚠️ **Every task here is deliberately TINY, and that is a safety property rather than laziness.**
 * Each spawned sub-agent is a session worker; six of them holding a sixth of a 1 MB file each took the
 * dev instance down twice with `oh no: Bun has crashed … multiple threads are crashing`, and the
 * resulting red then reads as a product defect instead of as the host running out of room. A smoke
 * that can crash its own host is not a smoke. Keep the SHAPE (how many workers, whether they start,
 * whose model they run on) and keep the payload one breath long; the 1 MB fan-out belongs in a
 * hand-driven run where somebody is watching the machine.
 */

const URL_BASE = process.env.NOVACLAW_URL ?? "http://127.0.0.1:4096"
/** `providerID/modelID` as the agent config takes it. Default is the DGX Spark's vLLM Qwen3.6. */
const MODEL = process.env.SMOKE_MODEL ?? "192.168.178.40:8000/qwen3.6-35b"
/**
 * How long one TURN may take.
 *
 * ⚠️ Ten minutes, because a fleet turn is not one model call. Measured: the officer spawns six
 * sub-agents, then `wait`s on all six, then writes up their results — six inferences of its own plus
 * six children's, on a home-LAN model. At 240s this timed out three times and the failures read as
 * "the officer never spawned", when the transcript showed it had spawned, collected AND reported.
 * A budget that cannot cover the behaviour under test measures the budget.
 */
const TURN_MS = Number(process.env.SMOKE_TURN_MS ?? 600_000)

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
  // Resolve the provider through the INSTANCE's own catalog — the only place that knows which
  // endpoint a providerID names.
  //
  // ⚠️ This was parsing a HOST out of the model ref, and the sibling `agent-pipeline-live.smoke.ts`
  // had already replaced that with the catalog lookup below. The fix landed in one copy and not the
  // other, and the decay was SILENT in the worst way: a providerID that is a catalog key rather than
  // a `host:port` — which every real one now is — made this probe fail, so the whole file SKIPPED
  // with "model host spark-qwen38 is unreachable". Green suite, zero live colleague coverage, and
  // nothing anywhere saying so. Measured 2026-08-24 while trying to drive group chats live.
  const providerID = MODEL.split("/")[0] ?? ""
  const catalog = rowsOf(await call("GET", "/api/provider"))
  const provider = catalog.find((row) => row["id"] === providerID)
  if (!provider) {
    const known = catalog.map((row) => String(row["id"])).join(", ")
    return `provider "${providerID}" is not in this instance's catalog (has: ${known})`
  }
  const url = String(((provider["api"] as Json | undefined)?.["url"] as string | undefined) ?? "")
  try {
    const probe = await fetch(`${url}/models`, { signal: AbortSignal.timeout(8_000) })
    if (!probe.ok) return `model endpoint ${url} answered ${probe.status}`
  } catch {
    return `model endpoint ${url} is unreachable`
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
    // ⚠️ **Ordered by `seq`, never by array position.** This route answers NEWEST FIRST, so `.at(-1)`
    // is the OLDEST message — which mid-fleet is the `tool-calls` step that started the spawns. The
    // helper therefore never saw the `stop` that had already arrived, and burned the entire ten-minute
    // budget on a turn that finished in under a minute. Twice, and both times the red read as "the
    // officer never spawned" while the transcript showed three completed spawns and a reported list of
    // session ids. Sorting explicitly is immune to which end the API puts the newest at.
    const assistants = rows
      .filter((row) => row["type"] === "assistant")
      .toSorted((a, b) => Number(a["seq"] ?? 0) - Number(b["seq"] ?? 0))
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
        permissionMode: "bypass",
        system:
          "You are a coordinator. When work splits into independent parts you spawn one sub-agent per part and let them work in parallel. You do not do the parts yourself.",
      })
      const chat = await openChat("smoke_marshal")
      // ⚠️ **THREE, and each task one breath long — both learned the hard way, on the owner's machine.**
      //
      // The first version handed each of SIX sub-agents a sixth of a 1 MB file to summarise: the
      // owner's original scenario, faithful, and a LOAD test. It took the dev instance down mid-run
      // with `oh no: Bun has crashed … multiple threads are crashing`, twice, and the failures then
      // read as product defects rather than as the host running out of room.
      //
      // Trimming the payload was not enough. Six live children still spiked the box to 57 GB of a
      // 57 GB commit limit — two bun processes at 6.7 GB each — and the owner felt it: *"that is a bit
      // too many buns eating too much memory"*. Every spawned child is a session worker, so the count
      // IS the memory.
      //
      // What this test is for is the SHAPE: a direct order produces a fleet, every worker starts, and
      // the officer collects. Three shows all of that. Six is the hand-driven reproduction, run when
      // somebody is watching the machine — see `notes/named-agents.md`.
      const rows = await turn(
        chat,
        "Spawn 3 sub-agents in parallel. Give each one this exact task: reply with the single word ACK " +
          "and stop. Do NOT wait for them — just tell me the session ids you started. Do not do the " +
          "task yourself.",
      )

      const spawns = toolCalls(rows, "spawn")
      // 🔴 SIX, and all of them successful. The first measured run made six calls that ALL failed with
      // "Unknown tool: spawn" — the set gate had withheld the tool because the order says "each" — so
      // counting calls alone would have reported that failure as a pass.
      expect({ calls: spawns.length, completed: completed(spawns).length }).toEqual({ calls: 3, completed: 3 })

      // ⚠️ **The COLLECT step is deliberately not asserted here, and it is not missing.** It works:
      // measured 2026-08-23, an officer given the same order without the "do not wait" clause made six
      // `spawn` calls, six `wait` calls, and wrote up a results table — the whole fleet lifecycle. But
      // `wait` blocks up to ten minutes PER CHILD by design, so a collecting turn ran 603 seconds and
      // blew a ten-minute budget. Asserting it here would make the suite's runtime a function of how
      // fast the model feels, which is how a smoke becomes something people skip.
      //
      // So this test pins the half that is fast and deterministic — the order produces a fleet, and
      // every worker starts. The join has its own five cases in `session-join-deadlock.test.ts`, on
      // the real clock and in six seconds.
      expect(spoken(rows)).toBeTruthy()
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
      // 🔴 CHILDREN FROM THIS RUN ONLY, and one-chat-per-agent is why this is not paranoia.
      //
      // `openChat` returns the agent's EXISTING chat — that is the invariant working — so every run
      // of this smoke hangs its sub-agents off the same parent, and they accumulate. Selecting by
      // list order then reads whichever the API happened to return first, which on 2026-08-24 was a
      // pair from the day before that had run on the old instance default. The test went red naming
      // a defect that had been FIXED, while this run's own children were correct.
      //
      // ⚠️ That is the expensive direction of wrong: a live smoke reporting a regression that is not
      // there costs an investigation, and doing it twice teaches people to ignore it.
      const startedAt = Date.now()
      const rows = await turn(
        chat,
        'Spawn 2 sub-agents in parallel. Give each one this exact task: reply with the single word ACK ' +
          "and stop. Then tell me you have done it.",
      )
      expect(completed(toolCalls(rows, "spawn")).length).toBeGreaterThanOrEqual(1)

      const createdAt = (row: Json): number => {
        const time = (row["time"] ?? {}) as Json
        const created = time["created"] ?? row["time_created"]
        return typeof created === "number" ? created : 0
      }
      const children = rowsOf(await call("GET", "/api/session?limit=80"))
        .filter((row) => String(row["parentID"] ?? "") === chat)
        // A second of slack: the child row is written a beat before the turn's clock is read here.
        .filter((row) => createdAt(row) >= startedAt - 1_000)
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

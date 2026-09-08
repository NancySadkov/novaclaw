import { describe, expect, test } from "bun:test"

/**
 * LIVE: a THREE-OFFICER PIPELINE, and Nova reviewing the pipeline itself.
 *
 * The scenario is deliberately an ordinary job rather than a capability demo — a manuscript is
 * written, edited, published, and then the org's own process is reviewed by its CEO:
 *
 *   1. **writer**    drafts a four-line manuscript into its own workspace.
 *   2. **editor**    reads the writer's file, and approves it or asks for one change.
 *   3. **publisher** converts the approved text to a real PDF with the ImageMagick we ship.
 *   4. **Nova**      reads what the three of them did and reviews the PIPELINE — what went wrong,
 *                    and what could be done in fewer steps.
 *
 * 🔴 **The load-bearing assertion is the INVARIANT, not the artifacts.** After a four-agent pipeline
 * has run to completion, each of the four still has exactly ONE root session. That is the claim no
 * unit test can make: `session-one-chat-per-agent.test.ts` proves the guard at the seam, and this
 * proves that nothing in a real run — prompting, tool use, hand-off, sub-agent spawning, a scheduled
 * fire — reaches around it. One session per agent, and the only extra sessions are anonymous
 * sub-agents in direct subjugation to whoever spawned them (owner, 2026-08-23).
 *
 * Run:  bun test ./test/agent-pipeline-live.smoke.ts
 *
 * ⚠️ Needs a RUNNING instance and a reachable model; both are checked first and the file SKIPS with a
 * reason rather than failing, because a red that only means "nothing was running" trains people to
 * ignore the smoke. Point it elsewhere with NOVACLAW_URL / SMOKE_MODEL.
 *
 * ⚠️ **Every payload is one breath long, and that is a safety property.** The sibling
 * `agent-officer-live.smoke.ts` records six sub-agents holding a sixth of a 1 MB file each taking the
 * dev instance down twice. A smoke that can crash its own host is not a smoke. Keep the SHAPE — four
 * agents, a real file, a real PDF — and keep the manuscript four lines.
 *
 * ⚠️ **The hand-off is through ARTIFACTS, not the `colleague` tool, and that is deliberate.** Each
 * officer consumes the previous one's file, which is a real dependency and a real pipeline. Routing
 * the hand-off through colleague-messaging as well would put two unrelated mechanisms on one critical
 * path, so a flake in either would read as a pipeline failure. Messaging has its own live coverage in
 * `agent-officer-live.smoke.ts`.
 */

const URL_BASE = process.env.NOVACLAW_URL ?? "http://127.0.0.1:4096"
/**
 * `providerID/modelID` as the agent config takes it — the Spark's SGLang Qwen3.8-27B.
 *
 * ⚠️ **The providerID is a CATALOG KEY, not a host**, and getting that wrong is silent. A first draft
 * used `192.168.178.40:8010/qwen3.8-27b` — the address the model is actually served on — and every
 * turn ended in 20 s with EMPTY assistant text, which reads as a broken model rather than an
 * unresolvable reference. The same endpoint is keyed `spark-qwen38` in this store and
 * `192-168-178-40-8010-v1` in the packaged app's: from-source runs open their own database
 * (`novaclaw-local.db`) with their own provider catalog, so a ref copied between the two does not
 * resolve. `reachable()` below now derives the URL from the catalog instead of parsing the ref.
 */
const MODEL = process.env.SMOKE_MODEL ?? "spark-qwen38/qwen3.8-27b"
/** One turn's budget. A publish step shells out, so it is not one model call. */
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

/** ⚠️ Two envelope shapes exist in this API; a smoke must survive both (see the sibling smoke). */
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
  // endpoint a providerID names. Probing a host parsed out of the ref would have answered "healthy"
  // for a reference the runner cannot resolve, which is precisely the failure this replaced.
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
if (skip !== undefined) console.warn(`[agent-pipeline-live] SKIPPED — ${skip}`)

const officer = (id: string, fields: Json) => call("PATCH", "/config", { agents: { [id]: { ...fields, model: MODEL } } })

/**
 * The agent's ONE chat.
 *
 * ⚠️ Deliberately calls `POST /api/session` even when the agent already has one, because that is the
 * invariant under test: the server must hand back the existing session rather than mint a sibling.
 */
const chatFor = async (agent: string): Promise<string> => {
  const created = await call("POST", "/api/session", { agent, title: `${agent} pipeline` })
  return String((created["data"] as Json)["id"])
}

/** Every LIVE ROOT session belonging to an agent — the invariant's measurement. */
const rootsFor = async (agent: string): Promise<ReadonlyArray<Json>> => {
  const rows = rowsOf(await call("GET", "/api/session?limit=200"))
  return rows.filter((r) => r["agent"] === agent && !r["parentID"] && !(r["time"] as Json)?.["archived"])
}

/** Send a prompt and wait for the turn to END — a STATE (`finish`), never a pause. */
const turn = async (session: string, text: string): Promise<ReadonlyArray<Json>> => {
  // 🔴 The high-water mark BEFORE prompting, so every assertion is about THIS turn.
  //
  // ⚠️ Under one-chat-per-agent a colleague's session is durable and survives the run, so a second
  // execution of this smoke prompts into a chat that already contains the first run's answers.
  // Without this the reply from a PREVIOUS run satisfies `expect(said(...)).toContain("manuscript.txt")`
  // and the smoke goes green having proved nothing — a confirming run that carries no information.
  // The invariant made the harness's own statefulness a correctness problem.
  const before = rowsOf(await call("GET", `/api/session/${session}/message?limit=80`))
  const mark = Math.max(0, ...before.map((r) => Number(r["seq"] ?? 0)))
  await call("POST", `/api/session/${session}/prompt`, { prompt: { text, files: [], agents: [] } })
  const deadline = Date.now() + TURN_MS
  while (Date.now() < deadline) {
    await Bun.sleep(5_000)
    const all = rowsOf(await call("GET", `/api/session/${session}/message?limit=80`))
    const rows = all.filter((r) => Number(r["seq"] ?? 0) > mark)
    // ⚠️ Ordered by `seq`, never array position — this route answers NEWEST FIRST.
    const assistants = rows
      .filter((row) => row["type"] === "assistant")
      .toSorted((a, b) => Number(a["seq"] ?? 0) - Number(b["seq"] ?? 0))
    const finish = assistants.at(-1)?.["finish"]
    if (finish === "stop" || finish === "error") return rows
  }
  throw new Error(`turn did not settle within ${TURN_MS}ms`)
}

/**
 * What the agent SPOKE, lowercased — for "did it actually say X" assertions.
 *
 * ⚠️ **`content` parts, not `row.text`.** Only USER rows carry `text`; an assistant row carries a
 * `content` array of parts. Reading `row["text"]` returned `undefined` for every assistant message,
 * so a turn that had worked perfectly asserted as `""` — which reads as a dead model rather than a
 * broken reader. It cost two full live runs before the row was dumped and the shape checked.
 *
 * ⚠️ And only `type: "text"` parts. A thinking model also emits `type: "reasoning"`; asserting over
 * those would pass on the model's private deliberation rather than on what it actually said.
 */
const said = (rows: ReadonlyArray<Json>): string =>
  rows
    .filter((r) => r["type"] === "assistant")
    .flatMap((r) => ((r["content"] as Json[]) ?? []).filter((part) => part["type"] === "text"))
    .map((part) => String(part["text"] ?? ""))
    .join("\n")
    .toLowerCase()

const PIPELINE = ["writer", "editor", "publisher", "nova"] as const

describe.skipIf(skip !== undefined)("a manuscript through three officers, reviewed by Nova", () => {
  test(
    "the pipeline runs, and every agent still has exactly ONE session",
    async () => {
      // Three officers with real, different jobs. Nova is not configured here — it ships seeded, and
      // a config write naming it is refused at the store, which is the point of it being the floor.
      await officer("writer", {
        name: "Wren",
        title: "Staff writer",
        personality: "Writes plainly and briefly. Never pads.",
      })
      await officer("editor", {
        name: "Edda",
        title: "Editor",
        personality: "Approves what is fit to publish and says plainly what is not.",
      })
      await officer("publisher", {
        name: "Pell",
        title: "Publisher",
        personality: "Turns approved text into files people can open.",
      })

      const writer = await chatFor("writer")
      const editor = await chatFor("editor")
      const publisher = await chatFor("publisher")

      // 1 — the manuscript. Four lines, on purpose (see the header's payload warning).
      const drafted = await turn(
        writer,
        "Write a FOUR-LINE short story titled 'The Lighthouse Keeper'. " +
          "Save it in your own workspace as manuscript.txt. Reply with the absolute path, nothing else.",
      )
      expect(said(drafted)).toContain("manuscript.txt")

      // 2 — the edit. The editor must READ the writer's file: a real dependency, not a retelling.
      const edited = await turn(
        editor,
        "Wren has drafted a manuscript at their workspace as manuscript.txt. Find and read it. " +
          "If it is fit to publish, write the word APPROVED on the first line of approved.txt in your " +
          "own workspace, followed by the manuscript text. Reply with the absolute path of approved.txt.",
      )
      expect(said(edited)).toContain("approved.txt")

      // 3 — the PDF, with the ImageMagick this build ships. Verified by hand 2026-08-23:
      // `magick -density 150 text:in.txt out.pdf` produces a 74 KB file starting `%PDF-`.
      // ⚠️ `text:` is load-bearing — bare `in.txt` makes IM read its own pixel-dump TXT format and
      // fail with "improper image header", which reads as a broken tool rather than a wrong verb.
      const published = await turn(
        publisher,
        "Edda approved a manuscript at their workspace as approved.txt. Find it, then convert it to " +
          "a PDF named manuscript.pdf in your own workspace using ImageMagick: " +
          "magick -density 150 text:<approved.txt> <manuscript.pdf>. " +
          "Then confirm the PDF exists and reply with its absolute path.",
      )
      const publishedText = said(published)
      expect(publishedText).toContain("manuscript.pdf")

      // 4 — Nova reviews the PIPELINE, not the story. The claim is that the CEO can see the org's
      // process; a review that never names the officers is not a review of them.
      const nova = await chatFor("nova")
      const review = await turn(
        nova,
        "Three colleagues just ran a pipeline: Wren wrote a manuscript, Edda approved it, Pell " +
          "published it as a PDF. Review the PIPELINE itself, not the story. Name any problems you " +
          "see and one way it could be done in fewer steps. Be brief.",
      )
      const reviewText = said(review)
      expect(reviewText.length).toBeGreaterThan(80)
      // It reviewed OUR pipeline, not a generic one: it names at least two of the three officers.
      const named = ["wren", "edda", "pell"].filter((who) => reviewText.includes(who)).length
      expect(named).toBeGreaterThanOrEqual(2)

      // 🔴 THE INVARIANT, after a real four-agent run. Every one of them was prompted, used tools and
      // wrote files; `chatFor` asked the server for a session for each of them a second time above.
      // Exactly one live root each, or something reached around the seam.
      for (const agent of PIPELINE) {
        const roots = await rootsFor(agent)
        expect({ agent, roots: roots.length }).toEqual({ agent, roots: 1 })
      }
    },
    TURN_MS * 5,
  )
})

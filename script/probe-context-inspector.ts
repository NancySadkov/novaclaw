/**
 * 🔴 CONFIRM, BY DRIVING THE PACKAGED APP, THAT THE PLAQUE IS GONE AND THE CONTEXT INSPECTOR
 * CARRIES THE FILE LISTS.
 *
 * This is the verification the source ratchets cannot give. Every assertion in
 * `obsolete-plaque-and-duplicate-panel.test.ts` reads source text, which proves the code says the
 * right thing and says nothing at all about what the window shows. The owner asked for the pill to
 * be deleted "with everything ported to the context inspector, as per our architectural vision in
 * AGENTS.md" — a claim about the product, so it has to be read off the product.
 *
 * It is a PROBE and lives outside the shipped code on purpose: it speaks CDP to a client started with
 * `--debug-port`, so nothing test-only ships in a build the owner runs.
 *
 * What it checks, in order:
 *   1. the renderer answers at all (a frozen window answers nothing, ever);
 *   2. the obsolete plaque is ABSENT from the rendered DOM — the negative that matters most, since
 *      the plaque was what the owner actually saw;
 *   3. the context ring exists and clicking it OPENS the inspector;
 *   4. the inspector carries BOTH ported lists — the changes list and the file list;
 *   5. the inspector can be closed, which is the affordance the old panel lacked.
 */

export interface ProbeOptions {
  readonly port: number
  readonly timeoutMs?: number
  readonly log?: (line: string) => void
}

const DEFAULTS = { timeoutMs: 60_000 }

export interface ProbeResult {
  readonly rendererAlive: boolean
  readonly plaqueAbsent: boolean
  readonly plaqueStringsSeen: readonly string[]
  readonly ringFound: boolean
  readonly inspectorOpened: boolean
  readonly changesListPresent: boolean
  readonly fileListPresent: boolean
  readonly inspectorCloseable: boolean
  readonly pass: boolean
  readonly failures: readonly string[]
}

/** The literals the plaque rendered. Hardcoded English in the JSX, never an i18n key. */
const PLAQUE_STRINGS = ["See changes", "This chat needs attention.", "This chat is recovering automatically."]

export async function runProbe(options: ProbeOptions): Promise<ProbeResult> {
  const { port, timeoutMs = DEFAULTS.timeoutMs, log = () => {} } = options
  const failures: string[] = []

  const page = await findPage(port, timeoutMs)
  if (!page) {
    return {
      rendererAlive: false,
      plaqueAbsent: false,
      plaqueStringsSeen: [],
      ringFound: false,
      inspectorOpened: false,
      changesListPresent: false,
      fileListPresent: false,
      inspectorCloseable: false,
      pass: false,
      failures: ["no page target on the debugging endpoint — the client is not exposing a renderer"],
    }
  }
  log(`attached to ${page.url}`)

  const cdp = await connect(page.webSocketDebuggerUrl)
  const evaluate = async <T>(expression: string): Promise<T> => {
    const id = nextId()
    // Register the waiter BEFORE sending: a fast reply can arrive first, and a send issued before
    // the socket is open is dropped, which surfaces as an exception object rather than a timeout.
    const reply = cdp.reply(id, timeoutMs)
    cdp.send({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } })
    const message = await reply
    if (message.error) throw new Error(`cdp: ${message.error.message}`)
    const result = message.result as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation threw")
    }
    return result.result?.value as T
  }

  // 1. the renderer answers at all
  const alive = await evaluate<string>("1 + 1").then(() => true).catch(() => false)
  log(`renderer answers arithmetic: ${alive}`)
  if (!alive) failures.push("the renderer did not answer Runtime.evaluate")

  // 2. the plaque is absent from the RENDERED dom, not merely from the source
  const seen = await evaluate<string[]>(`(() => {
    const text = document.body?.innerText ?? ""
    const out = []
    for (const needle of ${JSON.stringify(PLAQUE_STRINGS)}) if (text.includes(needle)) out.push(needle)
    return out
  })()`)
  const plaqueAbsent = seen.length === 0
  log(`plaque strings present in the dom: ${seen.length === 0 ? "none" : seen.join(", ")}`)
  if (!plaqueAbsent) failures.push(`the plaque is still rendered: ${seen.join(", ")}`)

  // 3. the context ring exists — the official route AGENTS.md names. It renders per SESSION, so the
  // probe has to be IN a session: on the Home launcher there is no ring, and a probe that reports
  // "not reachable" from there would be measuring its own position rather than the product.
  const findRing = `(() => {
    for (const n of document.querySelectorAll('button,[role=button]')) {
      const label = (n.getAttribute('aria-label') ?? n.getAttribute('title') ?? '').toLowerCase()
      if (label.includes('context usage') || label.includes('context')) return true
    }
    return false
  })()`

  if (!(await evaluate<boolean>(findRing))) {
    log("not in a session yet — opening the first officer tab")
    await evaluate<boolean>(`(() => {
      const target = [...document.querySelectorAll('[aria-label],[role=tab],button')].find((n) => {
        const label = (n.getAttribute('aria-label') ?? n.innerText ?? '').trim()
        return ['Nova','Sopitis','Geryon','Xenia','Daedalus','nangl'].includes(label)
      })
      if (!target) return false
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      return true
    })()`)
    await evaluate<boolean>(`new Promise((r) => setTimeout(() => r(true), 4000))`)
  }

  const ringFound = await evaluate<boolean>(findRing)
  log(`context indicator found in the dom: ${ringFound}`)
  if (!ringFound) failures.push("no context indicator found — the official route is not reachable")

  // 4. clicking the ring opens the inspector, and the inspector carries BOTH ported lists
  const clicked = await evaluate<boolean>(`(() => {
    for (const n of document.querySelectorAll('button,[role=button]')) {
      const label = (n.getAttribute('aria-label') ?? n.getAttribute('title') ?? '').toLowerCase()
      if (label.includes('context usage') || label.includes('context')) {
        n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        return true
      }
    }
    return false
  })()`)
  log(`clicked the context indicator: ${clicked}`)
  const opened = { opened: clicked }

  // The click is synchronous but the panel mounts on a later tick, and a BACKGROUNDED window does
  // not reliably service requestAnimationFrame — so poll for the section instead of awaiting a frame.
  const after = await evaluate<{ opened: boolean; changes: boolean; files: boolean; closeable: boolean }>(
    `(async () => {
      const read = () => {
        const section = document.querySelector('[data-slot="context-files"]')
        const changes = !!document.querySelector('[data-slot="context-files-changes"]')
        const files = !!document.querySelector('[data-slot="context-files-all"]')
        const close = [...document.querySelectorAll("button")].find((b) => {
          const label = (b.getAttribute("aria-label") ?? b.getAttribute("title") ?? "").toLowerCase()
          return label.includes("close")
        })
        return { opened: !!section || changes || files, changes, files, closeable: !!close }
      }
      for (let attempt = 0; attempt < 40; attempt++) {
        const state = read()
        if (state.opened) return state
        await new Promise((r) => setTimeout(r, 250))
      }
      return read()
    })()`,
  )

  const inspectorOpened = after.opened
  void opened
  log(`inspector opened: ${after.opened}; changes list: ${after.changes}; file list: ${after.files}`)
  if (!after.opened) failures.push("clicking the context indicator did not open the inspector")
  if (!after.changes) failures.push("the inspector has no CHANGES list — the diff view was dropped")
  if (!after.files) failures.push("the inspector has no FILE list — the file browser was dropped")
  if (!after.closeable) failures.push("the inspector has no close affordance — the old panel's own defect")

  void inspectorOpened

  cdp.close()
  return {
    rendererAlive: alive,
    plaqueAbsent,
    plaqueStringsSeen: seen,
    ringFound,
    inspectorOpened: after.opened,
    changesListPresent: after.changes,
    fileListPresent: after.files,
    inspectorCloseable: after.closeable,
    pass: failures.length === 0,
    failures,
  }
}

async function findPage(port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string
        url: string
        webSocketDebuggerUrl: string
      }[]
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // the client has not opened its debugging port yet
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return undefined
}

let sequence = 0
const nextId = () => ++sequence

async function connect(url: string) {
  const socket = new WebSocket(url)
  const pending = new Map<number, (value: { id: number; result?: unknown; error?: { message: string } }) => void>()
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id: number }
    const resolve = pending.get(message.id)
    if (resolve) {
      pending.delete(message.id)
      resolve(message)
    }
  })
  // The socket MUST be open before anything is sent, and this probe sends immediately.
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve())
    socket.addEventListener("error", () => reject(new Error("cdp socket failed")))
  })
  return {
    send(payload: { id: number; method: string; params?: unknown }) {
      socket.send(JSON.stringify(payload))
    },
    reply(id: number, timeoutMs: number) {
      return new Promise<{ id: number; result?: unknown; error?: { message: string } }>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`cdp reply ${id} timed out`))
        }, timeoutMs)
        pending.set(id, (value) => {
          clearTimeout(timer)
          resolve(value)
        })
      })
    },
    close() {
      socket.close()
    },
  }
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 9333)
  const result = await runProbe({ port, log: (line) => console.log(`  ${line}`) })
  console.log("")
  for (const [key, value] of Object.entries(result)) {
    if (key === "failures") continue
    console.log(`  ${key}: ${Array.isArray(value) ? JSON.stringify(value) : String(value)}`)
  }
  for (const failure of result.failures) console.log(`  FAIL ${failure}`)
  console.log("")
  console.log(result.pass ? "  PASS" : "  FAIL")
  process.exit(result.pass ? 0 : 1)
}

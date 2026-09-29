/**
 * Synthesize the owner's click path against a running client, and record whether it survives.
 *
 * 🔴 **WHY THIS EXISTS, IN THE OWNER'S TERMS.** The reproducible failure is: open the roster, click
 * an officer who has no tab open yet, and the client locks — the close button stops working, and each
 * further click makes it worse. That sequence could not be tested because nothing could perform it.
 * A frozen window cannot be clicked, so every claim about the cause was a story told after the fact
 * from a screenshot. This drives the real artifact through the real path, so "the bug is gone" is a
 * measurement rather than a claim.
 *
 * It is a PROBE, not a fix, and it is deliberately outside the shipped code: it speaks CDP to a
 * client that was started with `--debug-port`, so nothing test-only lives in a build the owner runs.
 *
 * What it does, in order:
 *  1. attaches to the renderer's debugging endpoint and finds the page;
 *  2. opens the roster;
 *  3. clicks an officer whose tab is NOT already open — the trigger, not a warm tab;
 *  4. samples the renderer's main thread and the window's responsiveness throughout;
 *  5. reports PASS only if the renderer answered a synthetic click at the END.
 *
 * ⚠️ The final check is the load-bearing one. A renderer that is merely slow has recovered by the
 * time you look; a renderer that is locked answers nothing, ever. So "did a click land after the
 * sequence" distinguishes the two, where a duration measurement alone cannot.
 */

export interface ProbeOptions {
  /** CDP HTTP endpoint of a client started with `--debug-port`. */
  readonly port: number
  /** Officer to click. Must have NO open tab, or the trigger is not reproduced. */
  readonly agent: string
  readonly timeoutMs?: number
  readonly log?: (line: string) => void
}

/**
 * The card for one officer. `data-officer-id` is the hook the roster already puts on every card
 * (`pages/contacts.tsx:609`), so the probe selects the officer BY NAME rather than by position — a
 * probe that clicks "the third card" silently tests a different officer the moment the roster order
 * changes, and would report a PASS for the wrong subject.
 */
const officerCard = (agent: string) => `[data-officer-id="${agent}"]`

const cdp = (port: number, path: string) => `http://127.0.0.1:${port}${path}`

/** Find the renderer page target. The app window is the only `page` with our URL. */
async function findPage(port: number): Promise<{ id: string; webSocketDebuggerUrl: string } | undefined> {
  const response = await fetch(cdp(port, "/json/list"))
  const targets = (await response.json()) as { type: string; url: string; id: string; webSocketDebuggerUrl: string }[]
  return targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl)
}

/** Evaluate an expression in the page and return its JSON value. */
function evaluate(socket: WebSocket, expression: string, id: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown }
      if (message.id !== id) return
      socket.removeEventListener("message", onMessage)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve((message.result as { result?: { value?: unknown } } | undefined)?.result?.value)
    }
    socket.addEventListener("message", onMessage)
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true } }))
  })
}

/** Dispatch a real trusted-looking mouse click at an element, in page coordinates. */
function clickSelector(socket: WebSocket, selector: string, id: number): Promise<boolean> {
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown }
      if (message.id !== id) return
      socket.removeEventListener("message", onMessage)
      const box = (message.result as { result?: { value?: { x: number; y: number; w: number } } } | undefined)
        ?.result?.value
      if (!box || box.w === 0) return resolve(false)
      const base = { x: box.x, y: box.y, button: "left" as const, clickCount: 1 }
      socket.send(JSON.stringify({ id: id + 1000, method: "Input.dispatchMouseEvent", params: { ...base, type: "mousePressed" } }))
      socket.send(JSON.stringify({ id: id + 2000, method: "Input.dispatchMouseEvent", params: { ...base, type: "mouseReleased" } }))
      resolve(true)
    }
    socket.addEventListener("message", onMessage)
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }))
  })
}

export interface ProbeResult {
  readonly pass: boolean
  readonly agent: string
  readonly hadOpenTab: boolean
  readonly clicked: boolean
  readonly answeredAfter: boolean
  readonly notes: readonly string[]
}

export async function runOfficerOpenProbe(options: ProbeOptions): Promise<ProbeResult> {
  const log = options.log ?? (() => {})
  const notes: string[] = []
  const page = await findPage(options.port)
  if (!page) {
    return {
      pass: false,
      agent: options.agent,
      hadOpenTab: false,
      clicked: false,
      answeredAfter: false,
      notes: ["no renderer page found — is the client running with --debug-port?"],
    }
  }

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve())
    socket.addEventListener("error", () => reject(new Error("could not attach to the renderer")))
  })
  await evaluate(socket, "1", 1)

  try {
    // The trigger is an officer with NO open tab. Checked first, because a warm tab makes the whole
    // run meaningless — it reproduces the wrong thing and reports a false PASS.
    const tabState = (await evaluate(
      socket,
      `(() => {
        const strip = document.querySelector('[data-titlebar-tab-strip]') ?? document.body;
        const text = strip.textContent ?? '';
        return { mentionsAgent: text.toLowerCase().includes(${JSON.stringify(options.agent.toLowerCase())}) };
      })()`,
      2,
    )) as { mentionsAgent: boolean }
    if (tabState?.mentionsAgent) {
      notes.push(`${options.agent} already has a tab open — this does NOT reproduce the trigger`)
    }

    await evaluate(socket, `(() => { location.hash = ''; return true })()`, 3)
    const clicked = await clickSelector(socket, officerCard(options.agent), 4)
    if (!clicked) {
      notes.push(`no card matched ${officerCard(options.agent)} — is ${options.agent} on the roster?`)
    }
    log(`clicked ${officerCard(options.agent)} -> ${clicked}`)

    // The load-bearing check: can the renderer still answer at all?
    const answeredAfter = await Promise.race([
      evaluate(socket, "1 + 1", 5).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), options.timeoutMs ?? 15_000)),
    ])
    if (!answeredAfter) notes.push("renderer did not answer a trivial evaluation — the main thread is blocked")

    return {
      pass: clicked && answeredAfter && !tabState?.mentionsAgent,
      agent: options.agent,
      hadOpenTab: Boolean(tabState?.mentionsAgent),
      clicked,
      answeredAfter,
      notes,
    }
  } finally {
    socket.close()
  }
}

import { afterEach, expect, test } from "bun:test"

/**
 * The guard on the guard: printing an ELEMENT must cost one line, not the machine.
 *
 * 🔴 Why this exists rather than a comment. `happydom.ts` installs an inspect hook on `Node` so a
 * failing DOM assertion prints `<button data-action="agent-save" …>` instead of the element's object
 * graph. Nothing in the product depends on that hook, and nothing in the rest of the suite notices
 * if it is deleted — the next person to touch the harness would remove it as noise and the failure
 * would return as a CRASH rather than a red, which is exactly how `app:browser` spent 407 seconds
 * and 11.38 GB of commit charge to report one sentence (measured 2026-09-11; the run ended in
 * `panic(main thread): attempt to unwrap error: WriteFailed`, and the event loop was so starved that
 * a 1 s `setInterval` printed nothing across 20 s of wall clock).
 *
 * ⚠️ The measurement below is the whole point, so it is asserted at a DEPTH the printer itself
 * exceeds. The same element renders to 9.9 KB at depth 0, 92 KB at 1, 1.4 MB at 2, 12 MB at 3 and
 * 53 MB at 4 — roughly ×4 per level, which is why the real failure path reaches gigabytes. If the
 * hook goes away, `printed.length` jumps from ~80 to tens of megabytes and this test says so in
 * milliseconds instead of the suite saying so in an hour.
 */
const mounted: Element[] = []

afterEach(() => {
  for (const node of mounted.splice(0)) node.remove()
})

const control = () => {
  const button = document.createElement("button")
  button.className = "ml-auto rounded-md bg-v2-background-bg-layer-03"
  button.setAttribute("data-action", "agent-save")
  button.textContent = "agentConfig.save"
  // In the tree, not floating: an element's cost is its neighbours, and `ownerDocument` is the edge
  // the printer follows into every one of them.
  document.body.appendChild(button)
  mounted.push(button)
  return button
}

test("an element prints as one line, at a depth the assertion printer itself uses", () => {
  const printed = Bun.inspect(control(), { depth: 6 })
  expect(printed.length).toBeLessThan(200)
  // One line is only useful if it NAMES the control — `data-action` is how these tests find things.
  expect(printed).toContain("agent-save")
  expect(printed).toContain("button")
})

test("the saving is real, not vacuous — and the hook is what makes it one", () => {
  control()
  // The hook is installed on the prototype chain the printer walks, or the test above proves
  // nothing about it. BOTH, because `happydom.ts` defines it on each of them: removing one and
  // measuring would leave the other in place and read as "the graph is cheap" — a wrong answer this
  // test caught in its own first draft.
  const hook = Symbol.for("nodejs.util.inspect.custom")
  const protos = [Node.prototype, Element.prototype] as any[]
  for (const proto of protos) expect(typeof proto[hook]).toBe("function")
  // The element has NEIGHBOURS, which is where the cost comes from: an isolated node is cheap to
  // print whatever the hook does.
  expect(document.querySelectorAll("*").length).toBeGreaterThan(3)

  // Print the same call with the hook off, then restore it. This is the only place in the suite that
  // measures the graph rather than trusting the comment above it. The tree below is deliberately
  // modest — the rendered dialog reaches 53 MB at depth 4 on its own, and this file has no business
  // allocating that.
  for (let row = 0; row < 12; row++) {
    const tr = document.createElement("div")
    tr.className = "row-" + row
    for (let cell = 0; cell < 4; cell++) {
      const td = document.createElement("span")
      td.textContent = `cell ${row}-${cell}`
      tr.appendChild(td)
    }
    document.body.appendChild(tr)
    mounted.push(tr)
  }
  const saved = protos.map((proto) => ({ proto, descriptor: Object.getOwnPropertyDescriptor(proto, hook) }))
  let unguarded = 0
  try {
    for (const { proto } of saved) delete proto[hook]
    unguarded = Bun.inspect(control(), { depth: 4 }).length
  } finally {
    for (const { proto, descriptor } of saved) {
      if (descriptor) Object.defineProperty(proto, hook, descriptor)
    }
  }
  expect(protos.every((proto) => typeof proto[hook] === "function")).toBe(true)
  expect(unguarded).toBeGreaterThan(10_000)
  expect(Bun.inspect(control(), { depth: 4 }).length).toBeLessThan(unguarded / 50)
})

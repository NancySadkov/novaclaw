import { expect, test } from "bun:test"
import { createEffect, createMemo, createResource, createRoot, createSignal } from "solid-js"

// PROBE 1 — reading an ERRORED createResource inside a memo.
// The claim under review: contacts.tsx computes `shown()` (which reads `agents()`) in the
// `<Show when=…>` guard, BEFORE the fallback can consult `agents.error`.
test("reading an errored resource throws where it is read", async () => {
  const result = await new Promise<{ error: unknown; thrown: unknown }>((resolve) => {
    createRoot((dispose) => {
      const [src] = createSignal(1)
      const [res] = createResource(src, async () => {
        throw new Error("listAgents failed")
      })
      const views = createMemo(() => (res() ?? []) as unknown[])
      const shown = createMemo(() => views().length)
      setTimeout(() => {
        let thrown: unknown
        try {
          shown()
        } catch (e) {
          thrown = e
        }
        resolve({ error: res.error, thrown })
        dispose()
      }, 20)
    })
  })
  expect(result.error).toBeInstanceOf(Error)
  expect(result.thrown).toBeInstanceOf(Error)
  expect((result.thrown as Error).message).toBe("listAgents failed")
})

// PROBE 2 — the browser semantics behind `<select value={…}>` with late options.
// Solid compiles `value={expr}` to an effect that assigns `el.value`. Assigning a value that
// matches no <option> silently resets selectedIndex; nothing re-applies it when options arrive.
test("select.value assigned before its option exists is discarded", () => {
  const sel = document.createElement("select")
  const inherit = document.createElement("option")
  inherit.value = ""
  inherit.textContent = "inherit"
  sel.appendChild(inherit)

  // the effect fires as soon as the agent row resolves…
  sel.value = "spark/qwen3.6-35b"
  expect(sel.value).toBe("")

  // …the model list resolves afterwards
  const late = document.createElement("option")
  late.value = "spark/qwen3.6-35b"
  late.textContent = "Qwen"
  sel.appendChild(late)
  expect(sel.value).toBe("")
})

// CONTROL — the `selected`-per-option form used by the neighbouring needsTier/posture selects.
test("selected attribute on a late option is honoured", () => {
  const sel = document.createElement("select")
  const inherit = document.createElement("option")
  inherit.value = ""
  sel.appendChild(inherit)
  const late = document.createElement("option")
  late.value = "spark/qwen3.6-35b"
  late.selected = true
  sel.appendChild(late)
  expect(sel.value).toBe("spark/qwen3.6-35b")
})

// PROBE 3 — does a Solid effect re-run when only the OPTION list changes?
// If not, the select cannot self-heal.
test("the value effect does not re-run when the option list changes", async () => {
  const runs = await new Promise<number>((resolve) => {
    createRoot((dispose) => {
      const [bound] = createSignal("spark/qwen3.6-35b")
      const [, setOptions] = createSignal<string[]>([])
      let count = 0
      createEffect(() => {
        bound()
        count += 1
      })
      setTimeout(() => {
        setOptions(["spark/qwen3.6-35b"])
        setTimeout(() => {
          resolve(count)
          dispose()
        }, 5)
      }, 5)
    })
  })
  expect(runs).toBe(1)
})

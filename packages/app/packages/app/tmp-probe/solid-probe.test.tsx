import { expect, test } from "bun:test"
import { createMemo, createResource, createRoot, createSignal, For, Show } from "solid-js"
import { render } from "solid-js/web"

// PROBE 1 — does reading an ERRORED resource inside a memo throw?
// This is the claim behind "contacts.loadFailed is unreachable".
test("reading an errored resource throws out of the memo", async () => {
  let thrown: unknown
  await createRoot(async (dispose) => {
    const [src] = createSignal(1)
    const [res] = createResource(src, async () => {
      throw new Error("boom")
    })
    const views = createMemo(() => (res() ?? []) as unknown[])
    const shown = createMemo(() => views().length)
    await new Promise((r) => setTimeout(r, 10))
    expect(res.error).toBeInstanceOf(Error)
    try {
      shown()
    } catch (e) {
      thrown = e
    }
    dispose()
  })
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toBe("boom")
})

// PROBE 2 — <select value={...}> when the OPTIONS arrive after the value.
test("select value set before its options exist is lost", async () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const [opts, setOpts] = createSignal<string[]>([])
  const [bound] = createSignal("openai/gpt-x")
  const dispose = render(
    () => (
      <select id="probe" value={bound()}>
        <option value="">inherit</option>
        <For each={opts()}>{(o) => <option value={o}>{o}</option>}</For>
      </select>
    ),
    host,
  )
  const el = host.querySelector("select") as HTMLSelectElement
  // value was set while only the "" option existed
  expect(el.value).toBe("")
  // options arrive later (the models list resolving)
  setOpts(["openai/gpt-x"])
  await new Promise((r) => setTimeout(r, 0))
  // ...and nothing re-applies the bound value
  expect(el.value).toBe("")
  dispose()
})

// CONTROL — the `selected`-per-option form the neighbouring field uses survives the same race.
test("selected-per-option survives late options", async () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const [opts, setOpts] = createSignal<string[]>([])
  const bound = () => "openai/gpt-x"
  const dispose = render(
    () => (
      <select>
        <option value="" selected={bound() === ""}>inherit</option>
        <For each={opts()}>{(o) => <option value={o} selected={bound() === o}>{o}</option>}</For>
      </select>
    ),
    host,
  )
  const el = host.querySelector("select") as HTMLSelectElement
  setOpts(["openai/gpt-x"])
  await new Promise((r) => setTimeout(r, 0))
  expect(el.value).toBe("openai/gpt-x")
  dispose()
})

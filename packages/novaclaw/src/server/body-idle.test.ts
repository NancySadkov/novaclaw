import { describe, expect, test } from "bun:test"

import { armBodyIdle, type IdleRequest, type IdleResponse } from "./body-idle"

function req(method: string) {
  const calls: number[] = []
  const listeners = new Map<string, () => void>()
  const request: IdleRequest & { calls: number[]; fire: (event: string) => void; timeoutCb?: () => void } = {
    method,
    calls,
    setTimeout: (ms: number, callback?: () => void) => {
      calls.push(ms)
      if (callback) request.timeoutCb = callback
      return request
    },
    once: (event: string, listener: () => void) => listeners.set(event, listener),
    fire: (event: string) => listeners.get(event)?.(),
  }
  return request
}

const res = (writableEnded = false) => {
  const state = { writableEnded, destroyed: false }
  const response: IdleResponse & { destroyed: boolean } = {
    get writableEnded() {
      return state.writableEnded
    },
    get destroyed() {
      return state.destroyed
    },
    destroy: () => (state.destroyed = true),
  }
  return response
}

/**
 * 🔴 NC-SEC-005 — a body read with no clock. See `body-idle.ts` for why this is idle rather than
 * total, and why it must not arm on a GET.
 *
 * A/B: drop the GET check and "a GET is never armed" fails; drop the `once("end")` clear and "the
 * clock comes OFF when the body ends" fails.
 */
describe("the request body's idle clock", () => {
  test("🔴 a GET is never armed — an SSE stream must not race a socket timeout", () => {
    const request = req("GET")
    expect(armBodyIdle(request, res(), 30_000)).toBe(false)
    expect(request.calls).toEqual([])
  })

  test("a body-carrying method is armed with the window", () => {
    const request = req("POST")
    expect(armBodyIdle(request, res(), 30_000)).toBe(true)
    expect(request.calls).toEqual([30_000])
  })

  test("🔴 the clock comes OFF when the body ends, so the HANDLER is not on it", () => {
    // Otherwise a slow tool call looks exactly like a slow uploader.
    const request = req("POST")
    armBodyIdle(request, res(), 30_000)
    request.fire("end")
    expect(request.calls).toEqual([30_000, 0])
  })

  test("and off when the body dies mid-flight", () => {
    const request = req("POST")
    armBodyIdle(request, res(), 30_000)
    request.fire("close")
    expect(request.calls).toEqual([30_000, 0])
  })

  test("firing destroys a response that has not finished", () => {
    const request = req("POST")
    const response = res(false)
    armBodyIdle(request, response, 30_000)
    request.timeoutCb?.()
    expect(response.destroyed).toBe(true)
  })

  test("firing leaves an already-finished response alone", () => {
    // The control: without it, "always destroy" would pass the test above.
    const request = req("POST")
    const response = res(true)
    armBodyIdle(request, response, 30_000)
    request.timeoutCb?.()
    expect(response.destroyed).toBe(false)
  })

  test("a zero window disables it entirely", () => {
    const request = req("POST")
    expect(armBodyIdle(request, res(), 0)).toBe(false)
    expect(request.calls).toEqual([])
  })
})

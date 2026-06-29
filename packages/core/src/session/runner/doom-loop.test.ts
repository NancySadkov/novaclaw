import { describe, expect, test } from "bun:test"
import { detectDoomLoop, redirectMessage, DOOM_LOOP_THRESHOLD } from "./doom-loop"

const call = (name: string, input: string) => ({ name, input })

describe("detectDoomLoop", () => {
  test("three identical consecutive calls trips it", () => {
    const c = call("bash", '{"command":"gcc x.c"}')
    expect(detectDoomLoop([c, c, c])).toEqual(c)
  })

  test("fewer than threshold does not trip", () => {
    const c = call("bash", '{"command":"gcc x.c"}')
    expect(detectDoomLoop([c, c])).toBeUndefined()
  })

  test("only the LAST threshold calls matter (recovers then loops)", () => {
    const a = call("read", '{"path":"a"}')
    const b = call("bash", '{"command":"make"}')
    expect(detectDoomLoop([a, b, b, b])).toEqual(b)
  })

  test("different args break the loop", () => {
    expect(
      detectDoomLoop([call("bash", '{"command":"a"}'), call("bash", '{"command":"b"}'), call("bash", '{"command":"a"}')]),
    ).toBeUndefined()
  })

  test("same args but different tool is not a loop", () => {
    expect(detectDoomLoop([call("read", "{}"), call("write", "{}"), call("read", "{}")])).toBeUndefined()
  })

  test("custom threshold of 2", () => {
    const c = call("glob", '{"pattern":"*.ts"}')
    expect(detectDoomLoop([c, c], 2)).toEqual(c)
  })

  test("trailing recent window after a long non-looping history", () => {
    const noise = Array.from({ length: 10 }, (_, i) => call("read", `{"path":"${i}"}`))
    const c = call("bash", '{"command":"loop"}')
    expect(detectDoomLoop([...noise, c, c, c])).toEqual(c)
  })
})

describe("redirectMessage", () => {
  test("names the offending tool and threshold and says stop", () => {
    const msg = redirectMessage(call("bash", "{}"))
    expect(msg).toContain("`bash`")
    expect(msg).toContain(String(DOOM_LOOP_THRESHOLD))
    expect(msg.toLowerCase()).toContain("loop")
  })
})

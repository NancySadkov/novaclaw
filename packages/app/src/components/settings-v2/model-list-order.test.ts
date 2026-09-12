import { expect, test } from "bun:test"
import { applyModelOrder, modelOrderRef, moveModelOrder } from "./model-list-order"

const item = (provider: string, id: string) => ({ provider: { id: provider }, id })

test("saved model order leads, vanished refs drop, and newly discovered models append", () => {
  const live = [item("a", "one"), item("b", "two/vision"), item("a", "three")]
  expect(applyModelOrder(live, ["gone/model", "b/two/vision", "b/two/vision", "a/one"])).toEqual([
    live[1],
    live[0],
    live[2],
  ])
  expect(modelOrderRef(live[1]!)).toBe("b/two/vision")
})

test("dragging moves one complete provider/model ref onto another", () => {
  expect(moveModelOrder(["a/one", "b/two", "a/three"], "a/one", "a/three")).toEqual(["b/two", "a/three", "a/one"])
  expect(moveModelOrder(["a/one"], "missing", "a/one")).toBeUndefined()
  expect(moveModelOrder(["a/one"], "a/one", "a/one")).toBeUndefined()
})

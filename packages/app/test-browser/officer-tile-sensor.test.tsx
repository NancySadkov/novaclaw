import { afterEach, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { createSignal, onMount } from "solid-js"
import { DragDropProvider, createDraggable, useDragDropContext } from "@thisbeyond/solid-dnd"
import { OfficerTileSensor } from "@/components/officer-tile-sensor"

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.innerHTML = ""
})

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const events: string[] = []
  const [disabled, setDisabled] = createSignal(false)
  let tile!: HTMLDivElement
  let active!: () => boolean
  const Tile = () => {
    const [state] = useDragDropContext()!
    active = () => state.active.draggableId === "theron"
    const draggable = createDraggable("theron")
    onMount(() => {
      for (const [name, listener] of Object.entries(draggable.dragActivators)) {
        tile.addEventListener(name.startsWith("on") ? name.slice(2) : name, listener as EventListener)
      }
    })
    return (
      <div
        ref={(element) => {
          tile = element
          draggable.ref(element)
        }}
      >
        <span>Portrait</span>
        <button>Workers</button>
      </div>
    )
  }
  dispose = render(
    () => (
      <DragDropProvider onDragStart={() => events.push("start")} onDragEnd={() => events.push("end")}>
        <OfficerTileSensor disabled={disabled()} onCancel={() => events.push("cancel")} />
        <Tile />
      </DragDropProvider>
    ),
    host,
  )
  const pointer = (target: EventTarget, type: string, x = 0, pointerId = 1, y = 0) => {
    const event = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      isPrimary: pointerId === 1,
      pointerId,
      button: 0,
      clientX: x,
      clientY: y,
      pointerType: "touch",
    })
    target.dispatchEvent(event)
    return event
  }
  return { tile, pointer, events, active, setDisabled }
}

test("the entire portrait begins dragging only after meaningful movement and releases cleanly", () => {
  const rig = mount()
  rig.pointer(rig.tile.querySelector("span")!, "pointerdown")
  rig.pointer(document, "pointermove", 7)
  expect(rig.active()).toBe(false)
  expect(rig.pointer(document, "pointermove", 9).defaultPrevented).toBe(true)
  expect(rig.active()).toBe(true)
  rig.pointer(document, "pointerup", 9)
  expect(rig.active()).toBe(false)
  expect(rig.events).toEqual(["start", "end"])
})

test("worker buttons and disabled menus cannot start a tile drag", () => {
  const rig = mount()
  rig.pointer(rig.tile.querySelector("button")!, "pointerdown")
  rig.pointer(document, "pointermove", 20)
  expect(rig.active()).toBe(false)
  rig.setDisabled(true)
  rig.pointer(rig.tile, "pointerdown")
  rig.pointer(document, "pointermove", 20)
  expect(rig.active()).toBe(false)
})

test("Escape cancels before delivering the drag end and removes movement listeners", () => {
  const rig = mount()
  rig.pointer(rig.tile, "pointerdown")
  rig.pointer(document, "pointermove", 20)
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
  expect(rig.events).toEqual(["start", "cancel", "end"])
  rig.pointer(document, "pointermove", 40)
  expect(rig.active()).toBe(false)
})

test("another finger releasing or cancelling cannot terminate the active drag", () => {
  const rig = mount()
  rig.pointer(rig.tile, "pointerdown")
  rig.pointer(document, "pointermove", 20)
  rig.pointer(document, "pointerup", 20, 2)
  expect(rig.active()).toBe(true)
  rig.pointer(document, "pointercancel", 20, 2)
  expect(rig.active()).toBe(true)
  rig.pointer(document, "pointerup", 20)
  expect(rig.events).toEqual(["start", "end"])
})

test("opening the context menu cancels an active drag before it can save a drop", () => {
  const rig = mount()
  rig.pointer(rig.tile, "pointerdown")
  rig.pointer(document, "pointermove", 20)
  rig.setDisabled(true)
  expect(rig.events).toEqual(["start", "cancel", "end"])
  rig.pointer(document, "pointerup", 20)
  expect(rig.active()).toBe(false)
  expect(rig.events).toHaveLength(3)
})

test("vertical touch movement scrolls instead of dragging an officer", () => {
  const rig = mount()
  rig.pointer(rig.tile, "pointerdown")
  expect(rig.pointer(document, "pointermove", 2, 1, 20).defaultPrevented).toBe(false)
  expect(rig.active()).toBe(false)
  rig.pointer(document, "pointermove", 40, 1, 30)
  expect(rig.active()).toBe(false)
  expect(rig.events).toEqual(["cancel"])
})

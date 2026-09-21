import { createEffect, onCleanup, onMount } from "solid-js"
import { useDragDropContext, type Id } from "@thisbeyond/solid-dnd"

export function OfficerTileSensor(props: { disabled: boolean; onCancel: () => void }) {
  const [state, actions] = useDragDropContext()!
  let press: { id: Id; pointer: number; touch: boolean; x: number; y: number } | undefined
  const detach = () => {
    document.removeEventListener("pointermove", move)
    document.removeEventListener("pointerup", finish)
    document.removeEventListener("pointercancel", cancel)
    document.removeEventListener("keydown", key)
    window.removeEventListener("blur", cancel)
    press = undefined
  }
  const finish = (event?: PointerEvent) => {
    if (event && press?.pointer !== event.pointerId) return
    detach()
    if (state.active.sensorId !== "officer-tile") return
    actions.dragEnd()
    actions.sensorEnd()
  }
  const cancel = (event?: Event) => {
    if (!press) return
    if (event instanceof PointerEvent && press?.pointer !== event.pointerId) return
    props.onCancel()
    finish()
  }
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") cancel()
  }
  const move = (event: PointerEvent) => {
    if (!press || press.pointer !== event.pointerId) return
    const dx = event.clientX - press.x
    const dy = event.clientY - press.y
    if (!state.active.sensor && Math.hypot(dx, dy) >= 8) {
      if (press.touch && Math.abs(dy) >= Math.abs(dx)) {
        cancel()
        return
      }
      actions.sensorStart("officer-tile", { x: press.x, y: press.y })
      actions.dragStart(press.id)
    }
    if (state.active.sensorId !== "officer-tile") return
    event.preventDefault()
    actions.sensorMove({ x: event.clientX, y: event.clientY })
  }
  onMount(() =>
    actions.addSensor({
      id: "officer-tile",
      activators: {
        pointerdown: (event, id) => {
          if (props.disabled || event.button !== 0 || !event.isPrimary) return
          if ((event.target as HTMLElement).closest("button,[role=menu]")) return
          detach()
          press = {
            id,
            pointer: event.pointerId,
            touch: event.pointerType === "touch",
            x: event.clientX,
            y: event.clientY,
          }
          document.addEventListener("pointermove", move, { passive: false })
          document.addEventListener("pointerup", finish)
          document.addEventListener("pointercancel", cancel)
          document.addEventListener("keydown", key)
          window.addEventListener("blur", cancel)
        },
      },
    }),
  )
  createEffect(() => {
    if (props.disabled) cancel()
  })
  onCleanup(() => {
    detach()
    actions.removeSensor("officer-tile")
  })
  return null
}

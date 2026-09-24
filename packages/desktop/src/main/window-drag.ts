export type WindowDrag = {
  screenX: number
  screenY: number
  clientX: number
  clientY: number
  x: number
  y: number
  maximized: boolean
}

type Point = { x: number; y: number }

const nativeCoordinate = (value: number): number | undefined => {
  if (!Number.isFinite(value)) return undefined
  const rounded = Math.round(value)
  if (rounded < -2147483648 || rounded > 2147483647) return undefined
  return rounded
}

export function windowDragPosition(drag: WindowDrag, cursor: Point): [number, number] | undefined {
  const x = nativeCoordinate(drag.x + cursor.x - drag.screenX)
  const y = nativeCoordinate(drag.y + cursor.y - drag.screenY)
  return x === undefined || y === undefined ? undefined : [x, y]
}

export function restoreWindowDrag(drag: WindowDrag, cursor: Point, size: [number, number]): void {
  const [width, height] = size
  drag.x = cursor.x - Math.min(drag.clientX, width - 40)
  drag.y = cursor.y - Math.min(drag.clientY, height - 40)
  drag.screenX = cursor.x
  drag.screenY = cursor.y
  drag.maximized = false
}

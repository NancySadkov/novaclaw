import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js"
import {
  DEFAULT_SPACE_ZOOM,
  MAX_SPACE_ZOOM,
  MIN_SPACE_ZOOM,
  detailLevel,
  type DetailLevel,
  type MemorySpace,
  type Vec3,
} from "./model"
import {
  DEFAULT_CAMERA,
  MemorySpaceRenderer,
  projectSpacePoint,
  type ProjectedPoint,
  type SpaceCamera,
} from "./renderer"

export interface MemorySpaceControls {
  readonly zoomIn: () => void
  readonly zoomOut: () => void
  readonly reset: () => void
  readonly focus: (id: string) => void
}

interface LabelMark {
  readonly id: string
  readonly text: string
  readonly count?: number
  readonly screen: ProjectedPoint
  readonly cluster?: number
  readonly region?: boolean
}

/** Screen-space label collision, like a map. The stars remain; only overlapping captions yield. */
function placeLabels(candidates: readonly LabelMark[]): LabelMark[] {
  const placed: { mark: LabelMark; left: number; right: number; top: number; bottom: number }[] = []
  for (const mark of candidates) {
    const width = Math.min(208, Math.max(72, mark.text.length * 6.1 + (mark.count === undefined ? 18 : 48)))
    const box = {
      mark,
      left: mark.screen.x - width / 2 - 5,
      right: mark.screen.x + width / 2 + 5,
      top: mark.screen.y - 49,
      bottom: mark.screen.y - 8,
    }
    if (
      placed.some(
        (other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top,
      )
    )
      continue
    placed.push(box)
  }
  return placed.map(({ mark }) => mark)
}

const clampZoom = (zoom: number): number => Math.max(MIN_SPACE_ZOOM, Math.min(MAX_SPACE_ZOOM, zoom))

export const MemorySpaceCanvas: Component<{
  space: MemorySpace
  selected?: string
  matches: ReadonlySet<string>
  visibleKinds: ReadonlySet<string>
  clusterCaptions: ReadonlyMap<string, string>
  memoryCaptions: ReadonlyMap<string, string>
  onSelect: (id: string | undefined) => void
  onCluster: (index: number | undefined) => void
  onLevel: (level: DetailLevel) => void
  onReady?: (controls: MemorySpaceControls) => void
}> = (props) => {
  let canvas!: HTMLCanvasElement
  let frame: number | undefined
  let renderer: MemorySpaceRenderer | undefined
  let observer: ResizeObserver | undefined
  const [camera, setCamera] = createSignal<SpaceCamera>(DEFAULT_CAMERA)
  const [viewport, setViewport] = createSignal({ width: 1, height: 1 })
  const [rendererIssue, setRendererIssue] = createSignal<string | undefined>()
  const [dragged, setDragged] = createSignal(false)
  const pointers = new Map<number, { x: number; y: number }>()
  let lastPointer: { x: number; y: number } | undefined
  let pinchDistance: number | undefined

  const level = createMemo(() => detailLevel(camera().zoom))
  createEffect(() => props.onLevel(level()))

  const redraw = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      renderer?.draw(props.space, camera(), {
        level: level(),
        selected: props.selected,
        matches: props.matches,
        visibleKinds: props.visibleKinds,
      })
    })
  }

  const measure = () => {
    const rect = canvas.getBoundingClientRect()
    setViewport({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) })
    redraw()
  }

  const zoomBy = (factor: number) => setCamera((current) => ({ ...current, zoom: clampZoom(current.zoom * factor) }))

  const reset = () => {
    props.onCluster(undefined)
    setCamera({ ...DEFAULT_CAMERA, zoom: DEFAULT_SPACE_ZOOM })
  }

  const focus = (id: string) => {
    const point = props.space.points.find((entry) => entry.id === id)
    if (!point) return
    props.onCluster(point.cluster)
    setCamera((current) => ({ ...current, focus: point.position, zoom: Math.max(current.zoom, 4.25) }))
  }

  onMount(() => {
    renderer = new MemorySpaceRenderer(canvas)
    if (!renderer.available) setRendererIssue(renderer.reason ?? "3D graphics are unavailable.")
    observer = new ResizeObserver(measure)
    observer.observe(canvas)
    measure()
    props.onReady?.({ zoomIn: () => zoomBy(1.34), zoomOut: () => zoomBy(1 / 1.34), reset, focus })
  })

  createEffect(() => {
    props.space
    props.selected
    props.matches
    props.visibleKinds
    props.clusterCaptions
    props.memoryCaptions
    camera()
    viewport()
    redraw()
  })

  onCleanup(() => {
    observer?.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
    renderer?.dispose()
  })

  const clusterLabels = (): LabelMark[] => {
    const size = viewport()
    const candidates = props.space.clusters
      .map((cluster, index) => ({
        cluster,
        index,
        count: cluster.members.filter((member) => {
          const point = props.space.points[member]
          return point && props.visibleKinds.has(point.row.kind)
        }).length,
      }))
      .filter(({ count }) => count > 0)
      .map(({ cluster, index, count }) => ({
        id: cluster.id,
        text: props.clusterCaptions.get(cluster.id) ?? cluster.label,
        count,
        screen: projectSpacePoint(cluster.center, camera(), size),
        cluster: index,
        region: true,
      }))
      .filter((mark) => mark.screen.visible)
      .sort((left, right) => right.count! - left.count!)
      .slice(0, level() === "atlas" ? 18 : level() === "systems" ? 10 : 4)
    return candidates
  }

  const memoryLabels = (): LabelMark[] => {
    if (level() === "atlas") return []
    const size = viewport()
    const ranked = props.space.points
      .filter((point) => props.visibleKinds.has(point.row.kind))
      .map((point) => ({
        point,
        screen: projectSpacePoint(point.position, camera(), size),
        // Every visible memory may earn a label. The previous `degree > 0` floor erased every label
        // from an entirely valid unlinked cabinet — Daedalus's measured 504-passage shape.
        priority: point.id === props.selected ? 10000 : props.matches.has(point.id) ? 5000 : point.degree + 1,
      }))
      .filter((entry) => entry.screen.visible)
      .sort(
        (left, right) =>
          right.priority - left.priority ||
          right.screen.depth - left.screen.depth ||
          left.point.id.localeCompare(right.point.id),
      )
      .slice(0, level() === "systems" ? 12 : 28)
    return ranked.map(({ point, screen }) => ({
      id: point.id,
      text:
        (props.memoryCaptions.get(point.id) ?? point.row.name?.trim()) ||
        point.row.text.slice(0, 54).trim() ||
        point.row.kind,
      screen,
    }))
  }

  // Labels change semantic scale like a map: regions own the abstract view, both coexist during the
  // transition, and individual memories own the closest view. Keeping a region caption on top of a
  // one-star region would otherwise collision-cull the memory's own caption forever.
  const labels = createMemo(() =>
    placeLabels(
      level() === "atlas"
        ? clusterLabels()
        : level() === "systems"
          ? [...clusterLabels(), ...memoryLabels()]
          : memoryLabels(),
    ),
  )

  const hitAt = (x: number, y: number): { id?: string; cluster?: number } | undefined => {
    const size = viewport()
    if (level() === "atlas") {
      let best: { cluster: number; distance: number } | undefined
      props.space.clusters.forEach((cluster, index) => {
        const at = projectSpacePoint(cluster.center, camera(), size)
        const distance = Math.hypot(at.x - x, at.y - y)
        if (at.visible && distance < 36 && (!best || distance < best.distance)) best = { cluster: index, distance }
      })
      return best
    }
    let best: { id: string; distance: number; depth: number } | undefined
    for (const point of props.space.points) {
      if (!props.visibleKinds.has(point.row.kind)) continue
      const at = projectSpacePoint(point.position, camera(), size)
      const distance = Math.hypot(at.x - x, at.y - y)
      if (!at.visible || distance > 24) continue
      if (!best || distance < best.distance || (distance === best.distance && at.depth > best.depth))
        best = { id: point.id, distance, depth: at.depth }
    }
    return best
  }

  const openCluster = (index: number) => {
    const cluster = props.space.clusters[index]
    if (!cluster) return
    props.onCluster(index)
    setCamera((current) => ({ ...current, focus: cluster.center, zoom: 2.15 }))
  }

  const selectAt = (x: number, y: number) => {
    const hit = hitAt(x, y)
    if (hit?.cluster !== undefined) return openCluster(hit.cluster)
    props.onSelect(hit?.id)
  }

  const localPoint = (event: PointerEvent | MouseEvent) => {
    const rect = canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const onPointerDown = (event: PointerEvent) => {
    canvas.setPointerCapture?.(event.pointerId)
    const point = localPoint(event)
    pointers.set(event.pointerId, point)
    lastPointer = point
    setDragged(false)
    if (pointers.size === 2) {
      const pair = [...pointers.values()]
      pinchDistance = Math.hypot(pair[0]!.x - pair[1]!.x, pair[0]!.y - pair[1]!.y)
    }
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return
    const point = localPoint(event)
    pointers.set(event.pointerId, point)
    if (pointers.size === 2) {
      const pair = [...pointers.values()]
      const distance = Math.hypot(pair[0]!.x - pair[1]!.x, pair[0]!.y - pair[1]!.y)
      if (pinchDistance && distance > 0) zoomBy(distance / pinchDistance)
      pinchDistance = distance
      setDragged(true)
      return
    }
    if (!lastPointer) return
    const dx = point.x - lastPointer.x
    const dy = point.y - lastPointer.y
    if (Math.hypot(dx, dy) > 1) setDragged(true)
    setCamera((current) => ({
      ...current,
      yaw: current.yaw + dx * 0.006,
      pitch: Math.max(-1.15, Math.min(1.15, current.pitch + dy * 0.006)),
    }))
    lastPointer = point
  }

  const onPointerUp = (event: PointerEvent) => {
    const point = localPoint(event)
    if (!dragged() && pointers.size === 1) selectAt(point.x, point.y)
    pointers.delete(event.pointerId)
    lastPointer = pointers.values().next().value
    if (pointers.size < 2) pinchDistance = undefined
  }

  const activateLabel = (mark: LabelMark) => {
    if (mark.cluster !== undefined) openCluster(mark.cluster)
    else {
      props.onSelect(mark.id)
      focus(mark.id)
    }
  }

  return (
    <div class="memory-space-stage" data-slot="memory-graph-canvas" data-state="ready" data-level={level()}>
      <canvas
        ref={canvas}
        class="memory-space-canvas"
        aria-label="Interactive 3D map of this officer's memories"
        onWheel={(event) => {
          event.preventDefault()
          zoomBy(Math.exp(-event.deltaY * 0.00135))
        }}
        onDblClick={(event) => {
          const point = localPoint(event)
          selectAt(point.x, point.y)
          zoomBy(1.55)
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div class="memory-space-vignette" aria-hidden="true" />
      <div class="memory-space-labels">
        <For each={labels()}>
          {(mark) => (
            <button
              type="button"
              class="memory-space-label"
              classList={{
                "memory-space-label-selected": mark.id === props.selected,
                "memory-space-label-cluster": mark.region,
              }}
              style={{ left: `${mark.screen.x}px`, top: `${mark.screen.y}px` }}
              onClick={() => activateLabel(mark)}
            >
              <span>{mark.text}</span>
              <Show when={mark.count !== undefined}>
                <small>{mark.count}</small>
              </Show>
            </button>
          )}
        </For>
      </div>
      <Show when={rendererIssue()}>
        {(reason) => (
          <div class="memory-space-renderer-fallback" data-slot="memory-renderer-fallback">
            <strong>Memory map unavailable</strong>
            <span>{reason()}</span>
          </div>
        )}
      </Show>
      <div class="sr-only" aria-live="polite">
        {level() === "atlas"
          ? `${props.space.clusters.length} memory regions`
          : `${props.space.points.filter((point) => props.visibleKinds.has(point.row.kind)).length} memories visible`}
      </div>
    </div>
  )
}

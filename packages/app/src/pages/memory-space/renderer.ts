import type { DetailLevel, MemorySpace, Vec3 } from "./model"

export interface SpaceCamera {
  readonly zoom: number
  readonly yaw: number
  readonly pitch: number
  readonly focus: Vec3
}

export const DEFAULT_CAMERA: SpaceCamera = {
  zoom: 0.9,
  yaw: -0.24,
  pitch: 0.2,
  focus: { x: 0, y: 0, z: 0 },
}

export interface RenderState {
  readonly level: DetailLevel
  readonly selected?: string
  readonly matches?: ReadonlySet<string>
  readonly visibleKinds?: ReadonlySet<string>
}

export interface ProjectedPoint {
  readonly x: number
  readonly y: number
  readonly depth: number
  readonly visible: boolean
}

const rotate = (point: Vec3, camera: SpaceCamera): Vec3 => {
  const px = point.x - camera.focus.x
  const py = point.y - camera.focus.y
  const pz = point.z - camera.focus.z
  const cy = Math.cos(camera.yaw)
  const sy = Math.sin(camera.yaw)
  const cp = Math.cos(camera.pitch)
  const sp = Math.sin(camera.pitch)
  const x = px * cy - pz * sy
  const z = px * sy + pz * cy
  return { x, y: py * cp - z * sp, z: py * sp + z * cp }
}

export function projectSpacePoint(
  point: Vec3,
  camera: SpaceCamera,
  viewport: { width: number; height: number },
): ProjectedPoint {
  const rotated = rotate(point, camera)
  const scale = Math.max(1, Math.min(viewport.width, viewport.height)) * 0.43 * camera.zoom
  const x = viewport.width / 2 + rotated.x * scale
  const y = viewport.height / 2 - rotated.y * scale
  return {
    x,
    y,
    depth: rotated.z,
    visible: x >= -28 && y >= -28 && x <= viewport.width + 28 && y <= viewport.height + 28,
  }
}

const VERTEX = `#version 300 es
precision highp float;
in vec3 a_position;
in vec3 a_color;
in float a_size;
uniform vec2 u_viewport;
uniform float u_zoom;
uniform float u_yaw;
uniform float u_pitch;
uniform vec3 u_focus;
out vec3 v_color;
out float v_alpha;
void main() {
  vec3 p = a_position - u_focus;
  float cy = cos(u_yaw), sy = sin(u_yaw);
  p = vec3(p.x * cy - p.z * sy, p.y, p.x * sy + p.z * cy);
  float cp = cos(u_pitch), sp = sin(u_pitch);
  p = vec3(p.x, p.y * cp - p.z * sp, p.y * sp + p.z * cp);
  float scale = min(u_viewport.x, u_viewport.y) * .43 * u_zoom;
  gl_Position = vec4((p.x * scale) / (u_viewport.x * .5), (p.y * scale) / (u_viewport.y * .5), 0.0, 1.0);
  gl_PointSize = a_size * clamp(1.0 + p.z * .18, .72, 1.28);
  v_color = a_color;
  v_alpha = clamp(.72 + p.z * .16, .48, 1.0);
}`

const POINT_FRAGMENT = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
out vec4 outColor;
void main() {
  vec2 p = gl_PointCoord - vec2(.5);
  float d = length(p);
  if (d > .5) discard;
  float core = 1.0 - smoothstep(.12, .48, d);
  float halo = (1.0 - smoothstep(.30, .5, d)) * .38;
  outColor = vec4(v_color * (1.0 + core * .36), (core + halo) * v_alpha);
}`

const LINE_FRAGMENT = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
out vec4 outColor;
void main() { outColor = vec4(v_color, v_alpha * .22); }`

function shader(gl: WebGL2RenderingContext, kind: number, source: string): WebGLShader {
  const result = gl.createShader(kind)
  if (!result) throw new Error("WebGL could not create a shader")
  gl.shaderSource(result, source)
  gl.compileShader(result)
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    const reason = gl.getShaderInfoLog(result) || "Shader compilation failed"
    gl.deleteShader(result)
    throw new Error(reason)
  }
  return result
}

function program(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const result = gl.createProgram()
  if (!result) throw new Error("WebGL could not create a program")
  const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX)
  const pixel = shader(gl, gl.FRAGMENT_SHADER, fragment)
  gl.attachShader(result, vertex)
  gl.attachShader(result, pixel)
  gl.linkProgram(result)
  gl.deleteShader(vertex)
  gl.deleteShader(pixel)
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result) || "Link failed")
  return result
}

const clusterColor = (cluster: MemorySpace["clusters"][number]): readonly [number, number, number] => {
  const kind = Object.entries(cluster.kinds).sort((left, right) => right[1] - left[1])[0]?.[0]
  const palette: Record<string, readonly [number, number, number]> = {
    entity: [0.55, 0.36, 0.96],
    episode: [0.13, 0.83, 0.93],
    claim: [0.2, 0.83, 0.6],
    passage: [0.66, 0.52, 0.59],
    source: [0.38, 0.65, 0.98],
  }
  return (kind && palette[kind]) || [0.73, 0.66, 0.75]
}

/** Native WebGL2 renderer. It draws only when asked; there is no idle animation loop. */
export class MemorySpaceRenderer {
  readonly available: boolean
  readonly reason?: string
  private readonly gl?: WebGL2RenderingContext
  private readonly points?: WebGLProgram
  private readonly lines?: WebGLProgram
  private readonly buffer?: WebGLBuffer

  constructor(private readonly canvas: HTMLCanvasElement) {
    try {
      const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, powerPreference: "high-performance" })
      if (!gl) {
        this.available = false
        this.reason = "3D graphics are unavailable in this window. The memory index still works."
        return
      }
      this.gl = gl
      this.points = program(gl, POINT_FRAGMENT)
      this.lines = program(gl, LINE_FRAGMENT)
      this.buffer = gl.createBuffer() ?? undefined
      this.available = this.buffer !== undefined
      if (!this.available) this.reason = "3D graphics could not allocate a drawing buffer."
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    } catch (error) {
      this.available = false
      this.reason = error instanceof Error ? error.message : String(error)
    }
  }

  private uniforms(program: WebGLProgram, camera: SpaceCamera, width: number, height: number): void {
    const gl = this.gl!
    gl.uniform2f(gl.getUniformLocation(program, "u_viewport"), width, height)
    gl.uniform1f(gl.getUniformLocation(program, "u_zoom"), camera.zoom)
    gl.uniform1f(gl.getUniformLocation(program, "u_yaw"), camera.yaw)
    gl.uniform1f(gl.getUniformLocation(program, "u_pitch"), camera.pitch)
    gl.uniform3f(gl.getUniformLocation(program, "u_focus"), camera.focus.x, camera.focus.y, camera.focus.z)
  }

  private attributes(program: WebGLProgram): void {
    const gl = this.gl!
    const stride = 7 * Float32Array.BYTES_PER_ELEMENT
    const position = gl.getAttribLocation(program, "a_position")
    const color = gl.getAttribLocation(program, "a_color")
    const size = gl.getAttribLocation(program, "a_size")
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, stride, 0)
    gl.enableVertexAttribArray(color)
    gl.vertexAttribPointer(color, 3, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT)
    gl.enableVertexAttribArray(size)
    gl.vertexAttribPointer(size, 1, gl.FLOAT, false, stride, 6 * Float32Array.BYTES_PER_ELEMENT)
  }

  draw(space: MemorySpace, camera: SpaceCamera, state: RenderState): void {
    const gl = this.gl
    const buffer = this.buffer
    const pointProgram = this.points
    const lineProgram = this.lines
    if (!gl || !buffer || !pointProgram || !lineProgram) return

    const density = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * density))
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * density))
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)

    if (state.level !== "atlas" && space.edges.length > 0) {
      const lineData: number[] = []
      for (const edge of space.edges) {
        const from = space.points[edge.from]
        const to = space.points[edge.to]
        if (!from || !to) continue
        if (state.visibleKinds && (!state.visibleKinds.has(from.row.kind) || !state.visibleKinds.has(to.row.kind)))
          continue
        for (const point of [from, to])
          lineData.push(point.position.x, point.position.y, point.position.z, 0.44, 0.34, 0.52, 1)
      }
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineData), gl.DYNAMIC_DRAW)
      gl.useProgram(lineProgram)
      this.uniforms(lineProgram, camera, width, height)
      this.attributes(lineProgram)
      gl.drawArrays(gl.LINES, 0, lineData.length / 7)
    }

    const pointData: number[] = []
    if (state.level === "atlas") {
      for (const cluster of space.clusters) {
        const visibleCount = cluster.members.filter((index) => {
          const point = space.points[index]
          return point && (!state.visibleKinds || state.visibleKinds.has(point.row.kind))
        }).length
        if (visibleCount === 0) continue
        const color = clusterColor(cluster)
        pointData.push(
          cluster.center.x,
          cluster.center.y,
          cluster.center.z,
          color[0],
          color[1],
          color[2],
          Math.min(48, 15 + Math.sqrt(visibleCount) * 2.4) * density,
        )
      }
    } else {
      for (const point of space.points) {
        if (state.visibleKinds && !state.visibleKinds.has(point.row.kind)) continue
        const selected = state.selected === point.id
        const matched = state.matches?.has(point.id) ?? false
        const color = selected ? ([0.96, 0.83, 0.43] as const) : matched ? ([0.28, 0.88, 0.94] as const) : point.color
        const size = (selected ? 18 : matched ? 14 : state.level === "memories" ? 9 : 7) * density
        pointData.push(point.position.x, point.position.y, point.position.z, color[0], color[1], color[2], size)
      }
    }
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pointData), gl.DYNAMIC_DRAW)
    gl.useProgram(pointProgram)
    this.uniforms(pointProgram, camera, width, height)
    this.attributes(pointProgram)
    gl.drawArrays(gl.POINTS, 0, pointData.length / 7)
  }

  dispose(): void {
    const gl = this.gl
    if (!gl) return
    if (this.buffer) gl.deleteBuffer(this.buffer)
    if (this.points) gl.deleteProgram(this.points)
    if (this.lines) gl.deleteProgram(this.lines)
  }
}

const vertexSource = `attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}`

const fragmentSource = `
precision mediump float;
uniform vec2 resolution;
uniform float time;
uniform float duration;
uniform float bass;
uniform float treble;

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float line(float x,float w){return 1.-smoothstep(0.,w,abs(x));}

float glow(float distance,float radius){return radius/(distance+radius);}
vec3 gold=vec3(1.,.58,.22);
vec3 violet=vec3(.3,.09,.48);

vec3 nebula(vec2 p){
  float cloud=sin(p.x*2.3+sin(p.y*3.+time*.04))*sin(p.y*2.8-p.x*1.7);
  float dust=hash(floor(p*180.))*.012;
  return vec3(.007,.006,.028)+violet*(.09+.07*cloud)*exp(-length(p)*.65)+dust;
}

vec3 eye(vec2 p){
  float r=length(p*vec2(1.,1.32));
  float a=atan(p.y,p.x);
  float iris=line(r-.205,.012)+line(r-.27,.005);
  float aureole=line(r-.38,.006)*(.6+.4*sin(a*12.+time*.13));
  float rays=pow(max(0.,sin(a*32.+time*.12)),12.)*(1.-smoothstep(.21,.43,r));
  vec3 color=nebula(p)+violet*glow(r,.2)*.42;
  color+=gold*(iris*.35+aureole*.25+rays*.15)*(1.+bass*.6);
  color+=gold*glow(r,.035)*.16*(1.+bass);
  return color;
}

vec3 corridor(vec2 p){
  float depth=max(.02,abs(p.y+.13));
  float perspective=1./depth;
  float pillars=line(fract(perspective*.15-time*.43)-.5,.025);
  float edge=glow(abs(abs(p.x)-(.23+depth*1.55)),.008);
  float floorLine=line(fract(perspective*.11-time*.32)-.5,.018)*step(p.y,-.12);
  float arch=glow(abs(length(vec2(p.x*.8,p.y+.19))-.7),.006);
  vec3 color=nebula(p)+violet*.25*exp(-length(p)*1.8);
  color+=gold*(edge*(.5+pillars*.7)+floorLine*.32+arch*.35);
  color+=vec3(.6,.3,.9)*glow(length(p-vec2(0.,-.12)),.045)*.16;
  return color;
}

vec3 celestial(vec2 p){
  vec2 center=vec2(.2*sin(time*.045),.04);
  float r=length(p-center);
  float halo=glow(abs(r-.37),.012);
  float disc=1.-smoothstep(.35,.37,r);
  float veins=sin((p.x+p.y*.4)*27.+sin(p.y*13.))*sin(p.y*35.);
  vec3 color=nebula(p)+gold*halo*.8;
  color+=disc*(vec3(.12,.04,.18)+gold*(.17+.09*veins)+vec3(.5,.13,.42)*p.y);
  color+=gold*glow(abs(r-.43),.006)*.12;
  color+=violet*glow(length(p-center),.15)*.27;
  return color;
}

vec3 ocean(vec2 p){
  float horizon=-.12;
  vec3 color=eye(p);
  float water=step(p.y,horizon);
  float depth=max(.025,horizon-p.y);
  float ripple=sin(p.x*(7.+30.*depth)+time*.35+sin(depth*21.))*sin(depth*40.-time*.18);
  float reflection=exp(-abs(p.x)*(3.+depth*9.))*(.45+.55*ripple);
  color=mix(color,vec3(.009,.008,.035)+violet*.13+gold*reflection*.38,water);
  color+=gold*glow(abs(p.y-horizon),.008)*.55;
  color+=violet*glow(abs(p.y-.24-.04*sin(p.x*3.+time*.1)),.04)*.11;
  return color;
}

void main(){
  vec2 p=(gl_FragCoord.xy*2.-resolution)/min(resolution.x,resolution.y);
  float t=fract(time/duration);
  vec3 color=eye(p);
  color=mix(color,corridor(p),smoothstep(.15,.21,t));
  color=mix(color,celestial(p),smoothstep(.34,.4,t));
  color=mix(color,ocean(p),smoothstep(.56,.62,t));
  color=mix(color,eye(p),smoothstep(.83,.9,t));
  color*=1.-.33*smoothstep(.7,1.6,length(p));
  color+=gold*bass*.035+violet*treble*.025;
  gl_FragColor=vec4(pow(max(color,vec3(0.)),vec3(.82)),1.);
}
`

const starVertexSource = `
attribute vec2 position;
attribute float size;
attribute vec3 tint;
uniform vec2 resolution;
varying vec3 color;
void main(){
  gl_Position=vec4(position,0.,1.);
  gl_PointSize=size*min(resolution.x,resolution.y)/420.;
  color=tint;
}`

const starFragmentSource = `
precision mediump float;
varying vec3 color;
void main(){
  float r=length(gl_PointCoord-.5)*2.;
  float core=1.-smoothstep(.05,.35,r);
  float halo=pow(max(0.,1.-r),2.)*.4;
  gl_FragColor=vec4(color*(core+halo),max(core,halo));
}`

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  gl.deleteShader(shader)
  return null
}

function makeProgram(gl: WebGLRenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex)
    if (fragment) gl.deleteShader(fragment)
    return null
  }
  const program = gl.createProgram()
  if (program) {
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
  }
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!program) return null
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program
  gl.deleteProgram(program)
  return null
}

type Star = { x: number; y: number; z: number; speed: number; gold: boolean }
const STAR_COUNT = 420
const STAR_DEPTH = 12

function createStars(): Star[] {
  let seed = 0x4e4f5641
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0
    return (seed >>> 0) / 4294967296
  }
  return Array.from({ length: STAR_COUNT }, () => ({
    x: (random() * 2 - 1) * 8,
    y: (random() * 2 - 1) * 5,
    z: .3 + random() * STAR_DEPTH,
    speed: .35 + random() * .9,
    gold: random() > .77,
  }))
}

export type AboutScene = { stop(): void; resumeAudio(): Promise<void> }

const emptyScene: AboutScene = {
  stop: () => undefined,
  resumeAudio: async () => undefined,
}

function soundtrackDuration(audio: HTMLAudioElement): number {
  return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 144.614
}

function positionCrawl(stage: HTMLElement, crawl: HTMLElement, time: number, duration: number) {
  const progress = Math.min(1, time / duration)
  const offset = stage.clientHeight * .72 - progress * (crawl.offsetHeight + stage.clientHeight * .35)
  crawl.style.transform = `translate3d(-50%, ${offset}px, 0) rotateX(29deg)`
}

function startFallbackScene(audio: HTMLAudioElement, stage: HTMLElement, crawl: HTMLElement): AboutScene {
  let frame = 0
  const draw = () => {
    positionCrawl(stage, crawl, audio.currentTime, soundtrackDuration(audio))
    frame = requestAnimationFrame(draw)
  }
  frame = requestAnimationFrame(draw)
  return { stop: () => cancelAnimationFrame(frame), resumeAudio: emptyScene.resumeAudio }
}

export function startAboutScene(canvas: HTMLCanvasElement, audio: HTMLAudioElement, stage: HTMLElement, crawl: HTMLElement): AboutScene {
  const gl = canvas.getContext("webgl", { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: "high-performance" })
  if (!gl) return startFallbackScene(audio, stage, crawl)
  const backdropProgram = makeProgram(gl, vertexSource, fragmentSource)
  const starsProgram = makeProgram(gl, starVertexSource, starFragmentSource)
  const backdropBuffer = gl.createBuffer()
  const starsBuffer = gl.createBuffer()
  if (!backdropProgram || !starsProgram || !backdropBuffer || !starsBuffer) {
    if (backdropProgram) gl.deleteProgram(backdropProgram)
    if (starsProgram) gl.deleteProgram(starsProgram)
    if (backdropBuffer) gl.deleteBuffer(backdropBuffer)
    if (starsBuffer) gl.deleteBuffer(starsBuffer)
    return startFallbackScene(audio, stage, crawl)
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, backdropBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

  let context: AudioContext | undefined
  let analyser: AnalyserNode | undefined
  let source: MediaElementAudioSourceNode | undefined
  try {
    context = new AudioContext()
    analyser = context.createAnalyser()
    analyser.fftSize = 512
    source = context.createMediaElementSource(audio)
    source.connect(analyser)
    analyser.connect(context.destination)
  } catch {
    if (context) void context.close().catch(() => undefined)
    context = undefined
    analyser = undefined
  }

  const spectrum = new Uint8Array(256)
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
  const stars = createStars()
  const starVertices = new Float32Array(STAR_COUNT * 6)
  const resize = () => {
    const rect = canvas.getBoundingClientRect()
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
    canvas.width = Math.max(1, Math.min(1100, Math.round(rect.width * ratio)))
    canvas.height = Math.max(1, Math.min(700, Math.round(rect.height * ratio)))
    gl.viewport(0, 0, canvas.width, canvas.height)
  }
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize)
  observer?.observe(canvas)
  if (!observer) window.addEventListener("resize", resize)
  resize()
  let frame = 0
  let lastFrame = 0
  const draw = (now: number) => {
    frame = requestAnimationFrame(draw)
    if (now - lastFrame < 32 && !reducedMotion.matches) return
    lastFrame = now
    let low = 0
    let high = 0
    if (analyser) {
      analyser.getByteFrequencyData(spectrum)
      for (let index = 2; index < 22; index++) low += spectrum[index]
      for (let index = 50; index < 110; index++) high += spectrum[index]
    }
    const lowLevel = low / (20 * 255)
    const highLevel = high / (60 * 255)
    const sceneTime = reducedMotion.matches ? 0 : audio.currentTime
    const duration = soundtrackDuration(audio)
    const phase = sceneTime / duration
    const eyeOpacity = phase < .18 || phase > .87 ? .68 : phase > .61 && phase < .83 ? .36 : 0
    stage.style.setProperty("--about-eye-opacity", String(eyeOpacity))
    positionCrawl(stage, crawl, sceneTime, duration)

    gl.useProgram(backdropProgram)
    gl.bindBuffer(gl.ARRAY_BUFFER, backdropBuffer)
    const position = gl.getAttribLocation(backdropProgram, "position")
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.uniform2f(gl.getUniformLocation(backdropProgram, "resolution"), canvas.width, canvas.height)
    gl.uniform1f(gl.getUniformLocation(backdropProgram, "time"), sceneTime)
    gl.uniform1f(gl.getUniformLocation(backdropProgram, "duration"), duration)
    gl.uniform1f(gl.getUniformLocation(backdropProgram, "bass"), lowLevel)
    gl.uniform1f(gl.getUniformLocation(backdropProgram, "treble"), highLevel)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    if (!reducedMotion.matches) {
      const aspect = canvas.width / canvas.height
      for (let index = 0; index < stars.length; index++) {
        const star = stars[index]!
        const depth = .3 + ((star.z - sceneTime * star.speed * .55 + STAR_DEPTH * 20) % STAR_DEPTH)
        const brightness = Math.min(1, (STAR_DEPTH - depth) / 7) * (.6 + highLevel * .6)
        const offset = index * 6
        starVertices[offset] = star.x / depth / aspect
        starVertices[offset + 1] = star.y / depth
        starVertices[offset + 2] = Math.min(9, 1.8 + 8 / depth + lowLevel * 1.5)
        starVertices[offset + 3] = (star.gold ? 1 : .47) * brightness
        starVertices[offset + 4] = (star.gold ? .68 : .42) * brightness
        starVertices[offset + 5] = (star.gold ? .28 : .93) * brightness
      }
      gl.useProgram(starsProgram)
      gl.bindBuffer(gl.ARRAY_BUFFER, starsBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, starVertices, gl.DYNAMIC_DRAW)
      const stride = 6 * Float32Array.BYTES_PER_ELEMENT
      const starPosition = gl.getAttribLocation(starsProgram, "position")
      const starSize = gl.getAttribLocation(starsProgram, "size")
      const starTint = gl.getAttribLocation(starsProgram, "tint")
      gl.enableVertexAttribArray(starPosition)
      gl.enableVertexAttribArray(starSize)
      gl.enableVertexAttribArray(starTint)
      gl.vertexAttribPointer(starPosition, 2, gl.FLOAT, false, stride, 0)
      gl.vertexAttribPointer(starSize, 1, gl.FLOAT, false, stride, 8)
      gl.vertexAttribPointer(starTint, 3, gl.FLOAT, false, stride, 12)
      gl.uniform2f(gl.getUniformLocation(starsProgram, "resolution"), canvas.width, canvas.height)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
      gl.drawArrays(gl.POINTS, 0, STAR_COUNT)
      gl.disable(gl.BLEND)
    }
    if (reducedMotion.matches) cancelAnimationFrame(frame)
  }
  frame = requestAnimationFrame(draw)
  return {
    resumeAudio: () => context ? context.resume() : Promise.resolve(),
    stop: () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      if (!observer) window.removeEventListener("resize", resize)
      source?.disconnect()
      analyser?.disconnect()
      if (context) void context.close().catch(() => undefined)
      gl.deleteBuffer(backdropBuffer)
      gl.deleteBuffer(starsBuffer)
      gl.deleteProgram(backdropProgram)
      gl.deleteProgram(starsProgram)
    },
  }
}

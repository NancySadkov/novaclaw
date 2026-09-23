const vertexSource = `attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}`

const fragmentSource = `
precision mediump float;
uniform vec2 resolution;
uniform float time;
uniform float bass;
uniform float treble;

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float line(float x,float w){return 1.-smoothstep(0.,w,abs(x));}

vec3 road(vec2 p){
  float horizon=-.15;
  float d=max(.004,horizon-p.y);
  vec3 sky=mix(vec3(.008,.006,.045),vec3(.18,.025,.20),smoothstep(-.6,.8,p.y));
  float sun=1.-smoothstep(.265,.28,length((p-vec2(0.,.03+.25*sin(time*.0873)))*vec2(1.,1.15)));
  sky+=vec3(1.,.32,.08)*sun*step(.13,fract((p.y+time*.02)*21.))*(.75+bass*.6);
  sky+=vec3(.5,.08,.27)*line(p.y-horizon,.012);
  float grid=max(line(fract(.09/d-time*.85)-.5,.035),line(fract(p.x/d*.2+.5)-.5,.02));
  float edge=line(abs(p.x)/(d*2.8)-1.,.018);
  float dash=line(p.x,.004+d*.003)*step(.52,fract(.13/d-time*1.3));
  vec3 ground=vec3(.012,.01,.05)+vec3(.17,.04,.33)*grid+vec3(.92,.38,.1)*(edge+dash)*(.65+bass);
  return mix(sky,ground,step(p.y,horizon));
}

vec3 tunnel(vec2 p){
  float r=max(length(p*vec2(1.,.9)),.02);
  float a=atan(p.y,p.x)/6.2831853;
  float spokes=line(fract(a*16.+.5)-.5,.05);
  float rings=line(fract(.46/r-time*1.1)-.5,.05);
  float fade=1.-smoothstep(.7,1.6,r);
  return vec3(.013,.006,.05)+vec3(.18,.025,.23)*pow(fade,3.)
    +vec3(.43,.08,.55)*spokes*fade
    +vec3(.95,.32+treble*.3,.12)*rings*fade*(.65+bass)
    +vec3(.38,.12,.45)*exp(-r*9.)*(.6+bass);
}

vec3 stars(vec2 p){
  vec3 color=vec3(.006,.008,.04)+vec3(.07,.02,.12)*(1.-length(p)*.5);
  for(int layer=0;layer<3;layer++){
    float scale=8.+float(layer)*9.;
    vec2 q=p*scale+vec2(time*(.35+float(layer)*.2),time*.12);
    vec2 cell=floor(q);
    float seed=hash(cell+float(layer)*71.);
    vec2 offset=vec2(hash(cell+13.),hash(cell+29.))-.5;
    float size=mix(.013,.048,seed)+treble*.018;
    float point=(1.-smoothstep(size,size+.018,length(fract(q)-.5-offset*.7)))*step(.84,seed);
    color+=mix(vec3(.42,.34,.98),vec3(1.,.65,.25),seed)*point*(.65+.35*sin(time*(1.5+seed*4.)+seed*40.))*(1.+treble);
  }
  return color+vec3(.15,.07,.25)*exp(-length(p)*4.)*(.5+bass);
}

void main(){
  vec2 p=(gl_FragCoord.xy*2.-resolution)/min(resolution.x,resolution.y);
  float phase=fract(time/36.);
  vec3 color=mix(road(p),tunnel(p),smoothstep(.23,.34,phase));
  color=mix(color,stars(p),smoothstep(.55,.66,phase));
  color=mix(color,road(p),smoothstep(.87,.99,phase));
  color*=1.-.22*smoothstep(.6,1.5,length(p));
  gl_FragColor=vec4(pow(color+vec3(.07,.035,.11)*bass,vec3(.85)),1.);
}
`

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  gl.deleteShader(shader)
  return null
}

export type AboutScene = { stop(): void; resumeAudio(): Promise<void> }

const emptyScene: AboutScene = {
  stop: () => undefined,
  resumeAudio: async () => undefined,
}

export function startAboutScene(canvas: HTMLCanvasElement, audio: HTMLAudioElement, stage: HTMLElement): AboutScene {
  const gl = canvas.getContext("webgl", { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: "low-power" })
  if (!gl) return emptyScene
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex)
    if (fragment) gl.deleteShader(fragment)
    return emptyScene
  }
  const program = gl.createProgram()
  const buffer = gl.createBuffer()
  if (!program || !buffer) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (program) gl.deleteProgram(program)
    if (buffer) gl.deleteBuffer(buffer)
    return emptyScene
  }
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    gl.deleteBuffer(buffer)
    return emptyScene
  }
  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, "position")
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
  const resolution = gl.getUniformLocation(program, "resolution")
  const time = gl.getUniformLocation(program, "time")
  const bass = gl.getUniformLocation(program, "bass")
  const treble = gl.getUniformLocation(program, "treble")

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
  const resize = () => {
    const rect = canvas.getBoundingClientRect()
    const ratio = Math.min(window.devicePixelRatio || 1, 1)
    canvas.width = Math.max(1, Math.min(720, Math.round(rect.width * ratio)))
    canvas.height = Math.max(1, Math.min(420, Math.round(rect.height * ratio)))
    gl.viewport(0, 0, canvas.width, canvas.height)
  }
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize)
  observer?.observe(canvas)
  if (!observer) window.addEventListener("resize", resize)
  resize()
  let frame = 0
  let lastFrame = 0
  const began = performance.now()
  const draw = (now: number) => {
    frame = requestAnimationFrame(draw)
    if (now - lastFrame < 33 && !reducedMotion.matches) return
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
    stage.style.setProperty("--about-pulse", String(lowLevel))
    gl.uniform2f(resolution, canvas.width, canvas.height)
    gl.uniform1f(time, reducedMotion.matches ? 0 : (now - began) / 1000)
    gl.uniform1f(bass, lowLevel)
    gl.uniform1f(treble, highLevel)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
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
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
    },
  }
}

import { For, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import silhouette from "./assets/nova-silhouette.png"
import { SPLASH_SLOW_MS, SPLASH_STALLED_MS, splashPhase, type SplashPhase } from "./splash"
import "./startup-splash.css"

const stars = Array.from({ length: 180 }, (_, index) => ({
  x: (index * 613 + 41) % 1600,
  y: (index * 307 + 19) % 660,
  radius: index % 17 === 0 ? 1.6 : index % 5 === 0 ? 0.9 : 0.5,
  opacity: 0.18 + (index % 7) * 0.09,
}))
const rings = Array.from({ length: 8 }, (_, index) => 212 + index * 16)
const fieldLines = Array.from({ length: 19 }, (_, index) => index - 9)
const irisFibres = Array.from({ length: 144 }, (_, index) => {
  const angle = (index / 144) * Math.PI * 2
  const inner = 40 + (index % 7) * 1.6
  const outer = 76 + (index % 5) * 1.8
  return {
    path: `M${514 + Math.cos(angle) * inner} ${326 + Math.sin(angle) * inner} Q${514 + Math.cos(angle + 0.035) * 61} ${326 + Math.sin(angle + 0.035) * 61} ${514 + Math.cos(angle) * outer} ${326 + Math.sin(angle) * outer}`,
    color: ["#9fa2d6", "#407b78", "#af88c1", "#58b59e", "#65629f", "#c0b182"][index % 6],
    opacity: 0.22 + (index % 5) * 0.1,
  }
})

export function StartupSplash(props: { message: (phase: SplashPhase) => string }) {
  const [phase, setPhase] = createSignal<SplashPhase>("starting")
  const id = createUniqueId().replaceAll(":", "")
  const paint = (name: string) => `url(#${id}-${name})`

  onMount(() => {
    const timers = [SPLASH_SLOW_MS, SPLASH_STALLED_MS].map((threshold) =>
      setTimeout(() => setPhase(splashPhase(threshold)), threshold),
    )
    onCleanup(() => timers.forEach(clearTimeout))
  })

  return (
    <section class="nova-dawn" aria-label="NovaClaw" data-phase={phase()}>
      <div class="nova-dawn-art" aria-hidden="true">
        <div class="nova-dawn-nebula" />
        <svg class="nova-dawn-sky" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
          <For each={stars}>
            {(star) => <circle cx={star.x} cy={star.y} r={star.radius} fill="#e6def4" opacity={star.opacity} />}
          </For>
          <g fill="none" stroke="#b89760" stroke-width="0.7" opacity="0.24">
            <path d="M165 130h80m-40-40v80m-28-68 56 56m0-56-56 56M1395 180h70m-35-35v70" />
            <circle cx="205" cy="130" r="23" />
            <circle cx="1430" cy="180" r="15" />
            <path d="m130 420 94-32 50 94-94 32zm14 5 34 66 78-27-34-66zm1190-119 106 25-17 67-106-25zm7 9-11 44 83 19 11-44" />
          </g>
          <g fill="none" stroke="#627196" stroke-width="0.8" opacity="0.3">
            <path d="m0 604 164-18 89-42 57 9 57 30 51 6 51 15m662 0 52-11 59-24 52-4 72 24 134 15" />
            <path d="m145 604 107-59 25 60m-67-1 42-59 58 8 26 52m-84-60 114 38-26 22m836-1 64-33 4 34m-62-13 109 12m-48-39 74 39" />
          </g>
        </svg>
        <div class="nova-dawn-aureole" />
        <div class="nova-dawn-floor">
          <svg viewBox="0 0 1600 360" preserveAspectRatio="none">
            <g fill="none" stroke="#b59960" stroke-width="0.7">
              <For each={Array.from({ length: 25 }, (_, index) => index - 12)}>
                {(line) => <path d={`M${800 + line * 13} 0 ${800 + line * 240} 360`} />}
              </For>
              <For each={[4, 10, 21, 39, 66, 104, 155, 224, 315]}>{(y) => <path d={`M0 ${y}H1600`} />}</For>
            </g>
          </svg>
        </div>
        <div class="nova-dawn-emblem">
          <div class="nova-dawn-rise">
            <svg viewBox="0 0 1024 1024" fill="none" class="nova-dawn-seal">
              <defs>
                <mask
                  id={`${id}-shape`}
                  maskUnits="userSpaceOnUse"
                  x="0"
                  y="0"
                  width="1024"
                  height="1024"
                  style={{ "mask-type": "luminance" }}
                >
                  <image href={silhouette} width="1024" height="1024" />
                </mask>
                <linearGradient id={`${id}-gold`} x1="120" y1="100" x2="910" y2="950" gradientUnits="userSpaceOnUse">
                  <stop stop-color="#50312d" />
                  <stop offset="0.18" stop-color="#ae8249" />
                  <stop offset="0.29" stop-color="#fff0b2" />
                  <stop offset="0.34" stop-color="#c29b58" />
                  <stop offset="0.48" stop-color="#f4d895" />
                  <stop offset="0.62" stop-color="#8d6033" />
                  <stop offset="0.75" stop-color="#e0bb72" />
                  <stop offset="0.87" stop-color="#634133" />
                  <stop offset="1" stop-color="#d5b277" />
                </linearGradient>
                <radialGradient id={`${id}-iris`}>
                  <stop offset="0.41" stop-color="#040610" />
                  <stop offset="0.48" stop-color="#275547" />
                  <stop offset="0.65" stop-color="#396c64" />
                  <stop offset="0.8" stop-color="#5b3d7c" />
                  <stop offset="0.95" stop-color="#292038" />
                  <stop offset="1" stop-color="#100c1b" />
                </radialGradient>
                <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0.25" stop-color="#fff0c7" stop-opacity="0" />
                  <stop offset="0.45" stop-color="#fff0c7" stop-opacity="0.5" />
                  <stop offset="0.52" stop-color="#fff8df" stop-opacity="0.8" />
                  <stop offset="0.6" stop-color="#fff0c7" stop-opacity="0" />
                </linearGradient>
                <filter id={`${id}-metal`} x="0" y="0" width="100%" height="100%">
                  <feTurbulence type="fractalNoise" baseFrequency="0.7 0.035" numOctaves="2" seed="8" result="grain" />
                  <feColorMatrix in="grain" type="saturate" values="0" />
                  <feComponentTransfer>
                    <feFuncA type="linear" slope="0.23" />
                  </feComponentTransfer>
                  <feBlend in="SourceGraphic" ref={(blend) => blend.setAttribute("mode", "soft-light")} />
                </filter>
                <filter id={`${id}-bevel`} x="-2%" y="-2%" width="104%" height="104%">
                  <feGaussianBlur in="SourceAlpha" stdDeviation="2.4" result="edge" />
                  <feSpecularLighting
                    in="edge"
                    surfaceScale="5"
                    specularConstant="0.7"
                    specularExponent="24"
                    lighting-color="#fff2c6"
                    result="light"
                  >
                    <feDistantLight azimuth="235" elevation="50" />
                  </feSpecularLighting>
                  <feComposite in="light" in2="SourceAlpha" operator="in" result="metal-edge" />
                  <feBlend in="SourceGraphic" in2="metal-edge" mode="screen" />
                </filter>
              </defs>
              <g class="nova-dawn-field" stroke="#d8b470" stroke-width="0.8">
                <For each={fieldLines}>
                  {(line) => (
                    <path
                      d={`M-310 326 C-60 326 75 ${326 + line * 24} 210 ${326 + line * 12} S420 326 514 326 S680 ${326 - line * 24} 818 ${326 - line * 12} S1080 326 1334 326`}
                    />
                  )}
                </For>
              </g>
              <g class="nova-dawn-orbits" stroke="#c8a568" stroke-width="1">
                <For each={rings}>{(radius) => <circle cx="514" cy="326" r={radius} />}</For>
                <For each={Array.from({ length: 48 }, (_, index) => index * 7.5)}>
                  {(angle) => <path d="M514 2v12M514 626v24" transform={`rotate(${angle} 514 326)`} />}
                </For>
                <path d="m285 97 458 458m0-458L285 555M182 326h664M514-8v36m0 596v36" />
              </g>
              <g class="nova-dawn-city" fill="#0c1521" stroke="#619caa" stroke-width="1.2">
                <path d="M331 652v-48h15v48m7 0v-99h21v99m12 0V531l14-14 14 14v121m14 0v-66h20v66m14 0V504l12-20 12 20v148m12 0V551l22-14v115m12 0V510l14-15 14 15v142m14 0v-83l20-11v94m14 0V518l12-15 12 15v134m14 0v-75h29v75m13 0v-56h20v56" />
                <path
                  d="M398 517v-35m77 3v-46m140 65v-33M357 568v69m39-98v98m77-122v122m72-114v114m69-107v107m39-43v43"
                  stroke-dasharray="2 5"
                  opacity="0.65"
                />
              </g>
              <g filter={paint("bevel")}>
                <g mask={paint("shape")}>
                  <rect width="1024" height="1024" fill={paint("gold")} filter={paint("metal")} />
                  <g stroke="#39232b" stroke-width="2" opacity="0.65">
                    <path d="M94 637C62 451 353 354 398 233Q508 91 638 236C738 379 1010 439 922 689M127 667C98 460 366 370 417 247Q513 128 620 250C743 413 974 454 891 696" />
                    <path d="M115 679Q128 804 259 895M143 699Q162 816 267 890M905 682Q891 809 762 894M879 705Q848 834 755 895M418 459Q512 514 621 464M436 475Q520 524 602 482" />
                  </g>
                  <g stroke="#fff1bd" stroke-width="1.2" opacity="0.55">
                    <path d="M101 630C69 451 357 351 405 232Q511 102 632 239C738 386 1002 440 916 683M119 678Q139 808 259 891M903 684Q884 810 764 888" />
                    <path d="M493 171v-12h42v12m-21-30v50m-14-37 28 24m0-24-28 24M492 450v28m20-23v28m20-28v26" />
                  </g>
                  <rect class="nova-dawn-sheen" x="-1024" width="1024" height="1024" fill={paint("sheen")} />
                </g>
              </g>
              <g class="nova-dawn-iris">
                <circle cx="514" cy="326" r="87" fill="#0c0b14" stroke="#c5a46b" stroke-width="2" />
                <circle cx="514" cy="326" r="83" fill={paint("iris")} />
                <g stroke-width="0.85">
                  <For each={irisFibres}>
                    {(fibre) => <path d={fibre.path} stroke={fibre.color} opacity={fibre.opacity} />}
                  </For>
                </g>
                <circle cx="514" cy="326" r="43" stroke="#88b996" stroke-width="0.6" opacity="0.45" />
                <circle class="nova-dawn-pupil" cx="514" cy="326" r="38" fill="#04050c" />
                <ellipse
                  cx="487"
                  cy="291"
                  rx="12"
                  ry="8"
                  fill="#fff0ca"
                  opacity="0.15"
                  transform="rotate(-35 487 291)"
                />
                <circle cx="540" cy="367" r="2" fill="#c3e3d9" opacity="0.4" />
              </g>
            </svg>
          </div>
        </div>
        <div class="nova-dawn-veil" />
        <div class="nova-dawn-horizon" />
        <div class="nova-dawn-vignette" />
      </div>
      <div class="nova-dawn-caption">
        <h1>NovaClaw</h1>
        <p role="status" aria-live="polite" aria-atomic="true">
          {props.message(phase())}
        </p>
      </div>
    </section>
  )
}

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  samples: { type: Array, required: true },
  autoplay: { type: Boolean, default: false }
})

const playing = ref(false)
const progress = ref(0) // 0..1
let animationFrame = null
let playStart = 0
let playOffset = 0

const duration = computed(() => {
  if (props.samples.length < 2) return 0
  return Math.max(0, props.samples.at(-1).timestamp - props.samples[0].timestamp)
})

const durationLabel = computed(() => `${(duration.value / 1000).toFixed(1)}s`)

const baseline = computed(() => props.samples[0] ?? null)

// Find the sample at the current progress point
const currentFrame = computed(() => {
  if (!props.samples.length || !baseline.value) return null
  const t0 = baseline.value.timestamp
  const elapsed = progress.value * duration.value
  const targetTime = t0 + elapsed

  // Binary-ish search for the closest sample
  let best = 0
  for (let i = 1; i < props.samples.length; i++) {
    if (Math.abs(props.samples[i].timestamp - targetTime) <
        Math.abs(props.samples[best].timestamp - targetTime)) {
      best = i
    }
  }
  return props.samples[best]
})

// Compute wand transform from orientation deltas relative to baseline
const wandTransform = computed(() => {
  if (!currentFrame.value || !baseline.value) {
    return { transform: 'rotateX(0deg) rotateY(0deg) rotateZ(0deg)' }
  }

  const s = currentFrame.value
  const b = baseline.value

  // Pitch (beta): tilting phone forward/back → wand tips forward/back
  const pitch = angleDelta(s.orientation?.beta, b.orientation?.beta)
  // Roll (gamma): tilting phone left/right → wand rolls
  const roll = angleDelta(s.orientation?.gamma, b.orientation?.gamma)
  // Heading: rotating phone → wand sweeps left/right
  const yaw = angleDelta(s.orientation?.compassHeading, b.orientation?.compassHeading)

  // Acceleration-driven translation (subtle position shift)
  const ax = num(s.acceleration?.x) - num(b.acceleration?.x)
  const ay = num(s.acceleration?.y) - num(b.acceleration?.y)
  const translateX = clamp(ax * 3, -40, 40)
  const translateY = clamp(-ay * 3, -40, 40)

  return {
    transform: [
      `translate(${translateX.toFixed(1)}px, ${translateY.toFixed(1)}px)`,
      `rotateY(${clamp(-yaw, -90, 90).toFixed(1)}deg)`,
      `rotateX(${clamp(-pitch, -90, 90).toFixed(1)}deg)`,
      `rotateZ(${clamp(roll, -90, 90).toFixed(1)}deg)`
    ].join(' ')
  }
})

// Energy glow intensity based on acceleration magnitude
const energyIntensity = computed(() => {
  if (!currentFrame.value) return 0
  const a = currentFrame.value.acceleration
  const mag = Math.sqrt(num(a?.x) ** 2 + num(a?.y) ** 2 + num(a?.z) ** 2)
  return clamp(mag / 12, 0, 1)
})

// Trail: recent positions for the wand tip path
const trail = computed(() => {
  if (!props.samples.length || !baseline.value) return []
  const t0 = baseline.value.timestamp
  const elapsed = progress.value * duration.value
  const targetTime = t0 + elapsed

  // Collect the last ~300ms of samples
  const trailDuration = 300
  const points = []
  for (let i = 0; i < props.samples.length; i++) {
    const dt = props.samples[i].timestamp - t0
    if (dt > elapsed) break
    if (dt >= elapsed - trailDuration) {
      const s = props.samples[i]
      const roll = angleDelta(s.orientation?.gamma, baseline.value.orientation?.gamma)
      const pitch = angleDelta(s.orientation?.beta, baseline.value.orientation?.beta)
      const ax = num(s.acceleration?.x) - num(baseline.value.acceleration?.x)
      const ay = num(s.acceleration?.y) - num(baseline.value.acceleration?.y)
      // Project the wand tip into 2D space
      const tipX = 50 + clamp(ax * 3, -40, 40) + clamp(roll * 0.5, -25, 25)
      const tipY = 20 + clamp(-ay * 3, -40, 40) + clamp(-pitch * 0.4, -20, 20)
      const age = (elapsed - dt) / trailDuration // 0=newest, 1=oldest
      points.push({ x: tipX, y: tipY, age })
    }
  }
  return points
})

const trailPath = computed(() => {
  if (trail.value.length < 2) return ''
  return trail.value.map((p, i) =>
    `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`
  ).join(' ')
})

function angleDelta(current, base) {
  if (current == null || base == null) return 0
  return ((current - base + 540) % 360) - 180
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v))
}

function tick() {
  if (!playing.value) return
  const elapsed = performance.now() - playStart + playOffset
  const p = elapsed / duration.value
  if (p >= 1) {
    progress.value = 1
    playing.value = false
    return
  }
  progress.value = p
  animationFrame = requestAnimationFrame(tick)
}

function play() {
  if (!duration.value) return
  if (progress.value >= 1) progress.value = 0
  playOffset = progress.value * duration.value
  playStart = performance.now()
  playing.value = true
  animationFrame = requestAnimationFrame(tick)
}

function pause() {
  playing.value = false
  if (animationFrame) {
    cancelAnimationFrame(animationFrame)
    animationFrame = null
  }
}

function togglePlay() {
  playing.value ? pause() : play()
}

function scrub(event) {
  const val = Number(event.target.value)
  progress.value = val / 1000
  if (playing.value) {
    playOffset = progress.value * duration.value
    playStart = performance.now()
  }
}

function rewind() {
  pause()
  progress.value = 0
}

watch(() => props.autoplay, (auto) => {
  if (auto && duration.value > 0) play()
})

onBeforeUnmount(() => {
  if (animationFrame) cancelAnimationFrame(animationFrame)
})
</script>

<template>
  <div class="wand-preview" v-if="samples.length >= 8">
    <!-- Stage -->
    <div class="wand-stage">
      <div class="wand-viewport">
        <!-- Trail SVG -->
        <svg class="wand-trail-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path
            v-if="trailPath"
            :d="trailPath"
            fill="none"
            stroke="url(#trailGrad)"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <defs>
            <linearGradient id="trailGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="rgba(255,156,115,0)" />
              <stop offset="100%" stop-color="rgba(255,156,115,0.7)" />
            </linearGradient>
          </defs>
        </svg>

        <!-- Wand model -->
        <div class="wand-model" :style="wandTransform">
          <!-- Glow aura -->
          <div
            class="wand-glow"
            :style="{ opacity: 0.15 + energyIntensity * 0.6 }"
          ></div>
          <!-- Wand body -->
          <div class="wand-shaft">
            <div class="wand-handle"></div>
            <div class="wand-tip">
              <div
                class="wand-tip-spark"
                :style="{ opacity: energyIntensity * 0.9 }"
              ></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Shadow on the "floor" -->
      <div class="wand-shadow" :style="{
        opacity: 0.15 + energyIntensity * 0.1,
        transform: `scaleX(${1 + energyIntensity * 0.3})`
      }"></div>
    </div>

    <!-- Controls -->
    <div class="wand-controls">
      <button class="wand-btn" @click="togglePlay" :title="playing ? 'Pause' : 'Play'">
        {{ playing ? '⏸' : '▶' }}
      </button>
      <button class="wand-btn" @click="rewind" title="Rewind">⏮</button>
      <input
        class="wand-scrubber"
        type="range"
        min="0"
        max="1000"
        :value="Math.round(progress * 1000)"
        @input="scrub"
      />
      <span class="wand-time">
        {{ ((progress * duration) / 1000).toFixed(1) }}s / {{ durationLabel }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.wand-preview {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.wand-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 1.5rem 1rem 0.5rem;
  background: radial-gradient(ellipse at center 40%, rgba(255,156,115,0.06) 0%, transparent 65%),
              rgba(8, 8, 18, 0.5);
  border-radius: 16px;
  overflow: hidden;
  min-height: 180px;
}

.wand-viewport {
  position: relative;
  width: 100%;
  height: 140px;
  perspective: 500px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.wand-trail-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
}

.wand-model {
  position: relative;
  transform-style: preserve-3d;
  transition: transform 30ms linear;
  z-index: 1;
}

.wand-glow {
  position: absolute;
  top: -20px;
  left: 50%;
  width: 60px;
  height: 60px;
  margin-left: -30px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255,156,115,0.5) 0%, transparent 70%);
  pointer-events: none;
  transition: opacity 80ms ease;
}

.wand-shaft {
  position: relative;
  width: 8px;
  height: 110px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.wand-shaft::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  width: 6px;
  margin-left: -3px;
  height: 100%;
  border-radius: 3px 3px 4px 4px;
  background: linear-gradient(
    180deg,
    #c8a87a 0%,
    #a07850 30%,
    #7a5838 60%,
    #5a3c22 100%
  );
  box-shadow:
    inset -1px 0 2px rgba(0,0,0,0.3),
    inset 1px 0 1px rgba(255,220,180,0.15);
}

.wand-handle {
  position: absolute;
  bottom: 0;
  left: 50%;
  width: 10px;
  margin-left: -5px;
  height: 30px;
  border-radius: 3px 3px 5px 5px;
  background: linear-gradient(
    180deg,
    #5a3c22 0%,
    #3d2610 100%
  );
  box-shadow: inset 0 -2px 4px rgba(0,0,0,0.4);
  z-index: 1;
}

.wand-handle::after {
  content: '';
  position: absolute;
  top: 4px;
  left: 1px;
  right: 1px;
  height: 2px;
  border-radius: 1px;
  background: rgba(200, 168, 122, 0.3);
}

.wand-tip {
  position: absolute;
  top: -2px;
  left: 50%;
  width: 4px;
  height: 4px;
  margin-left: -2px;
  border-radius: 50%;
  background: #ffe4c8;
  z-index: 2;
}

.wand-tip-spark {
  position: absolute;
  top: -6px;
  left: -6px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255,200,120,0.9) 0%, rgba(255,156,115,0.4) 40%, transparent 70%);
  transition: opacity 60ms ease;
  pointer-events: none;
}

.wand-shadow {
  width: 60px;
  height: 8px;
  margin-top: 0.5rem;
  border-radius: 50%;
  background: rgba(0,0,0,0.25);
  filter: blur(3px);
  transition: transform 100ms ease, opacity 100ms ease;
}

/* Controls */
.wand-controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.25rem;
}

.wand-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  background: rgba(255,255,255,0.04);
  color: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 120ms;
}

.wand-btn:hover {
  background: rgba(255,255,255,0.1);
}

.wand-scrubber {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(255,255,255,0.1);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}

.wand-scrubber::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent-coral, #ff9c73);
  border: 2px solid rgba(0,0,0,0.3);
  cursor: pointer;
}

.wand-scrubber::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent-coral, #ff9c73);
  border: 2px solid rgba(0,0,0,0.3);
  cursor: pointer;
}

.wand-time {
  font-size: 0.78rem;
  color: rgba(255,255,255,0.5);
  white-space: nowrap;
  min-width: 5.5em;
  text-align: right;
}
</style>

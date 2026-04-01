<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TracePanel from './components/TracePanel.vue'
import VectorBars from './components/VectorBars.vue'
import { useMotionSensors } from './composables/useMotionSensors'
import {
  compareRecordings,
  compactSamples,
  createInstructionGuide,
  createInstructionSteps,
  extractMetrics
} from './lib/gestureMath'
import {
  buildSpellRecord,
  createSpellId,
  loadSpellbook,
  saveSpellbook
} from './lib/spellStore'

const {
  clearHistory,
  currentSample,
  history,
  isListening,
  lastError,
  onSample,
  permissionState,
  start
} = useMotionSensors()

const spellbook = ref([])
const spellName = ref('Lumos Arc')
const recordingMode = ref('')
const capturedSamples = ref([])
const selectedSpellId = ref('')
const latestComparison = ref(null)
const statusMessage = ref('Enable the sensors and move the phone like a wand.')
const lastHapticGuideIndex = ref(-1)
const audioFeedbackMode = ref('none')
const safeDialEnabled = ref(false)
const safeDialZeroAngle = ref(0)
const safeDialLastAngle = ref(null)
const safeDialAccumulatedAngle = ref(0)
const safeDialNotchIndex = ref(0)
const safeDialTickCount = ref(0)
const safeDialLastDelta = ref(0)

const SAFE_DIAL_NOTCH_DEGREES = 12

const accelTraceFields = [
  { label: 'ax', path: 'acceleration.x', color: '#ff9c73', scale: 12 },
  { label: 'ay', path: 'acceleration.y', color: '#ffd56b', scale: 12 },
  { label: 'az', path: 'acceleration.z', color: '#7ed5ff', scale: 12 }
]

const rotationTraceFields = [
  { label: 'α', path: 'rotationRate.alpha', color: '#9e88ff', scale: 240 },
  { label: 'β', path: 'rotationRate.beta', color: '#ff82b2', scale: 240 },
  { label: 'γ', path: 'rotationRate.gamma', color: '#7be6bf', scale: 240 }
]

const selectedSpell = computed(
  () => spellbook.value.find((spell) => spell.id === selectedSpellId.value) ?? null
)
const selectedGuide = computed(() =>
  selectedSpell.value ? createInstructionGuide(selectedSpell.value.samples) : []
)
const selectedGuideDurationMs = computed(() => {
  if (selectedGuide.value.length) {
    return selectedGuide.value.at(-1).endMs
  }

  return selectedSpell.value?.metrics.durationMs ?? 0
})
const safeDialAbsoluteAngle = computed(() => {
  const heading = currentSample.value.orientation.compassHeading

  if (typeof heading === 'number') {
    return heading
  }

  const alpha = currentSample.value.orientation.alpha

  if (typeof alpha === 'number') {
    return ((360 - alpha + 360) % 360)
  }

  return null
})
const safeDialRelativeAngle = computed(() => {
  if (safeDialAbsoluteAngle.value == null) {
    return null
  }

  return ((safeDialAbsoluteAngle.value - safeDialZeroAngle.value + 360) % 360)
})
const safeDialTurnDisplay = computed(() => {
  const signed = Math.round(safeDialAccumulatedAngle.value)
  return `${signed >= 0 ? '+' : ''}${signed}°`
})
const safeDialDirectionLabel = computed(() => {
  if (Math.abs(safeDialLastDelta.value) < 1.5) {
    return 'Holding'
  }

  return safeDialLastDelta.value > 0 ? 'Clockwise' : 'Counter-clockwise'
})
const safeDialFeedbackLabel = computed(() => {
  if (audioFeedbackMode.value === 'vibrate') {
    return 'Haptic detents'
  }

  if (audioFeedbackMode.value === 'audio') {
    return 'Audio detents'
  }

  return 'Visual only'
})

const liveAcceleration = computed(() => [
  {
    label: 'X',
    value: currentSample.value.acceleration.x,
    color: 'linear-gradient(90deg, rgba(255,117,86,0.15), #ff9c73)',
    scale: 12,
    unit: ' m/s²'
  },
  {
    label: 'Y',
    value: currentSample.value.acceleration.y,
    color: 'linear-gradient(90deg, rgba(255,202,79,0.15), #ffd56b)',
    scale: 12,
    unit: ' m/s²'
  },
  {
    label: 'Z',
    value: currentSample.value.acceleration.z,
    color: 'linear-gradient(90deg, rgba(89,201,255,0.15), #7ed5ff)',
    scale: 12,
    unit: ' m/s²'
  }
])

const liveRotation = computed(() => [
  {
    label: 'α',
    value: currentSample.value.rotationRate.alpha,
    color: 'linear-gradient(90deg, rgba(151,128,255,0.15), #9e88ff)',
    scale: 240,
    unit: ' °/s'
  },
  {
    label: 'β',
    value: currentSample.value.rotationRate.beta,
    color: 'linear-gradient(90deg, rgba(255,97,160,0.15), #ff82b2)',
    scale: 240,
    unit: ' °/s'
  },
  {
    label: 'γ',
    value: currentSample.value.rotationRate.gamma,
    color: 'linear-gradient(90deg, rgba(74,225,176,0.15), #7be6bf)',
    scale: 240,
    unit: ' °/s'
  }
])

const liveOrientation = computed(() => [
  {
    label: 'Heading',
    value: currentSample.value.orientation.compassHeading,
    color: 'linear-gradient(90deg, rgba(255,214,112,0.15), #ffd56b)',
    scale: 180,
    unit: '°'
  },
  {
    label: 'Pitch',
    value: currentSample.value.orientation.beta,
    color: 'linear-gradient(90deg, rgba(93,206,255,0.15), #7ed5ff)',
    scale: 180,
    unit: '°'
  },
  {
    label: 'Roll',
    value: currentSample.value.orientation.gamma,
    color: 'linear-gradient(90deg, rgba(181,114,255,0.15), #b98eff)',
    scale: 90,
    unit: '°'
  }
])

const recordingMetrics = computed(() => extractMetrics(capturedSamples.value))

const comparisonTone = computed(() => {
  if (!latestComparison.value) {
    return 'idle'
  }

  return latestComparison.value.verdict
})
const copyProgressPercent = computed(() => {
  if (recordingMode.value !== 'attempt' || !selectedGuideDurationMs.value) {
    return 0
  }

  return Math.min(
    100,
    Math.round((recordingMetrics.value.durationMs / selectedGuideDurationMs.value) * 100)
  )
})
const activeGuideIndex = computed(() => {
  if (!selectedGuide.value.length) {
    return -1
  }

  if (recordingMode.value !== 'attempt') {
    return -1
  }

  const elapsedMs = recordingMetrics.value.durationMs
  const foundIndex = selectedGuide.value.findIndex(
    (segment) => elapsedMs >= segment.startMs && elapsedMs < segment.endMs
  )

  return foundIndex === -1 ? selectedGuide.value.length - 1 : foundIndex
})
const activeGuide = computed(() =>
  activeGuideIndex.value >= 0 ? selectedGuide.value[activeGuideIndex.value] : null
)

const canStartTemplate = computed(() => recordingMode.value === '')
const canSaveTemplate = computed(
  () => recordingMode.value === 'template' && capturedSamples.value.length >= 8
)
const canStartAttempt = computed(
  () => recordingMode.value === '' && Boolean(selectedSpell.value)
)
const canScoreAttempt = computed(
  () => recordingMode.value === 'attempt' && capturedSamples.value.length >= 8
)
const recordingLabel = computed(() => {
  if (recordingMode.value === 'template') {
    return 'Recording template'
  }

  if (recordingMode.value === 'attempt') {
    return 'Recording copy'
  }

  return 'Idle'
})

function cloneSample(sample) {
  if (typeof structuredClone === 'function') {
    return structuredClone(sample)
  }

  return JSON.parse(JSON.stringify(sample))
}

let audioContext = null

function canVibrate() {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.vibrate === 'function'
  )
}

async function primeAudioFeedback() {
  if (typeof window === 'undefined') {
    audioFeedbackMode.value = 'none'
    return false
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext

  if (!AudioContextClass) {
    audioFeedbackMode.value = 'none'
    return false
  }

  try {
    if (!audioContext) {
      audioContext = new AudioContextClass()
    }

    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }

    audioFeedbackMode.value = 'audio'
    return true
  } catch {
    audioFeedbackMode.value = 'none'
    return false
  }
}

function playBeepPattern(pattern) {
  if (!audioContext) {
    return
  }

  const segments = Array.isArray(pattern) ? pattern : [pattern]
  let offsetMs = 0

  segments.forEach((segmentMs, index) => {
    if (index % 2 === 1) {
      offsetMs += segmentMs
      return
    }

    const startTime = audioContext.currentTime + offsetMs / 1000
    const durationSeconds = Math.max(segmentMs, 25) / 1000
    const oscillator = audioContext.createOscillator()
    const gainNode = audioContext.createGain()

    oscillator.type = index === 0 ? 'triangle' : 'sine'
    oscillator.frequency.setValueAtTime(index === 0 ? 880 : 1175, startTime)

    gainNode.gain.setValueAtTime(0.0001, startTime)
    gainNode.gain.exponentialRampToValueAtTime(0.045, startTime + 0.01)
    gainNode.gain.exponentialRampToValueAtTime(
      0.0001,
      startTime + durationSeconds
    )

    oscillator.connect(gainNode)
    gainNode.connect(audioContext.destination)
    oscillator.start(startTime)
    oscillator.stop(startTime + durationSeconds + 0.02)

    offsetMs += segmentMs
  })
}

function triggerHaptic(pattern) {
  if (canVibrate()) {
    audioFeedbackMode.value = 'vibrate'
    navigator.vibrate(pattern)
    return
  }

  if (audioFeedbackMode.value === 'audio') {
    playBeepPattern(pattern)
  }
}

async function primePhaseFeedback() {
  if (canVibrate()) {
    audioFeedbackMode.value = 'vibrate'
    return true
  }

  return primeAudioFeedback()
}

function triggerSuccessFeedback() {
  if (canVibrate()) {
    audioFeedbackMode.value = 'vibrate'
    navigator.vibrate([80, 40, 120])
    return
  }

  if (audioFeedbackMode.value === 'audio') {
    playBeepPattern([90, 50, 130])
  }
}

function feedbackHint() {
  if (audioFeedbackMode.value === 'vibrate') {
    return 'Phase cues will use haptics.'
  }

  if (audioFeedbackMode.value === 'audio') {
    return 'Phase cues will use short beeps.'
  }

  return 'Phase cues are visual only on this device.'
}

function wrapAngleDelta(current, previous) {
  return ((current - previous + 540) % 360) - 180
}

function buildTickPattern(stepCount) {
  const cappedSteps = Math.max(1, Math.min(stepCount, 4))
  const pattern = []

  for (let index = 0; index < cappedSteps; index += 1) {
    pattern.push(14)

    if (index < cappedSteps - 1) {
      pattern.push(24)
    }
  }

  return pattern
}

function getSafeDialNotchIndex(angle) {
  if (angle >= 0) {
    return Math.floor(angle / SAFE_DIAL_NOTCH_DEGREES)
  }

  return Math.ceil(angle / SAFE_DIAL_NOTCH_DEGREES)
}

function resetSafeDialBaseline(angle = safeDialAbsoluteAngle.value) {
  safeDialZeroAngle.value = angle ?? 0
  safeDialLastAngle.value = angle
  safeDialAccumulatedAngle.value = 0
  safeDialNotchIndex.value = 0
  safeDialTickCount.value = 0
  safeDialLastDelta.value = 0
}

async function toggleSafeDial() {
  if (safeDialEnabled.value) {
    safeDialEnabled.value = false
    safeDialLastAngle.value = safeDialAbsoluteAngle.value
    statusMessage.value = 'Safe dial off.'
    return
  }

  await primePhaseFeedback()

  const ready = await ensureSensorsReady(
    `Safe dial active. Rotate the phone to feel the detents. ${feedbackHint()}`
  )
  if (!ready) {
    return
  }

  safeDialEnabled.value = true
  resetSafeDialBaseline()
  triggerHaptic(22)
}

function calibrateSafeDial() {
  resetSafeDialBaseline()
  triggerHaptic(20)
  statusMessage.value = 'Safe dial zero reset.'
}

function persistSpellbook() {
  return saveSpellbook(spellbook.value)
}

function setSelectedSpell(id) {
  selectedSpellId.value = id
  latestComparison.value = null
}

async function enableSensors() {
  const allowed = await start()
  statusMessage.value = allowed
    ? 'Sensors live. Record a template spell or try to mimic an existing one.'
    : lastError.value || 'Unable to enable sensors.'
}

async function ensureSensorsReady(nextMessage) {
  if (isListening.value) {
    statusMessage.value = nextMessage
    return true
  }

  const allowed = await start()
  statusMessage.value = allowed
    ? nextMessage
    : lastError.value || 'Unable to enable sensors.'

  return allowed
}

function resetCapture(mode) {
  recordingMode.value = mode
  capturedSamples.value = []
  latestComparison.value = null
  lastHapticGuideIndex.value = -1
}

async function startTemplateRecording() {
  if (recordingMode.value) {
    statusMessage.value = 'Finish or cancel the current recording before starting another one.'
    return
  }

  const ready = await ensureSensorsReady(
    'Recording template spell. Move through the full gesture, then tap Save Template.'
  )
  if (!ready) {
    return
  }

  resetCapture('template')
}

async function startAttemptRecording() {
  if (!selectedSpell.value) {
    statusMessage.value = 'Choose a saved template before trying to copy it.'
    return
  }

  if (recordingMode.value) {
    statusMessage.value = 'Finish or cancel the current recording before starting another one.'
    return
  }

  await primePhaseFeedback()

  const ready = await ensureSensorsReady(
    `Recording your copy of ${selectedSpell.value.name}. Follow the movement guide, then tap Score Copy. ${feedbackHint()}`
  )
  if (!ready) {
    return
  }

  resetCapture('attempt')
}

function cancelRecording() {
  if (!recordingMode.value) {
    return
  }

  const cancelledMode = recordingMode.value
  recordingMode.value = ''
  capturedSamples.value = []
  lastHapticGuideIndex.value = -1
  statusMessage.value =
    cancelledMode === 'template'
      ? 'Template recording cancelled.'
      : 'Copy attempt cancelled.'
}

function stopRecording() {
  if (!recordingMode.value) {
    return
  }

  const sampleCount = capturedSamples.value.length

  if (sampleCount < 8) {
    recordingMode.value = ''
    statusMessage.value =
      'The motion was too short to save. Keep moving for about a second, then save again.'
    return
  }

  if (recordingMode.value === 'template') {
    const cleanName = spellName.value.trim() || `Spell ${spellbook.value.length + 1}`
    const compacted = compactSamples(capturedSamples.value)
    const spell = buildSpellRecord({
      id: createSpellId(),
      name: cleanName,
      createdAt: new Date().toISOString(),
      metrics: extractMetrics(compacted),
      instructions: createInstructionSteps(compacted),
      samples: compacted
    })

    spellbook.value = [spell, ...spellbook.value].slice(0, 18)
    setSelectedSpell(spell.id)
    const persisted = persistSpellbook()
    statusMessage.value = persisted
      ? `${spell.name} saved. Select it below and use Copy Mode to mimic it.`
      : `${spell.name} was recorded, but this browser blocked local storage. Keep this tab open or enable storage access.`
  } else if (selectedSpell.value) {
    latestComparison.value = compareRecordings(
      selectedSpell.value.samples,
      capturedSamples.value
    )

    if (latestComparison.value.score >= 86) {
      triggerSuccessFeedback()
    }

    statusMessage.value = `Copy attempt scored ${latestComparison.value.score}/100.`
  }

  recordingMode.value = ''
  lastHapticGuideIndex.value = -1
}

function removeSpell(id) {
  const removedSpell = spellbook.value.find((spell) => spell.id === id)
  spellbook.value = spellbook.value.filter((spell) => spell.id !== id)

  if (selectedSpellId.value === id) {
    selectedSpellId.value = spellbook.value[0]?.id ?? ''
  }

  latestComparison.value = null
  persistSpellbook()
  statusMessage.value = removedSpell
    ? `${removedSpell.name} deleted.`
    : 'Template deleted.'
}

const stopSampleSubscription = onSample((sample) => {
  if (!recordingMode.value || !sample.timestamp) {
    return
  }

  capturedSamples.value = [...capturedSamples.value, cloneSample(sample)]
})

watch(
  () => spellbook.value.length,
  (count) => {
    if (count && !selectedSpellId.value) {
      selectedSpellId.value = spellbook.value[0].id
    }
  }
)

watch(activeGuideIndex, (index) => {
  if (recordingMode.value !== 'attempt' || index < 0) {
    return
  }

  if (index === lastHapticGuideIndex.value) {
    return
  }

  lastHapticGuideIndex.value = index

  if (index === 0) {
    triggerHaptic([50, 40, 50])
    return
  }

  triggerHaptic(35)
})

watch(safeDialAbsoluteAngle, (angle) => {
  if (!safeDialEnabled.value || angle == null) {
    return
  }

  if (recordingMode.value) {
    safeDialLastAngle.value = angle
    return
  }

  if (safeDialLastAngle.value == null) {
    safeDialLastAngle.value = angle
    return
  }

  const delta = wrapAngleDelta(angle, safeDialLastAngle.value)
  safeDialLastAngle.value = angle

  if (Math.abs(delta) < 1.5) {
    return
  }

  safeDialLastDelta.value = delta
  safeDialAccumulatedAngle.value += delta

  const nextNotchIndex = getSafeDialNotchIndex(safeDialAccumulatedAngle.value)
  const crossedSteps = Math.abs(nextNotchIndex - safeDialNotchIndex.value)

  if (!crossedSteps) {
    return
  }

  safeDialTickCount.value += crossedSteps
  safeDialNotchIndex.value = nextNotchIndex
  triggerHaptic(buildTickPattern(crossedSteps))
})

onMounted(() => {
  spellbook.value = loadSpellbook()
  selectedSpellId.value = spellbook.value[0]?.id ?? ''
})

onBeforeUnmount(() => {
  stopSampleSubscription()
})
</script>

<template>
  <main class="app-shell">
    <section class="hero panel">
      <div class="hero__copy">
        <p class="eyebrow">PWA Wand Lab</p>
        <h1>Capture smartphone motion and turn it into repeatable spell gestures.</h1>
        <p class="hero__lede">
          This app listens to accelerometer, gyroscope, and compass data, saves
          motion patterns locally, and scores how closely a new attempt matches
          a recorded spell.
        </p>
        <div class="hero__actions">
          <button class="button button--primary" @click="enableSensors">
            {{ isListening ? 'Sensors Active' : 'Enable Sensors' }}
          </button>
          <button class="button button--ghost" @click="clearHistory">
            Clear Live Trace
          </button>
        </div>
      </div>
      <div class="status-orb">
        <span class="status-orb__ring"></span>
        <strong>{{ recordingLabel }}</strong>
        <small>{{ permissionState }}</small>
      </div>
    </section>

    <section class="status-strip panel">
      <div>
        <p class="label">Status</p>
        <strong>{{ statusMessage }}</strong>
      </div>
      <div>
        <p class="label">Sensors</p>
        <strong>{{ isListening ? 'streaming now' : 'ready after permission' }}</strong>
      </div>
      <div>
        <p class="label">Live heading</p>
        <strong>{{
          currentSample.orientation.compassHeading == null
            ? 'n/a'
            : `${currentSample.orientation.compassHeading.toFixed(0)}°`
        }}</strong>
      </div>
      <div>
        <p class="label">Recording</p>
        <strong>{{ capturedSamples.length }} samples</strong>
      </div>
    </section>

    <section class="dashboard">
      <div class="dashboard__live">
        <div class="panel stack">
          <div class="section-head">
            <div>
              <p class="eyebrow">Live telemetry</p>
              <h2>Sensor field</h2>
            </div>
            <p class="section-note">
              Start on a phone, grant motion permission, then move through the spell.
            </p>
          </div>
          <VectorBars title="Acceleration" :items="liveAcceleration" />
          <VectorBars title="Gyroscope" :items="liveRotation" />
          <VectorBars title="Orientation / compass" :items="liveOrientation" />
        </div>

        <div class="panel charts">
          <TracePanel
            title="Acceleration trace"
            :samples="history"
            :fields="accelTraceFields"
          />
          <TracePanel
            title="Rotation trace"
            :samples="history"
            :fields="rotationTraceFields"
          />
        </div>
      </div>

      <div class="dashboard__control">
        <section class="panel stack">
          <div class="section-head">
            <div>
              <p class="eyebrow">Record mode</p>
              <h2>Build a template spell</h2>
            </div>
          </div>

          <label class="field">
            <span>Spell name</span>
            <input v-model="spellName" type="text" maxlength="48" placeholder="Nebula Twist" />
          </label>

          <div class="button-row">
            <button
              class="button button--primary"
              :disabled="!canStartTemplate"
              @click="startTemplateRecording"
            >
              Start Template
            </button>
            <button
              class="button button--ghost"
              :disabled="!canSaveTemplate"
              @click="stopRecording"
            >
              Save Template
            </button>
            <button
              class="button button--ghost"
              :disabled="recordingMode !== 'template'"
              @click="cancelRecording"
            >
              Cancel
            </button>
          </div>

          <div class="button-row">
            <button
              class="button button--secondary"
              :disabled="!canStartAttempt"
              @click="startAttemptRecording"
            >
              Start Copy Mode
            </button>
            <button
              class="button button--ghost"
              :disabled="!canScoreAttempt"
              @click="stopRecording"
            >
              Score Copy
            </button>
            <button
              class="button button--ghost"
              :disabled="recordingMode !== 'attempt'"
              @click="cancelRecording"
            >
              Cancel
            </button>
          </div>

          <p class="comparison-copy">
            <template v-if="recordingMode === 'template'">
              Recording a new template. Move the phone now, then tap Save Template.
            </template>
            <template v-else-if="recordingMode === 'attempt'">
              Copying {{ selectedSpell?.name }}. Follow the saved movement guide, then tap Score Copy.
            </template>
            <template v-else>
              Start a template recording, or select a saved template and enter Copy Mode.
            </template>
          </p>

          <div class="metrics-grid">
            <article>
              <p class="label">Duration</p>
              <strong>{{ (recordingMetrics.durationMs / 1000).toFixed(1) }}s</strong>
            </article>
            <article>
              <p class="label">Peak accel</p>
              <strong>{{ recordingMetrics.peakAcceleration ?? 0 }}</strong>
            </article>
            <article>
              <p class="label">Peak rotation</p>
              <strong>{{ recordingMetrics.peakRotation ?? 0 }}</strong>
            </article>
            <article>
              <p class="label">Energy</p>
              <strong>{{ recordingMetrics.motionEnergy ?? 0 }}</strong>
            </article>
          </div>
        </section>

        <section class="panel stack">
          <div class="section-head">
            <div>
              <p class="eyebrow">Saved templates</p>
              <h2>Choose a motion to copy</h2>
            </div>
            <p class="section-note">{{ spellbook.length }} available</p>
          </div>

          <div v-if="spellbook.length" class="template-list">
            <article
              v-for="spell in spellbook"
              :key="spell.id"
              class="template-item"
              :class="{ 'template-item--selected': spell.id === selectedSpellId }"
            >
              <button class="template-item__body" @click="setSelectedSpell(spell.id)">
                <strong>{{ spell.name }}</strong>
                <span>{{ (spell.metrics.durationMs / 1000).toFixed(1) }}s</span>
                <span>{{ spell.metrics.sampleCount }} samples</span>
              </button>
              <button class="template-item__delete" @click="removeSpell(spell.id)">
                Delete
              </button>
            </article>
          </div>
          <p v-else class="empty-copy">
            No saved templates yet. Record one first, then it will appear here for selection.
          </p>
        </section>

        <section class="panel stack">
          <div class="section-head">
            <div>
              <p class="eyebrow">Mini mode</p>
              <h2>Safe dial</h2>
            </div>
            <span class="chip">{{ safeDialFeedbackLabel }}</span>
          </div>

          <div class="safe-dial">
            <div class="safe-dial__wheel">
              <span class="safe-dial__marker safe-dial__marker--top"></span>
              <span
                class="safe-dial__needle"
                :style="{
                  transform: `translateX(-50%) rotate(${safeDialRelativeAngle ?? 0}deg)`
                }"
              ></span>
              <strong>
                {{
                  safeDialRelativeAngle == null
                    ? 'n/a'
                    : `${safeDialRelativeAngle.toFixed(0)}°`
                }}
              </strong>
              <small>{{ safeDialEnabled ? 'active' : 'off' }}</small>
            </div>

            <div class="safe-dial__stats">
              <span>Turn {{ safeDialTurnDisplay }}</span>
              <span>Notch {{ safeDialNotchIndex }}</span>
              <span>{{ safeDialDirectionLabel }}</span>
              <span>{{ safeDialTickCount }} ticks</span>
            </div>
          </div>

          <div class="button-row">
            <button class="button button--secondary" @click="toggleSafeDial">
              {{ safeDialEnabled ? 'Stop Safe Dial' : 'Start Safe Dial' }}
            </button>
            <button
              class="button button--ghost"
              :disabled="!safeDialEnabled"
              @click="calibrateSafeDial"
            >
              Set Zero
            </button>
          </div>

          <p class="comparison-copy">
            Rotate the phone around its vertical axis. The dial emits a tick every
            {{ SAFE_DIAL_NOTCH_DEGREES }}° and uses haptics when available, otherwise short beeps.
          </p>
        </section>

        <section class="panel stack" v-if="selectedSpell">
          <div class="section-head">
            <div>
              <p class="eyebrow">Movement guide</p>
              <h2>{{ selectedSpell.name }}</h2>
            </div>
            <span class="chip">{{ selectedSpell.metrics.sampleCount }} samples</span>
          </div>

          <div class="spell-stats">
            <span>Duration {{ (selectedSpell.metrics.durationMs / 1000).toFixed(1) }}s</span>
            <span>Peak rotation {{ selectedSpell.metrics.peakRotation }}</span>
            <span>Heading span {{ selectedSpell.metrics.headingSpan }}°</span>
          </div>

          <div v-if="selectedGuide.length" class="guide-progress">
            <div class="guide-progress__header">
              <span class="label">Copy progress</span>
              <strong>
                {{
                  recordingMode === 'attempt'
                    ? `${copyProgressPercent}%`
                    : `${selectedGuide.length} phases`
                }}
              </strong>
            </div>
            <div class="guide-progress__track">
              <span
                class="guide-progress__fill"
                :style="{ width: `${copyProgressPercent}%` }"
              ></span>
            </div>
            <p class="comparison-copy">
              <template v-if="recordingMode === 'attempt' && activeGuide">
                Now: {{ activeGuide.motionSymbol }} {{ activeGuide.motionCue }} with
                {{ activeGuide.wristSymbol }} {{ activeGuide.wristCue }} for
                {{ activeGuide.durationLabel }}.
              </template>
              <template v-else>
                Use the phase cards below as the literal movement path for the copy attempt.
              </template>
            </p>
          </div>

          <div v-if="selectedGuide.length" class="guide-cards">
            <article
              v-for="segment in selectedGuide"
              :key="segment.index"
              class="guide-card"
              :class="{
                'guide-card--active':
                  recordingMode === 'attempt' && segment.index === activeGuideIndex
              }"
            >
              <span class="guide-card__phase">Phase {{ segment.index + 1 }}</span>
              <div class="guide-card__symbols">
                <strong>{{ segment.motionSymbol }}</strong>
                <strong>{{ segment.wristSymbol }}</strong>
              </div>
              <div class="guide-card__meta">
                <span>{{ segment.motionCue }}</span>
                <span>{{ segment.wristCue }}</span>
              </div>
              <p>{{ segment.stepText }}</p>
            </article>
          </div>

          <ol class="instruction-list">
            <li
              v-for="step in selectedGuide.length ? selectedGuide : selectedSpell.instructions"
              :key="selectedGuide.length ? step.index : step"
            >
              {{ selectedGuide.length ? step.stepText : step }}
            </li>
          </ol>

          <p class="comparison-copy">
            Select this template, tap Start Copy Mode, perform the steps above, then tap Score Copy.
          </p>
        </section>

        <section class="panel stack" :data-tone="comparisonTone">
          <div class="section-head">
            <div>
              <p class="eyebrow">Match result</p>
              <h2>Copy analysis</h2>
            </div>
          </div>

          <template v-if="latestComparison">
            <div class="score-card">
              <strong>{{ latestComparison.score }}</strong>
              <span>/ 100</span>
              <small>{{ latestComparison.verdict }}</small>
            </div>
            <p class="comparison-copy">
              Template duration {{ (latestComparison.templateMetrics.durationMs / 1000).toFixed(1) }}s,
              copy duration {{ (latestComparison.attemptMetrics.durationMs / 1000).toFixed(1) }}s.
            </p>
            <ul class="tips-list">
              <li v-for="tip in latestComparison.tips" :key="tip">{{ tip }}</li>
            </ul>
          </template>
          <p v-else class="comparison-copy">
            Record a copy attempt after selecting a spell to see similarity scoring and
            coaching tips.
          </p>
        </section>
      </div>
    </section>

  </main>
</template>

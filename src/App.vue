<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import TracePanel from './components/TracePanel.vue'
import VectorBars from './components/VectorBars.vue'
import { useMotionSensors } from './composables/useMotionSensors'
import {
  compareRecordings,
  compactSamples,
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
  permissionState,
  start
} = useMotionSensors()

const spellbook = ref([])
const spellName = ref('Lumos Arc')
const recordingMode = ref('')
const capturedSamples = ref([])
const selectedSpellId = ref('')
const lastCapturedTimestamp = ref(0)
const latestComparison = ref(null)
const statusMessage = ref('Enable the sensors and move the phone like a wand.')

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

function cloneSample(sample) {
  if (typeof structuredClone === 'function') {
    return structuredClone(sample)
  }

  return JSON.parse(JSON.stringify(sample))
}

function persistSpellbook() {
  saveSpellbook(spellbook.value)
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

function resetCapture(mode) {
  recordingMode.value = mode
  capturedSamples.value = []
  lastCapturedTimestamp.value = 0
  latestComparison.value = null
}

function startTemplateRecording() {
  if (!isListening.value) {
    statusMessage.value = 'Enable the sensors before recording.'
    return
  }

  resetCapture('template')
  statusMessage.value = 'Recording template spell. Move through the full gesture.'
}

function startAttemptRecording() {
  if (!selectedSpell.value) {
    statusMessage.value = 'Choose or record a spell before trying to copy it.'
    return
  }

  if (!isListening.value) {
    statusMessage.value = 'Enable the sensors before recording a copy.'
    return
  }

  resetCapture('attempt')
  statusMessage.value = `Copying ${selectedSpell.value.name}. Match its timing and wrist rotation.`
}

function stopRecording() {
  if (!recordingMode.value) {
    return
  }

  const sampleCount = capturedSamples.value.length

  if (sampleCount < 8) {
    recordingMode.value = ''
    statusMessage.value = 'The motion was too short. Record at least a second of movement.'
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
    persistSpellbook()
    statusMessage.value = `${spell.name} saved. Use Copy Mode to mimic it.`
  } else if (selectedSpell.value) {
    latestComparison.value = compareRecordings(
      selectedSpell.value.samples,
      capturedSamples.value
    )

    if (
      latestComparison.value.score >= 86 &&
      typeof navigator !== 'undefined' &&
      typeof navigator.vibrate === 'function'
    ) {
      navigator.vibrate([80, 40, 120])
    }

    statusMessage.value = `Copy attempt scored ${latestComparison.value.score}/100.`
  }

  recordingMode.value = ''
}

function removeSpell(id) {
  spellbook.value = spellbook.value.filter((spell) => spell.id !== id)

  if (selectedSpellId.value === id) {
    selectedSpellId.value = spellbook.value[0]?.id ?? ''
  }

  latestComparison.value = null
  persistSpellbook()
}

watch(
  () => currentSample.value.timestamp,
  (timestamp) => {
    if (!recordingMode.value || !timestamp || timestamp === lastCapturedTimestamp.value) {
      return
    }

    capturedSamples.value = [
      ...capturedSamples.value,
      cloneSample(currentSample.value)
    ]
    lastCapturedTimestamp.value = timestamp
  }
)

watch(
  () => spellbook.value.length,
  (count) => {
    if (count && !selectedSpellId.value) {
      selectedSpellId.value = spellbook.value[0].id
    }
  }
)

onMounted(() => {
  spellbook.value = loadSpellbook()
  selectedSpellId.value = spellbook.value[0]?.id ?? ''
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
        <strong>{{ recordingMode || 'idle' }}</strong>
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
        <strong>{{ recordingMetrics.sampleCount }} samples</strong>
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
              :disabled="recordingMode === 'attempt'"
              @click="startTemplateRecording"
            >
              Start Template
            </button>
            <button
              class="button button--ghost"
              :disabled="recordingMode !== 'template'"
              @click="stopRecording"
            >
              Save Template
            </button>
          </div>

          <div class="button-row">
            <button
              class="button button--secondary"
              :disabled="recordingMode === 'template' || !selectedSpell"
              @click="startAttemptRecording"
            >
              Start Copy Mode
            </button>
            <button
              class="button button--ghost"
              :disabled="recordingMode !== 'attempt'"
              @click="stopRecording"
            >
              Score Copy
            </button>
          </div>

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

        <section class="panel stack" v-if="selectedSpell">
          <div class="section-head">
            <div>
              <p class="eyebrow">Selected spell</p>
              <h2>{{ selectedSpell.name }}</h2>
            </div>
            <span class="chip">{{ selectedSpell.metrics.sampleCount }} samples</span>
          </div>

          <div class="spell-stats">
            <span>Duration {{ (selectedSpell.metrics.durationMs / 1000).toFixed(1) }}s</span>
            <span>Peak rotation {{ selectedSpell.metrics.peakRotation }}</span>
            <span>Heading span {{ selectedSpell.metrics.headingSpan }}°</span>
          </div>

          <ol class="instruction-list">
            <li v-for="step in selectedSpell.instructions" :key="step">{{ step }}</li>
          </ol>
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

    <section class="panel spellbook">
      <div class="section-head">
        <div>
          <p class="eyebrow">Spellbook</p>
          <h2>Saved gestures</h2>
        </div>
        <p class="section-note">{{ spellbook.length }} stored locally on this device</p>
      </div>

      <div v-if="spellbook.length" class="spell-grid">
        <article
          v-for="spell in spellbook"
          :key="spell.id"
          class="spell-card"
          :class="{ 'spell-card--selected': spell.id === selectedSpellId }"
        >
          <button class="spell-card__body" @click="setSelectedSpell(spell.id)">
            <div class="spell-card__header">
              <strong>{{ spell.name }}</strong>
              <span>{{ new Date(spell.createdAt).toLocaleDateString() }}</span>
            </div>
            <div class="spell-card__meta">
              <span>{{ (spell.metrics.durationMs / 1000).toFixed(1) }}s</span>
              <span>{{ spell.metrics.sampleCount }} pts</span>
              <span>{{ spell.metrics.peakRotation }}°/s</span>
            </div>
          </button>
          <button class="spell-card__delete" @click="removeSpell(spell.id)">Delete</button>
        </article>
      </div>
      <p v-else class="empty-copy">
        No spells yet. Record a template gesture and save it into the spellbook.
      </p>
    </section>
  </main>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CompassRose from './components/CompassRose.vue'
import TracePanel from './components/TracePanel.vue'
import VectorBars from './components/VectorBars.vue'
import WandPreview from './components/WandPreview.vue'
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
const safeDialLastDelta = ref(0)
const safeDialSequence = ref([
  { id: createSpellId(), direction: 'cw', degrees: 90 },
  { id: createSpellId(), direction: 'ccw', degrees: 50 }
])
const safeDialStepIndex = ref(0)
const safeDialStepStartTurn = ref(0)
const safeDialGuideTickIndex = ref(0)
const safeDialLastCompletedStep = ref(-1)
let safeDialSettleStart = 0
const waterBucketEnabled = ref(false)
const waterBucketBaseline = ref({
  beta: 0,
  gamma: 0
})
const waterBucketStartTimestamp = ref(0)
const waterBucketLastTimestamp = ref(0)
const waterBucketWaterLevel = ref(100)
const waterBucketBestTimeMs = ref(0)
const waterBucketLastDurationMs = ref(0)
const waterBucketSpillEvents = ref(0)
const waterBucketWasSpilling = ref(false)
const waterBucketDroplets = ref([])
const waterBucketMomentum = ref(0)
let waterBucketDropletId = 0
const heightCalcDistance = ref(10)
const heightCalcUnit = ref('m')
const heightCalcAngleLocked = ref(null)
const heightCalcEyeHeight = ref(1.6)

const widthCalcDistance = ref(10)
const widthCalcUnit = ref('m')
const widthCalcLeftHeading = ref(null)
const widthCalcRightHeading = ref(null)

const SAFE_DIAL_GUIDE_DEGREES = 10
const SAFE_DIAL_LOCK_TOLERANCE = 4    // ° — must be within this of the target to lock
const SAFE_DIAL_REVERSE_RESET = 12    // ° — reversing this far resets the current step
const SAFE_DIAL_SETTLE_MS = 280       // ms — must stay near target this long to lock
const WATER_BUCKET_GOAL_MS = 15000
// ── Production-tuned thresholds ──────────────────────────────────────
// Real phone IMUs report 2-5° of noise from hand tremor alone. Previous
// SAFE_TILT of 8° triggered false spills constantly. These values are
// calibrated for a person actually holding a phone in one hand:
const WATER_BUCKET_SAFE_TILT = 12     // was 8 — accounts for natural hand tremor
const WATER_BUCKET_WARN_TILT = 20     // was 14 — sloshing warning zone
const WATER_BUCKET_SPILL_TILT = 32    // was 22 — real "bucket tipped" angle
const WATER_BUCKET_SAFE_ROTATION = 35 // was 22 °/s — steady hand still reads ~15-25 °/s
const WATER_BUCKET_DRIP_LIMIT = 6

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
// ── Visual dial angle ─────────────────────────────────────────────────
// Uses the continuously accumulated angle instead of raw heading subtraction.
// This prevents the CSS rotate() from jumping 358° when heading crosses 0°/360°.
const safeDialRelativeAngle = computed(() => {
  if (safeDialAbsoluteAngle.value == null) {
    return null
  }
  return safeDialAccumulatedAngle.value
})
const safeDialCurrentStep = computed(
  () => safeDialSequence.value[safeDialStepIndex.value] ?? null
)
const safeDialSequenceComplete = computed(
  () => safeDialEnabled.value && safeDialStepIndex.value >= safeDialSequence.value.length
)
const safeDialTotalDegrees = computed(() =>
  safeDialSequence.value.reduce((total, step) => total + getSafeDialStepDegrees(step), 0)
)
const safeDialSignedStepProgress = computed(() => {
  if (!safeDialCurrentStep.value) {
    return 0
  }

  const rawProgress = safeDialAccumulatedAngle.value - safeDialStepStartTurn.value
  return safeDialCurrentStep.value.direction === 'cw' ? rawProgress : -rawProgress
})
const safeDialStepProgress = computed(() =>
  Math.max(0, safeDialSignedStepProgress.value)
)
const safeDialStepRemaining = computed(() => {
  if (!safeDialCurrentStep.value) {
    return 0
  }

  return Math.max(
    0,
    getSafeDialStepDegrees(safeDialCurrentStep.value) - safeDialStepProgress.value
  )
})
const safeDialSequenceProgressPercent = computed(() => {
  if (!safeDialTotalDegrees.value) {
    return 0
  }

  const completedDegrees = safeDialSequence.value
    .slice(0, safeDialStepIndex.value)
    .reduce((total, step) => total + getSafeDialStepDegrees(step), 0)

  const inFlightDegrees = safeDialCurrentStep.value
    ? Math.min(getSafeDialStepDegrees(safeDialCurrentStep.value), safeDialStepProgress.value)
    : 0

  return Math.min(
    100,
    Math.round(((completedDegrees + inFlightDegrees) / safeDialTotalDegrees.value) * 100)
  )
})
const safeDialWrongDirection = computed(() => safeDialSignedStepProgress.value < -5)
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
    return 'Haptic lock cues'
  }

  if (audioFeedbackMode.value === 'audio') {
    return 'Audio lock cues'
  }

  return 'Visual only'
})
const safeDialCurrentInstruction = computed(() => {
  if (safeDialSequenceComplete.value) {
    return 'Sequence complete'
  }

  if (!safeDialCurrentStep.value) {
    return 'No sequence loaded'
  }

  return `Turn ${formatSafeDialDirection(safeDialCurrentStep.value.direction)} ${getSafeDialStepDegrees(
    safeDialCurrentStep.value
  )}°`
})
const safeDialGuidanceCopy = computed(() => {
  if (safeDialSequenceComplete.value) {
    return 'Safe opened. Restart the sequence to run it again.'
  }

  if (!safeDialCurrentStep.value) {
    return 'Add at least one step to arm the dial trainer.'
  }

  if (!safeDialEnabled.value) {
    return 'Set the combination, then arm the dial. Rotate the phone smoothly and stop at each target — just like a real safe.'
  }

  if (safeDialWrongDirection.value) {
    return 'Wrong direction — keep going and the step will reset. Turn back the correct way.'
  }

  if (safeDialStepRemaining.value <= SAFE_DIAL_LOCK_TOLERANCE) {
    return 'You\'re at the target — hold steady to lock.'
  }

  return `${safeDialStepRemaining.value.toFixed(0)}° to go. Approach slowly — overshoot resets the step.`
})
const waterBucketPitchOffset = computed(() => {
  const beta = currentSample.value.orientation.beta

  if (typeof beta !== 'number') {
    return null
  }

  return beta - waterBucketBaseline.value.beta
})
const waterBucketRollOffset = computed(() => {
  const gamma = currentSample.value.orientation.gamma

  if (typeof gamma !== 'number') {
    return null
  }

  return gamma - waterBucketBaseline.value.gamma
})
const waterBucketTilt = computed(() => {
  if (waterBucketPitchOffset.value == null || waterBucketRollOffset.value == null) {
    return null
  }

  return Math.hypot(waterBucketPitchOffset.value, waterBucketRollOffset.value)
})
const waterBucketRotationMagnitude = computed(() => {
  const beta = currentSample.value.rotationRate.beta
  const gamma = currentSample.value.rotationRate.gamma

  if (typeof beta !== 'number' && typeof gamma !== 'number') {
    return null
  }

  return Math.hypot(beta ?? 0, gamma ?? 0)
})
const waterBucketElapsedMs = computed(() => {
  if (waterBucketEnabled.value && waterBucketLastTimestamp.value > waterBucketStartTimestamp.value) {
    return waterBucketLastTimestamp.value - waterBucketStartTimestamp.value
  }

  return waterBucketLastDurationMs.value
})
const waterBucketGoalProgress = computed(() =>
  Math.min(100, Math.round((waterBucketElapsedMs.value / WATER_BUCKET_GOAL_MS) * 100))
)
const waterBucketWaterDisplay = computed(() =>
  Math.max(0, Math.min(100, Math.round(waterBucketWaterLevel.value)))
)
const waterBucketRiskLabel = computed(() => {
  if (!waterBucketEnabled.value) {
    return 'Waiting'
  }

  if (waterBucketWaterLevel.value <= 0) {
    return 'Spilled'
  }

  if (waterBucketTilt.value == null) {
    return 'No tilt data'
  }

  if (
    waterBucketTilt.value >= WATER_BUCKET_SPILL_TILT ||
    (waterBucketRotationMagnitude.value ?? 0) >= 100
  ) {
    return 'Major spill'
  }

  if (
    waterBucketTilt.value >= WATER_BUCKET_WARN_TILT ||
    (waterBucketRotationMagnitude.value ?? 0) >= 60
  ) {
    return 'Sloshing'
  }

  return 'Steady'
})
const waterBucketRiskColor = computed(() => {
  const label = waterBucketRiskLabel.value
  if (label === 'Major spill' || label === 'Spilled') return '#ff5555'
  if (label === 'Sloshing') return '#ffaa44'
  if (label === 'Steady') return '#7be6bf'
  return 'rgba(255,255,255,0.4)'
})
const waterBucketSurfaceAngle = computed(() =>
  clamp(-(waterBucketRollOffset.value ?? 0) * 1.2, -28, 28)
)
const waterBucketSurfaceShift = computed(() =>
  clamp((waterBucketRollOffset.value ?? 0) * 0.6, -20, 20)
)
const waterBucketPitchVisual = computed(() =>
  clamp((waterBucketPitchOffset.value ?? 0) * 0.5, -12, 12)
)
const waterBucketGuidanceCopy = computed(() => {
  if (waterBucketEnabled.value) {
    if (waterBucketWaterLevel.value <= 0) {
      return 'The bucket emptied. Reset and keep the phone flatter and calmer on the next run.'
    }

    if (waterBucketTilt.value == null) {
      return 'Orientation data has not arrived yet. Hold still for a moment.'
    }

    if (waterBucketTilt.value <= WATER_BUCKET_SAFE_TILT) {
      return 'Nice and level. Keep the phone flat like a tray and avoid sudden wrist corrections.'
    }

    if (waterBucketTilt.value <= WATER_BUCKET_WARN_TILT) {
      return 'A little wobble is creeping in. Ease back toward flat before the water starts to spill.'
    }

    return 'Too much tilt. Flatten the phone immediately and slow the motion to save the bucket.'
  }

  if (waterBucketLastDurationMs.value >= WATER_BUCKET_GOAL_MS && waterBucketWaterLevel.value > 0) {
    return 'Bucket saved. You held it flat for the full challenge window.'
  }

  return 'Calibrate while the phone is flat, then hold it steady for 15 seconds without spilling the water.'
})

const heightCalcLivePitch = computed(() => {
  const beta = currentSample.value.orientation.beta
  if (typeof beta !== 'number') return null
  return beta
})
const heightCalcAngle = computed(() =>
  heightCalcAngleLocked.value != null ? heightCalcAngleLocked.value : heightCalcLivePitch.value
)
const heightCalcResult = computed(() => {
  if (heightCalcAngle.value == null) return null
  const rad = (heightCalcAngle.value * Math.PI) / 180
  const objectHeight = Math.tan(rad) * heightCalcDistance.value + heightCalcEyeHeight.value
  return objectHeight
})
const heightCalcUnitLabel = computed(() => {
  const labels = { m: 'metres', ft: 'feet', yd: 'yards' }
  return labels[heightCalcUnit.value] || heightCalcUnit.value
})

const widthCalcLiveHeading = computed(() => {
  const heading = currentSample.value.orientation.compassHeading
  if (typeof heading !== 'number') return null
  return heading
})
const widthCalcAngleSpan = computed(() => {
  if (widthCalcLeftHeading.value == null || widthCalcRightHeading.value == null) return null
  let delta = widthCalcRightHeading.value - widthCalcLeftHeading.value
  if (delta < 0) delta += 360
  if (delta > 180) delta = 360 - delta
  return delta
})
const widthCalcResult = computed(() => {
  if (widthCalcAngleSpan.value == null) return null
  const rad = (widthCalcAngleSpan.value * Math.PI) / 180
  return 2 * widthCalcDistance.value * Math.tan(rad / 2)
})
const widthCalcUnitLabel = computed(() => {
  const labels = { m: 'metres', ft: 'feet', yd: 'yards' }
  return labels[widthCalcUnit.value] || widthCalcUnit.value
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

function buildTickPattern(duration = 12) {
  return duration
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function getSafeDialStepDegrees(step) {
  return Math.max(5, Math.min(360, Math.round(Number(step?.degrees) || 0)))
}

function formatSafeDialDirection(direction) {
  return direction === 'cw' ? 'right / clockwise' : 'left / counter-clockwise'
}

function getSafeDialDirectionSymbol(direction) {
  return direction === 'cw' ? '↻' : '↺'
}

function createSafeDialStep(direction = 'cw', degrees = 90) {
  return {
    id: createSpellId(),
    direction,
    degrees
  }
}

function resetSafeDialBaseline(angle = safeDialAbsoluteAngle.value) {
  safeDialZeroAngle.value = angle ?? 0
  safeDialLastAngle.value = angle
  safeDialAccumulatedAngle.value = 0
  safeDialLastDelta.value = 0
  safeDialStepIndex.value = 0
  safeDialStepStartTurn.value = 0
  safeDialGuideTickIndex.value = 0
  safeDialLastCompletedStep.value = -1
  safeDialSettleStart = 0
}

function resetWaterBucketRun() {
  waterBucketStartTimestamp.value = 0
  waterBucketLastTimestamp.value = 0
  waterBucketWaterLevel.value = 100
  waterBucketLastDurationMs.value = 0
  waterBucketSpillEvents.value = 0
  waterBucketWasSpilling.value = false
  waterBucketMomentum.value = 0
  waterBucketDroplets.value = []
}

function calibrateWaterBucket() {
  waterBucketBaseline.value = {
    beta: currentSample.value.orientation.beta ?? 0,
    gamma: currentSample.value.orientation.gamma ?? 0
  }
  triggerHaptic(20)
  statusMessage.value = waterBucketEnabled.value
    ? 'Bucket baseline reset. Hold it flat and steady.'
    : 'Bucket flat point captured.'
}

function stopWaterBucket(customMessage = 'Bucket game stopped.') {
  if (!waterBucketEnabled.value) {
    return
  }

  waterBucketEnabled.value = false
  waterBucketLastDurationMs.value = Math.max(
    waterBucketLastDurationMs.value,
    Math.max(0, waterBucketLastTimestamp.value - waterBucketStartTimestamp.value)
  )
  waterBucketBestTimeMs.value = Math.max(
    waterBucketBestTimeMs.value,
    waterBucketLastDurationMs.value
  )
  waterBucketWasSpilling.value = false
  statusMessage.value = customMessage
}

async function startWaterBucketGame() {
  await primePhaseFeedback()

  const ready = await ensureSensorsReady(
    `Water bucket challenge started. Keep the phone flat for ${(
      WATER_BUCKET_GOAL_MS / 1000
    ).toFixed(0)} seconds. ${feedbackHint()}`
  )
  if (!ready) {
    return
  }

  calibrateWaterBucket()
  resetWaterBucketRun()
  waterBucketEnabled.value = true
  const timestamp = currentSample.value.timestamp || performance.now()
  waterBucketStartTimestamp.value = timestamp
  waterBucketLastTimestamp.value = timestamp
  statusMessage.value = `Water bucket challenge live. Hold flat for ${(
    WATER_BUCKET_GOAL_MS / 1000
  ).toFixed(0)} seconds.`
}

function spawnDroplets(count, side) {
  const now = Date.now()
  for (let i = 0; i < count; i++) {
    waterBucketDroplets.value = [
      ...waterBucketDroplets.value.filter((d) => now - d.born < 1200),
      {
        id: ++waterBucketDropletId,
        born: now,
        x: side === 'left' ? 8 + Math.random() * 15 : 77 + Math.random() * 15,
        size: 3 + Math.random() * 5,
        dx: side === 'left' ? -(1 + Math.random() * 3) : 1 + Math.random() * 3,
        dy: -(2 + Math.random() * 4)
      }
    ].slice(-WATER_BUCKET_DRIP_LIMIT)
  }
}

function processWaterBucketSample(sample) {
  if (!waterBucketEnabled.value) {
    return
  }

  const timestamp = sample.timestamp || performance.now()

  if (!waterBucketStartTimestamp.value) {
    waterBucketStartTimestamp.value = timestamp
  }

  if (!waterBucketLastTimestamp.value) {
    waterBucketLastTimestamp.value = timestamp
    return
  }

  const deltaMs = clamp(timestamp - waterBucketLastTimestamp.value, 0, 160)
  const deltaSec = deltaMs / 1000
  waterBucketLastTimestamp.value = timestamp
  waterBucketLastDurationMs.value = Math.max(0, timestamp - waterBucketStartTimestamp.value)

  // ── Tilt magnitude ──
  // Combined tilt = sqrt(pitchOffset² + rollOffset²)
  // This gives the total angular displacement from the calibrated flat position.
  const beta = sample.orientation.beta
  const gamma = sample.orientation.gamma
  const pitchOff = typeof beta === 'number' ? beta - waterBucketBaseline.value.beta : 0
  const rollOff = typeof gamma === 'number' ? gamma - waterBucketBaseline.value.gamma : 0
  const hasTilt = typeof beta === 'number' && typeof gamma === 'number'
  const tilt = hasTilt ? Math.hypot(pitchOff, rollOff) : null

  // ── Angular velocity magnitude ──
  // hypot of pitch-rate and roll-rate (°/s) from the gyroscope.
  // Yaw (alpha) is excluded — spinning the phone on a flat table shouldn't spill.
  const rotBeta = sample.rotationRate.beta ?? 0
  const rotGamma = sample.rotationRate.gamma ?? 0
  const rotation = Math.hypot(rotBeta, rotGamma)

  // ── Momentum model ──
  // Momentum represents the "sloshing energy" built up from sustained or sudden tilt.
  // It rises proportionally to tilt severity and decays exponentially when the phone
  // is held steady, modelling how real water keeps sloshing after you correct.
  // Tuned for real-world hand tremor: gentle gains, longer decay half-life (~0.9s).
  const prevMomentum = waterBucketMomentum.value
  const tiltExcess = tilt != null ? Math.max(0, tilt - WATER_BUCKET_SAFE_TILT) : 0
  // Build momentum: tiltExcess drives it up; higher tilt = faster buildup
  const momentumGain = tiltExcess * 0.5 * deltaSec
  // Rotation jerk adds momentum (sudden wrist flicks)
  const rotationExcess = Math.max(0, rotation - WATER_BUCKET_SAFE_ROTATION)
  const rotMomentumGain = rotationExcess * 0.08 * deltaSec
  // Exponential decay toward 0 (half-life ~0.9s — more forgiving than before)
  const decay = Math.exp(-0.75 * deltaSec)
  const momentum = (prevMomentum + momentumGain + rotMomentumGain) * decay
  waterBucketMomentum.value = momentum

  // ── Spill rate (% of bucket per second) ──
  // Combines three effects:
  //   1. Static tilt: gentle quadratic ramp once past the safe zone.
  //      Using (excess/range)² keeps low tilts very forgiving while steep tilts
  //      drain fast. At SPILL_TILT the static component alone is ~10 %/s.
  //   2. Momentum: linear contribution — sustained wobble or jerky corrections
  //      keep draining even after you straighten the phone, like real sloshing.
  //   3. Extreme tilt penalty: a flat +15 %/s once past SPILL_TILT to make
  //      obviously bad tilts punishing (the bucket can't hold water sideways).
  let spillRate = 0

  if (tilt != null && tilt > WATER_BUCKET_SAFE_TILT) {
    const range = WATER_BUCKET_SPILL_TILT - WATER_BUCKET_SAFE_TILT // 20°
    const normExcess = tiltExcess / range // 0..1 at spill threshold
    // Quadratic: gentle at low tilt, steep near spill threshold
    spillRate += normExcess * normExcess * 10
  }

  if (tilt != null && tilt > WATER_BUCKET_SPILL_TILT) {
    spillRate += 15
  }

  // Momentum contribution — keeps water sloshing out after corrections
  spillRate += momentum * 2.5

  // Rotation adds a mild direct term on top of its momentum contribution
  if (rotation > WATER_BUCKET_SAFE_ROTATION) {
    spillRate += rotationExcess * 0.08
  }

  const spillingNow = spillRate > 1.5

  if (spillingNow && !waterBucketWasSpilling.value) {
    waterBucketSpillEvents.value += 1
    triggerHaptic(25)
  }

  // Spawn visual droplets when spilling
  if (spillingNow && waterBucketWaterLevel.value > 0) {
    const side = rollOff > 0 ? 'right' : 'left'
    const intensity = Math.min(3, Math.ceil(spillRate / 10))
    if (Math.random() < 0.4 + spillRate * 0.02) {
      spawnDroplets(intensity, side)
    }
  }

  waterBucketWasSpilling.value = spillingNow
  waterBucketWaterLevel.value = Math.max(
    0,
    waterBucketWaterLevel.value - spillRate * deltaSec
  )

  if (waterBucketWaterLevel.value <= 0) {
    spawnDroplets(4, 'left')
    spawnDroplets(4, 'right')
    stopWaterBucket('Bucket spilled. Reset and try to stay flatter.')
    return
  }

  if (waterBucketLastDurationMs.value >= WATER_BUCKET_GOAL_MS) {
    triggerSuccessFeedback()
    stopWaterBucket('Bucket saved. Full balance challenge complete.')
  }
}

function loadSafeDialPreset(presetName) {
  const presets = {
    quick: [
      createSafeDialStep('cw', 90),
      createSafeDialStep('ccw', 50)
    ],
    vault: [
      createSafeDialStep('cw', 120),
      createSafeDialStep('ccw', 80),
      createSafeDialStep('cw', 40)
    ],
    reverse: [
      createSafeDialStep('ccw', 60),
      createSafeDialStep('cw', 110),
      createSafeDialStep('ccw', 30)
    ]
  }

  safeDialSequence.value = presets[presetName].map((step) => ({ ...step }))
  safeDialEnabled.value = false
  resetSafeDialBaseline()
  statusMessage.value = 'Safe dial preset loaded.'
}

function addSafeDialStep(direction = 'cw') {
  safeDialSequence.value = [...safeDialSequence.value, createSafeDialStep(direction, 45)]
}

function removeSafeDialStep(stepId) {
  if (safeDialSequence.value.length === 1) {
    return
  }

  safeDialSequence.value = safeDialSequence.value.filter((step) => step.id !== stepId)
  if (safeDialStepIndex.value >= safeDialSequence.value.length) {
    safeDialStepIndex.value = safeDialSequence.value.length - 1
  }
}

function triggerSafeDialTargetFeedback(isFinal = false) {
  if (isFinal) {
    if (canVibrate()) {
      audioFeedbackMode.value = 'vibrate'
      navigator.vibrate([180, 50, 180, 60, 240])
      return
    }

    if (audioFeedbackMode.value === 'audio') {
      playBeepPattern([120, 40, 150, 40, 220])
    }
    return
  }

  if (canVibrate()) {
    audioFeedbackMode.value = 'vibrate'
    navigator.vibrate([120, 45, 120])
    return
  }

  if (audioFeedbackMode.value === 'audio') {
    playBeepPattern([90, 35, 120])
  }
}

async function startSafeDialSequence() {
  await primePhaseFeedback()

  const ready = await ensureSensorsReady(
    `Safe dial armed. ${safeDialCurrentInstruction.value}. ${feedbackHint()}`
  )
  if (!ready) {
    return
  }

  safeDialSequence.value = safeDialSequence.value.map((step) => ({
    ...step,
    degrees: getSafeDialStepDegrees(step)
  }))
  safeDialEnabled.value = true
  resetSafeDialBaseline()
  triggerSafeDialTargetFeedback(false)
}

function stopSafeDial() {
  if (!safeDialEnabled.value) {
    return
  }

  safeDialEnabled.value = false
  safeDialLastAngle.value = safeDialAbsoluteAngle.value
  statusMessage.value = 'Safe dial trainer off.'
}

function calibrateSafeDial() {
  resetSafeDialBaseline()
  triggerHaptic(20)
  statusMessage.value = safeDialEnabled.value
    ? `Safe dial zero reset. ${safeDialCurrentInstruction.value}.`
    : 'Safe dial zero reset.'
}

function lockHeightAngle() {
  heightCalcAngleLocked.value = heightCalcLivePitch.value
  triggerHaptic(20)
}

function unlockHeightAngle() {
  heightCalcAngleLocked.value = null
}

function lockWidthLeft() {
  widthCalcLeftHeading.value = widthCalcLiveHeading.value
  triggerHaptic(20)
}

function lockWidthRight() {
  widthCalcRightHeading.value = widthCalcLiveHeading.value
  triggerHaptic(20)
}

function resetWidthCalc() {
  widthCalcLeftHeading.value = null
  widthCalcRightHeading.value = null
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
  processWaterBucketSample(sample)

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

// ── Safe dial watcher ──────────────────────────────────────────────────
// ALWAYS tracks deltas so the visual dial never jumps at the 0°/360° boundary.
// Step processing only runs when the dial is armed.
//
// Real safe dial mechanics:
//   • The user must STOP within a tolerance window of the target — just
//     passing through it doesn't count. This models the physical detent.
//   • Turning in the wrong direction beyond a threshold resets the step,
//     just like a real safe where reversing disengages the wheel pack.
//   • A brief settling period (the user must stay near the target for a
//     moment) prevents accidental triggers from fast sweeps.
watch(safeDialAbsoluteAngle, (angle) => {
  if (angle == null) {
    return
  }

  // Always track deltas for smooth visual, even when not armed
  if (safeDialLastAngle.value == null) {
    safeDialLastAngle.value = angle
    return
  }

  const delta = wrapAngleDelta(angle, safeDialLastAngle.value)
  safeDialLastAngle.value = angle

  // Reject sensor noise — small jitter shouldn't move the dial
  if (Math.abs(delta) < 1.5) {
    return
  }

  safeDialLastDelta.value = delta
  safeDialAccumulatedAngle.value += delta

  // Stop here if dial is not armed or a recording is in progress
  if (!safeDialEnabled.value || recordingMode.value) {
    return
  }

  if (!safeDialCurrentStep.value) {
    return
  }

  // ── Wrong-direction reset ──
  // On a real safe, turning the wrong way disengages the wheel pack.
  // If the user reverses beyond the threshold, reset this step to the
  // current position so they have to start the rotation over.
  if (safeDialSignedStepProgress.value < -SAFE_DIAL_REVERSE_RESET) {
    safeDialStepStartTurn.value = safeDialAccumulatedAngle.value
    safeDialGuideTickIndex.value = 0
    safeDialSettleStart = 0
    triggerHaptic(15)
    statusMessage.value = `Wrong direction — step reset. ${safeDialCurrentInstruction.value}.`
    return
  }

  const stepDegrees = getSafeDialStepDegrees(safeDialCurrentStep.value)
  const progress = safeDialStepProgress.value

  // ── Haptic guide ticks ──
  const nextGuideTick = Math.floor(Math.min(progress, stepDegrees) / SAFE_DIAL_GUIDE_DEGREES)
  if (nextGuideTick > safeDialGuideTickIndex.value && progress < stepDegrees) {
    safeDialGuideTickIndex.value = nextGuideTick
    triggerHaptic(buildTickPattern(10))
  }

  // ── Lock detection ──
  // The user must be within LOCK_TOLERANCE of the target AND hold steady
  // for SETTLE_MS, modelling the physical click of a real safe.
  const overshoot = progress - stepDegrees
  const withinLockZone = overshoot >= -SAFE_DIAL_LOCK_TOLERANCE && overshoot <= SAFE_DIAL_LOCK_TOLERANCE

  if (!withinLockZone) {
    safeDialSettleStart = 0

    // If the user overshoots far past the target, that's also a miss on a real safe.
    // Reset the step so they have to approach again.
    if (overshoot > SAFE_DIAL_LOCK_TOLERANCE + 8) {
      safeDialStepStartTurn.value = safeDialAccumulatedAngle.value
      safeDialGuideTickIndex.value = 0
      triggerHaptic(15)
      statusMessage.value = `Overshot the target. Approach ${stepDegrees}° more slowly.`
    }

    return
  }

  // User is in the lock zone — start or continue settling
  const now = performance.now()
  if (!safeDialSettleStart) {
    safeDialSettleStart = now
    return
  }

  if (now - safeDialSettleStart < SAFE_DIAL_SETTLE_MS) {
    return
  }

  // ── Step locked ──
  safeDialSettleStart = 0
  const completedIndex = safeDialStepIndex.value
  const isFinalStep = completedIndex >= safeDialSequence.value.length - 1

  safeDialLastCompletedStep.value = completedIndex
  triggerSafeDialTargetFeedback(isFinalStep)

  if (isFinalStep) {
    safeDialStepIndex.value = safeDialSequence.value.length
    statusMessage.value = 'Safe dial sequence complete.'
    return
  }

  safeDialStepIndex.value += 1
  safeDialStepStartTurn.value = safeDialAccumulatedAngle.value
  safeDialGuideTickIndex.value = 0
  statusMessage.value = `Step ${completedIndex + 1} locked. Next: ${safeDialCurrentInstruction.value}.`
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

          <WandPreview :samples="selectedSpell.samples" />

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

        <section class="panel stack safe-dial-section">
          <div class="section-head">
            <div>
              <p class="eyebrow">Lock trainer</p>
              <h2>Combination safe</h2>
            </div>
            <span
              class="chip"
              :class="{
                'chip--active': safeDialEnabled && !safeDialSequenceComplete,
                'chip--done': safeDialSequenceComplete
              }"
            >
              {{
                safeDialSequenceComplete
                  ? 'Unlocked'
                  : safeDialEnabled
                    ? 'Live'
                    : 'Ready'
              }}
            </span>
          </div>

          <!-- Realistic safe dial -->
          <div class="vault-dial">
            <div class="vault-dial__body">
              <!-- Outer bezel ring -->
              <div class="vault-dial__bezel">
                <!-- Fixed triangular marker at top -->
                <span class="vault-dial__index-mark"></span>
              </div>

              <!-- Rotating dial face -->
              <div
                class="vault-dial__face"
                :style="{
                  transform: `rotate(${safeDialRelativeAngle ?? 0}deg)`
                }"
              >
                <!-- Number markings around the edge (every 10 degrees, 0-35) -->
                <span
                  v-for="n in 36"
                  :key="`num-${n}`"
                  class="vault-dial__number"
                  :class="{ 'vault-dial__number--major': (n - 1) % 3 === 0 }"
                  :style="{ transform: `rotate(${(n - 1) * 10}deg)` }"
                >
                  <span :style="{ transform: `rotate(${-(n - 1) * 10 - (safeDialRelativeAngle ?? 0)}deg)` }">
                    {{ (n - 1) * 10 }}
                  </span>
                </span>

                <!-- Tick marks (every 2 degrees) -->
                <span
                  v-for="t in 180"
                  :key="`tick-${t}`"
                  class="vault-dial__tick"
                  :class="{
                    'vault-dial__tick--major': (t - 1) * 2 % 10 === 0,
                    'vault-dial__tick--mid': (t - 1) * 2 % 10 === 5
                  }"
                  :style="{ transform: `rotate(${(t - 1) * 2}deg)` }"
                ></span>

                <!-- Centre hub -->
                <div class="vault-dial__hub">
                  <div class="vault-dial__hub-inner"></div>
                </div>
              </div>

              <!-- Status overlay in centre -->
              <div class="vault-dial__readout">
                <strong>
                  {{
                    safeDialRelativeAngle == null
                      ? '--'
                      : `${((Math.round(safeDialRelativeAngle) % 360) + 360) % 360}°`
                  }}
                </strong>
                <small :class="{ 'vault-dial__direction--wrong': safeDialWrongDirection }">
                  {{ safeDialEnabled ? safeDialDirectionLabel : 'Idle' }}
                </small>
              </div>
            </div>

            <!-- Current instruction below dial -->
            <div class="vault-dial__instruction" v-if="safeDialEnabled && !safeDialSequenceComplete">
              <span class="vault-dial__arrow">
                {{ safeDialCurrentStep?.direction === 'cw' ? '&#x21BB;' : '&#x21BA;' }}
              </span>
              <div>
                <strong>{{ safeDialCurrentInstruction }}</strong>
                <span class="vault-dial__remaining">
                  {{ safeDialStepRemaining.toFixed(0) }}° to go
                </span>
              </div>
            </div>
            <div class="vault-dial__instruction vault-dial__instruction--done" v-else-if="safeDialSequenceComplete">
              <span class="vault-dial__arrow">&#x2714;</span>
              <div>
                <strong>Safe opened</strong>
                <span class="vault-dial__remaining">All steps completed</span>
              </div>
            </div>
          </div>

          <!-- Step progress track (always visible) -->
          <div class="vault-steps">
            <div
              v-for="(step, index) in safeDialSequence"
              :key="`${step.id}-pill`"
              class="vault-step"
              :class="{
                'vault-step--active':
                  safeDialEnabled && index === safeDialStepIndex && !safeDialSequenceComplete,
                'vault-step--done': index <= safeDialLastCompletedStep
              }"
            >
              <span class="vault-step__icon">{{ getSafeDialDirectionSymbol(step.direction) }}</span>
              <span class="vault-step__label">{{ getSafeDialStepDegrees(step) }}°</span>
              <span class="vault-step__dir">{{ step.direction === 'cw' ? 'R' : 'L' }}</span>
            </div>
            <div class="vault-steps__progress">
              <div
                class="vault-steps__bar"
                :style="{ width: `${safeDialSequenceProgressPercent}%` }"
              ></div>
            </div>
          </div>

          <!-- Action buttons - primary actions front and centre -->
          <div class="vault-actions">
            <button class="button button--primary vault-actions__main" @click="startSafeDialSequence">
              {{
                safeDialEnabled
                  ? (safeDialSequenceComplete ? 'Try Again' : 'Restart')
                  : 'Arm Safe'
              }}
            </button>
            <button
              class="button button--ghost"
              :disabled="!safeDialEnabled"
              @click="stopSafeDial"
            >
              Stop
            </button>
            <button
              class="button button--ghost"
              :disabled="!isListening && safeDialAbsoluteAngle == null"
              @click="calibrateSafeDial"
            >
              Zero
            </button>
          </div>

          <!-- Guidance text -->
          <p class="comparison-copy vault-guidance">
            {{ safeDialGuidanceCopy }}
          </p>

          <!-- Collapsible combo editor -->
          <details class="vault-editor" :open="!safeDialEnabled ? true : undefined">
            <summary class="vault-editor__toggle">
              Edit combination
              <span class="chip">{{ safeDialSequence.length }} steps</span>
            </summary>

            <div class="vault-editor__body">
              <!-- Presets -->
              <div class="vault-presets">
                <p class="label">Presets</p>
                <div class="vault-presets__row">
                  <button
                    class="button button--ghost vault-preset-btn"
                    :disabled="safeDialEnabled"
                    @click="loadSafeDialPreset('quick')"
                  >
                    90R &middot; 50L
                  </button>
                  <button
                    class="button button--ghost vault-preset-btn"
                    :disabled="safeDialEnabled"
                    @click="loadSafeDialPreset('vault')"
                  >
                    120R &middot; 80L &middot; 40R
                  </button>
                  <button
                    class="button button--ghost vault-preset-btn"
                    :disabled="safeDialEnabled"
                    @click="loadSafeDialPreset('reverse')"
                  >
                    60L &middot; 110R &middot; 30L
                  </button>
                </div>
              </div>

              <!-- Step list -->
              <div class="vault-combo">
                <article
                  v-for="(step, index) in safeDialSequence"
                  :key="step.id"
                  class="vault-combo__step"
                >
                  <span class="vault-combo__num">{{ index + 1 }}</span>
                  <div class="vault-combo__dir">
                    <button
                      class="vault-combo__dir-btn"
                      :class="{ 'vault-combo__dir-btn--on': step.direction === 'cw' }"
                      :disabled="safeDialEnabled"
                      @click="step.direction = 'cw'"
                    >
                      R
                    </button>
                    <button
                      class="vault-combo__dir-btn"
                      :class="{ 'vault-combo__dir-btn--on': step.direction === 'ccw' }"
                      :disabled="safeDialEnabled"
                      @click="step.direction = 'ccw'"
                    >
                      L
                    </button>
                  </div>
                  <input
                    class="vault-combo__deg"
                    v-model.number="step.degrees"
                    type="number"
                    min="5"
                    max="360"
                    step="5"
                    :disabled="safeDialEnabled"
                  />
                  <span class="vault-combo__unit">°</span>
                  <button
                    class="vault-combo__remove"
                    :disabled="safeDialSequence.length === 1 || safeDialEnabled"
                    @click="removeSafeDialStep(step.id)"
                  >
                    &times;
                  </button>
                </article>
              </div>

              <div class="button-row">
                <button
                  class="button button--ghost"
                  :disabled="safeDialEnabled"
                  @click="addSafeDialStep('cw')"
                >
                  + Right step
                </button>
                <button
                  class="button button--ghost"
                  :disabled="safeDialEnabled"
                  @click="addSafeDialStep('ccw')"
                >
                  + Left step
                </button>
              </div>
            </div>
          </details>

          <p class="comparison-copy" style="font-size: 0.82rem;">
            Rotate your phone like a real combination safe. Approach each target slowly and hold
            steady to lock — overshoot or wrong direction resets the step. {{ safeDialFeedbackLabel }}
            feedback ticks every {{ SAFE_DIAL_GUIDE_DEGREES }}° and a strong pulse confirms each lock.
          </p>
        </section>

        <section class="panel stack bucket-section">
          <div class="section-head">
            <div>
              <p class="eyebrow">Balance challenge</p>
              <h2>Water bucket</h2>
            </div>
            <span
              class="chip"
              :class="{
                'chip--active': waterBucketEnabled && waterBucketWaterLevel > 0,
                'chip--done': !waterBucketEnabled && waterBucketLastDurationMs >= WATER_BUCKET_GOAL_MS && waterBucketWaterLevel > 0
              }"
              :style="waterBucketEnabled ? { borderColor: waterBucketRiskColor, color: waterBucketRiskColor } : {}"
            >
              {{ waterBucketRiskLabel }}
            </span>
          </div>

          <!-- Bucket visualization -->
          <div class="bucket-scene">
            <div
              class="bucket-body"
              :style="{
                transform: `perspective(400px) rotateX(${waterBucketPitchVisual}deg) rotateZ(${clamp(-(waterBucketRollOffset ?? 0) * 0.3, -8, 8)}deg)`
              }"
            >
              <!-- Handle arc -->
              <svg class="bucket-handle-svg" viewBox="0 0 120 50" preserveAspectRatio="xMidYMax meet">
                <path
                  d="M 15 48 Q 15 8, 60 8 Q 105 8, 105 48"
                  fill="none"
                  stroke="rgba(180, 170, 140, 0.7)"
                  stroke-width="4"
                  stroke-linecap="round"
                />
              </svg>

              <!-- Bucket shell (tapered) -->
              <div class="bucket-shell">
                <!-- Metal bands -->
                <span class="bucket-band bucket-band--top"></span>
                <span class="bucket-band bucket-band--bottom"></span>

                <!-- Water fill -->
                <div
                  class="bucket-water"
                  :class="{
                    'bucket-water--sloshing': waterBucketEnabled && waterBucketTilt != null && waterBucketTilt > WATER_BUCKET_SAFE_TILT,
                    'bucket-water--danger': waterBucketEnabled && waterBucketTilt != null && waterBucketTilt > WATER_BUCKET_WARN_TILT
                  }"
                  :style="{
                    height: `${Math.max(3, waterBucketWaterDisplay * 0.84)}%`
                  }"
                >
                  <!-- Surface wave -->
                  <svg
                    class="bucket-wave"
                    viewBox="0 0 200 20"
                    preserveAspectRatio="none"
                    :style="{
                      transform: `translateX(${waterBucketSurfaceShift}px) rotate(${waterBucketSurfaceAngle}deg)`
                    }"
                  >
                    <path class="bucket-wave__back" d="M0 12 Q25 4,50 10 T100 10 T150 10 T200 10 V20 H0Z" />
                    <path class="bucket-wave__front" d="M0 14 Q30 6,60 12 T120 12 T180 12 T200 12 V20 H0Z" />
                  </svg>
                </div>

                <!-- Droplets -->
                <span
                  v-for="drop in waterBucketDroplets"
                  :key="drop.id"
                  class="bucket-droplet"
                  :style="{
                    left: `${drop.x}%`,
                    width: `${drop.size}px`,
                    height: `${drop.size}px`,
                    '--dx': `${drop.dx * 12}px`,
                    '--dy': `${drop.dy * 8}px`
                  }"
                ></span>
              </div>
            </div>

            <!-- Water level readout below bucket -->
            <div class="bucket-level">
              <strong
                :style="{ color: waterBucketRiskColor }"
              >{{ waterBucketWaterDisplay }}%</strong>
              <small>water remaining</small>
            </div>
          </div>

          <!-- Timer ring + stats -->
          <div class="bucket-dashboard">
            <div class="bucket-timer">
              <svg class="bucket-timer__ring" viewBox="0 0 80 80">
                <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="5" />
                <circle
                  cx="40" cy="40" r="34"
                  fill="none"
                  :stroke="waterBucketGoalProgress >= 100 ? 'var(--accent-mint)' : 'var(--accent-sky)'"
                  stroke-width="5"
                  stroke-linecap="round"
                  :stroke-dasharray="`${waterBucketGoalProgress * 2.136} 213.6`"
                  transform="rotate(-90 40 40)"
                  style="transition: stroke-dasharray 200ms ease"
                />
              </svg>
              <div class="bucket-timer__text">
                <strong>{{ (waterBucketElapsedMs / 1000).toFixed(1) }}</strong>
                <small>/ {{ (WATER_BUCKET_GOAL_MS / 1000).toFixed(0) }}s</small>
              </div>
            </div>

            <div class="bucket-metrics">
              <div class="bucket-metric">
                <span class="bucket-metric__value">
                  {{ waterBucketTilt == null ? '--' : waterBucketTilt.toFixed(1) }}°
                </span>
                <span class="bucket-metric__label">Tilt</span>
              </div>
              <div class="bucket-metric">
                <span class="bucket-metric__value">
                  {{ waterBucketRotationMagnitude == null ? '--' : waterBucketRotationMagnitude.toFixed(0) }}°/s
                </span>
                <span class="bucket-metric__label">Motion</span>
              </div>
              <div class="bucket-metric">
                <span class="bucket-metric__value">{{ waterBucketSpillEvents }}</span>
                <span class="bucket-metric__label">Spills</span>
              </div>
              <div class="bucket-metric">
                <span class="bucket-metric__value">{{ (waterBucketBestTimeMs / 1000).toFixed(1) }}s</span>
                <span class="bucket-metric__label">Best</span>
              </div>
            </div>
          </div>

          <!-- Guidance -->
          <p class="comparison-copy">
            {{ waterBucketGuidanceCopy }}
          </p>

          <!-- Actions -->
          <div class="bucket-actions">
            <button class="button button--primary bucket-actions__main" @click="startWaterBucketGame">
              {{ waterBucketEnabled ? 'Restart' : 'Start Challenge' }}
            </button>
            <button
              class="button button--ghost"
              :disabled="!waterBucketEnabled"
              @click="stopWaterBucket()"
            >
              Stop
            </button>
            <button
              class="button button--ghost"
              :disabled="!isListening && currentSample.orientation.beta == null"
              @click="calibrateWaterBucket"
            >
              Calibrate Flat
            </button>
          </div>

          <p class="comparison-copy" style="font-size: 0.82rem;">
            Hold the phone flat like a tray for {{ (WATER_BUCKET_GOAL_MS / 1000).toFixed(0) }} seconds.
            Tilting spills water. Jerky corrections create momentum that keeps sloshing even after
            you straighten out. {{ safeDialFeedbackLabel }} feedback on spill events.
          </p>
        </section>

        <section class="panel stack">
          <div class="section-head">
            <div>
              <p class="eyebrow">Navigation</p>
              <h2>Compass</h2>
            </div>
            <span class="chip">
              {{
                safeDialAbsoluteAngle == null
                  ? 'No heading'
                  : `${Math.round(safeDialAbsoluteAngle)}°`
              }}
            </span>
          </div>

          <CompassRose :heading="safeDialAbsoluteAngle" />

          <div class="compass-stats">
            <article class="safe-sequence-track__card">
              <strong>
                {{
                  safeDialAbsoluteAngle == null
                    ? 'n/a'
                    : `${Math.round(safeDialAbsoluteAngle)}°`
                }}
              </strong>
              <span>Heading</span>
              <small>compass bearing</small>
            </article>
            <article class="safe-sequence-track__card">
              <strong>
                {{
                  currentSample.orientation.beta == null
                    ? 'n/a'
                    : `${currentSample.orientation.beta.toFixed(1)}°`
                }}
              </strong>
              <span>Pitch</span>
              <small>forward / back</small>
            </article>
            <article class="safe-sequence-track__card">
              <strong>
                {{
                  currentSample.orientation.gamma == null
                    ? 'n/a'
                    : `${currentSample.orientation.gamma.toFixed(1)}°`
                }}
              </strong>
              <span>Roll</span>
              <small>left / right</small>
            </article>
          </div>

          <p class="comparison-copy">
            Point the phone in different directions to see the compass update in real time.
            Heading accuracy depends on the device magnetometer and calibration.
          </p>
        </section>

        <section class="panel stack height-calc-section">
          <div class="section-head">
            <div>
              <p class="eyebrow">Clinometer</p>
              <h2>Height calculator</h2>
            </div>
            <span
              class="chip"
              :class="{ 'chip--active': heightCalcAngleLocked != null }"
            >
              {{ heightCalcAngleLocked != null ? 'Locked' : 'Live' }}
            </span>
          </div>

          <!-- Visual clinometer -->
          <div class="clino">
            <div class="clino__gauge">
              <!-- Sky/ground split -->
              <div class="clino__sky"></div>
              <div class="clino__ground"></div>

              <!-- Angle arc -->
              <svg class="clino__arc" viewBox="0 0 200 200">
                <!-- Reference lines -->
                <line x1="10" y1="100" x2="190" y2="100" stroke="rgba(255,255,255,0.12)" stroke-width="1" />
                <line x1="100" y1="10" x2="100" y2="190" stroke="rgba(255,255,255,0.06)" stroke-width="1" stroke-dasharray="3 3" />

                <!-- Degree marks -->
                <line
                  v-for="deg in [10, 20, 30, 40, 50, 60, 70, 80]"
                  :key="`mark-${deg}`"
                  :x1="100 + Math.cos((-deg * Math.PI) / 180) * 72"
                  :y1="100 - Math.sin((-deg * Math.PI) / 180) * 72"
                  :x2="100 + Math.cos((-deg * Math.PI) / 180) * 82"
                  :y2="100 - Math.sin((-deg * Math.PI) / 180) * 82"
                  stroke="rgba(255,255,255,0.2)"
                  stroke-width="1"
                />
                <line
                  v-for="deg in [-10, -20, -30]"
                  :key="`mark-neg-${deg}`"
                  :x1="100 + Math.cos((-deg * Math.PI) / 180) * 72"
                  :y1="100 - Math.sin((-deg * Math.PI) / 180) * 72"
                  :x2="100 + Math.cos((-deg * Math.PI) / 180) * 82"
                  :y2="100 - Math.sin((-deg * Math.PI) / 180) * 82"
                  stroke="rgba(255,255,255,0.12)"
                  stroke-width="1"
                />

                <!-- Angle labels -->
                <text
                  v-for="deg in [0, 15, 30, 45, 60, 75, 90]"
                  :key="`label-${deg}`"
                  :x="100 + Math.cos((-deg * Math.PI) / 180) * 88"
                  :y="100 - Math.sin((-deg * Math.PI) / 180) * 88"
                  fill="rgba(255,255,255,0.35)"
                  font-size="7"
                  text-anchor="middle"
                  dominant-baseline="central"
                >{{ deg }}°</text>

                <!-- Filled angle wedge -->
                <path
                  v-if="heightCalcAngle != null && heightCalcAngle !== 0"
                  :d="`M 100 100 L ${100 + 68} 100 A 68 68 0 ${Math.abs(heightCalcAngle) > 180 ? 1 : 0} ${heightCalcAngle < 0 ? 1 : 0} ${100 + Math.cos((-heightCalcAngle * Math.PI) / 180) * 68} ${100 - Math.sin((-heightCalcAngle * Math.PI) / 180) * 68} Z`"
                  :fill="heightCalcAngle >= 0 ? 'rgba(255, 213, 107, 0.12)' : 'rgba(126, 213, 255, 0.12)'"
                  :stroke="heightCalcAngle >= 0 ? 'rgba(255, 213, 107, 0.3)' : 'rgba(126, 213, 255, 0.3)'"
                  stroke-width="0.5"
                />

                <!-- Needle -->
                <line
                  x1="100"
                  y1="100"
                  :x2="100 + Math.cos((-(heightCalcAngle ?? 0) * Math.PI) / 180) * 72"
                  :y2="100 - Math.sin((-(heightCalcAngle ?? 0) * Math.PI) / 180) * 72"
                  :stroke="heightCalcAngleLocked != null ? '#ffd56b' : '#ff9c73'"
                  stroke-width="2"
                  stroke-linecap="round"
                />

                <!-- Centre dot -->
                <circle cx="100" cy="100" r="4" fill="rgba(255,255,255,0.9)" />
              </svg>

              <!-- Angle readout -->
              <div class="clino__readout">
                <strong>
                  {{ heightCalcAngle == null ? '--' : `${heightCalcAngle.toFixed(1)}°` }}
                </strong>
              </div>
            </div>

            <!-- Result panel next to gauge -->
            <div class="clino__result">
              <p class="eyebrow">Estimated height</p>
              <div class="clino__height">
                <strong>
                  {{
                    heightCalcResult == null
                      ? '--'
                      : heightCalcResult.toFixed(1)
                  }}
                </strong>
                <span>{{ heightCalcUnit }}</span>
              </div>
              <div class="clino__formula">
                <small>
                  tan({{ heightCalcAngle == null ? '--' : `${heightCalcAngle.toFixed(1)}°` }})
                  &times; {{ heightCalcDistance }}{{ heightCalcUnit }}
                  + {{ heightCalcEyeHeight }}{{ heightCalcUnit }}
                </small>
              </div>
            </div>
          </div>

          <!-- Lock / unlock angle -->
          <div class="button-row">
            <button
              class="button button--primary"
              :disabled="heightCalcLivePitch == null"
              @click="lockHeightAngle"
              v-if="heightCalcAngleLocked == null"
            >
              Lock Angle
            </button>
            <button
              class="button button--secondary"
              @click="unlockHeightAngle"
              v-else
            >
              Unlock Angle
            </button>
          </div>

          <!-- Inputs -->
          <div class="clino__inputs">
            <label class="field">
              <span>Distance to object</span>
              <div class="clino__input-row">
                <input
                  v-model.number="heightCalcDistance"
                  type="number"
                  min="0.1"
                  step="0.5"
                  inputmode="decimal"
                />
                <select v-model="heightCalcUnit" class="clino__unit-select">
                  <option value="m">m</option>
                  <option value="ft">ft</option>
                  <option value="yd">yd</option>
                </select>
              </div>
            </label>
            <label class="field">
              <span>Eye height</span>
              <div class="clino__input-row">
                <input
                  v-model.number="heightCalcEyeHeight"
                  type="number"
                  min="0"
                  step="0.1"
                  inputmode="decimal"
                />
                <span class="clino__unit-label">{{ heightCalcUnit }}</span>
              </div>
            </label>
          </div>

          <p class="comparison-copy">
            Stand at a known distance from a tree, building, or pole. Hold the phone at eye
            level, tilt it until the top edge lines up with the top of the object, then lock the angle.
            Height = tan(angle) &times; distance + your eye height.
          </p>
        </section>

        <section class="panel stack width-calc-section">
          <div class="section-head">
            <div>
              <p class="eyebrow">Clinometer</p>
              <h2>Width calculator</h2>
            </div>
            <span
              class="chip"
              :class="{
                'chip--active': widthCalcLeftHeading != null && widthCalcRightHeading == null,
                'chip--done': widthCalcLeftHeading != null && widthCalcRightHeading != null
              }"
            >
              {{
                widthCalcLeftHeading != null && widthCalcRightHeading != null
                  ? 'Measured'
                  : widthCalcLeftHeading != null
                    ? 'Left locked'
                    : 'Ready'
              }}
            </span>
          </div>

          <!-- Width visual -->
          <div class="width-calc-visual">
            <div class="width-calc-compass">
              <svg class="width-calc-svg" viewBox="0 0 200 200">
                <!-- Background circle -->
                <circle cx="100" cy="100" r="85" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
                <circle cx="100" cy="100" r="60" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="1" />

                <!-- Cardinal marks -->
                <text x="100" y="22" fill="rgba(255,255,255,0.3)" font-size="8" text-anchor="middle">N</text>
                <text x="185" y="104" fill="rgba(255,255,255,0.2)" font-size="8" text-anchor="middle">E</text>
                <text x="100" y="192" fill="rgba(255,255,255,0.2)" font-size="8" text-anchor="middle">S</text>
                <text x="15" y="104" fill="rgba(255,255,255,0.2)" font-size="8" text-anchor="middle">W</text>

                <!-- Angle arc between left and right -->
                <path
                  v-if="widthCalcLeftHeading != null && widthCalcRightHeading != null"
                  :d="(() => {
                    const lr = (-widthCalcLeftHeading + 90) * Math.PI / 180
                    const rr = (-widthCalcRightHeading + 90) * Math.PI / 180
                    const r = 55
                    const x1 = 100 + Math.cos(lr) * r
                    const y1 = 100 - Math.sin(lr) * r
                    const x2 = 100 + Math.cos(rr) * r
                    const y2 = 100 - Math.sin(rr) * r
                    const sweep = widthCalcAngleSpan > 180 ? 1 : 0
                    return `M 100 100 L ${x1} ${y1} A ${r} ${r} 0 ${sweep} 1 ${x2} ${y2} Z`
                  })()"
                  fill="rgba(255, 156, 115, 0.12)"
                  stroke="rgba(255, 156, 115, 0.35)"
                  stroke-width="0.5"
                />

                <!-- Left marker -->
                <line
                  v-if="widthCalcLeftHeading != null"
                  x1="100" y1="100"
                  :x2="100 + Math.cos((-widthCalcLeftHeading + 90) * Math.PI / 180) * 70"
                  :y2="100 - Math.sin((-widthCalcLeftHeading + 90) * Math.PI / 180) * 70"
                  stroke="#7be6bf"
                  stroke-width="2"
                  stroke-linecap="round"
                />

                <!-- Right marker -->
                <line
                  v-if="widthCalcRightHeading != null"
                  x1="100" y1="100"
                  :x2="100 + Math.cos((-widthCalcRightHeading + 90) * Math.PI / 180) * 70"
                  :y2="100 - Math.sin((-widthCalcRightHeading + 90) * Math.PI / 180) * 70"
                  stroke="#ff9c73"
                  stroke-width="2"
                  stroke-linecap="round"
                />

                <!-- Live heading needle -->
                <line
                  v-if="widthCalcLiveHeading != null"
                  x1="100" y1="100"
                  :x2="100 + Math.cos((-widthCalcLiveHeading + 90) * Math.PI / 180) * 80"
                  :y2="100 - Math.sin((-widthCalcLiveHeading + 90) * Math.PI / 180) * 80"
                  stroke="rgba(255,255,255,0.5)"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-dasharray="4 3"
                />

                <!-- Centre dot -->
                <circle cx="100" cy="100" r="3" fill="rgba(255,255,255,0.8)" />
              </svg>
            </div>

            <!-- Result panel -->
            <div class="width-calc-result">
              <p class="eyebrow">Estimated width</p>
              <div class="clino__height">
                <strong>
                  {{ widthCalcResult == null ? '--' : widthCalcResult.toFixed(1) }}
                </strong>
                <span>{{ widthCalcUnit }}</span>
              </div>
              <div class="clino__formula" v-if="widthCalcAngleSpan != null">
                <small>
                  2 &times; {{ widthCalcDistance }}{{ widthCalcUnit }}
                  &times; tan({{ widthCalcAngleSpan.toFixed(1) }}° / 2)
                </small>
              </div>
              <div class="width-calc-angles">
                <small>
                  Left: {{ widthCalcLeftHeading != null ? `${widthCalcLeftHeading.toFixed(1)}°` : '--' }}
                </small>
                <small>
                  Right: {{ widthCalcRightHeading != null ? `${widthCalcRightHeading.toFixed(1)}°` : '--' }}
                </small>
                <small v-if="widthCalcAngleSpan != null">
                  Span: {{ widthCalcAngleSpan.toFixed(1) }}°
                </small>
              </div>
            </div>
          </div>

          <!-- Lock buttons -->
          <div class="button-row">
            <button
              class="button button--primary"
              :disabled="widthCalcLiveHeading == null"
              @click="lockWidthLeft"
            >
              {{ widthCalcLeftHeading != null ? 'Re-lock Left' : 'Lock Left Edge' }}
            </button>
            <button
              class="button button--secondary"
              :disabled="widthCalcLiveHeading == null"
              @click="lockWidthRight"
            >
              {{ widthCalcRightHeading != null ? 'Re-lock Right' : 'Lock Right Edge' }}
            </button>
            <button
              class="button button--ghost"
              :disabled="widthCalcLeftHeading == null && widthCalcRightHeading == null"
              @click="resetWidthCalc"
            >
              Reset
            </button>
          </div>

          <!-- Inputs -->
          <div class="clino__inputs">
            <label class="field">
              <span>Distance to object</span>
              <div class="clino__input-row">
                <input
                  v-model.number="widthCalcDistance"
                  type="number"
                  min="0.1"
                  step="0.5"
                  inputmode="decimal"
                />
                <select v-model="widthCalcUnit" class="clino__unit-select">
                  <option value="m">m</option>
                  <option value="ft">ft</option>
                  <option value="yd">yd</option>
                </select>
              </div>
            </label>
          </div>

          <p class="comparison-copy">
            Stand at a known distance facing the object. Point the phone at the left edge and lock,
            then point at the right edge and lock. Width = 2 &times; distance &times; tan(angle / 2).
          </p>
        </section>

      </div>
    </section>

  </main>
</template>

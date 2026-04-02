<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CompassRose from './components/CompassRose.vue'
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
const safeDialLastDelta = ref(0)
const safeDialSequence = ref([
  { id: createSpellId(), direction: 'cw', degrees: 90 },
  { id: createSpellId(), direction: 'ccw', degrees: 50 }
])
const safeDialStepIndex = ref(0)
const safeDialStepStartTurn = ref(0)
const safeDialGuideTickIndex = ref(0)
const safeDialLastCompletedStep = ref(-1)
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
const heightCalcDistance = ref(10)
const heightCalcUnit = ref('m')
const heightCalcAngleLocked = ref(null)
const heightCalcEyeHeight = ref(1.6)

const SAFE_DIAL_GUIDE_DEGREES = 10
const WATER_BUCKET_GOAL_MS = 15000
const WATER_BUCKET_SAFE_TILT = 8
const WATER_BUCKET_WARN_TILT = 14
const WATER_BUCKET_SPILL_TILT = 22
const WATER_BUCKET_SAFE_ROTATION = 22

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
    return 'Strong confirmation fired. Restart the sequence to run it again.'
  }

  if (!safeDialCurrentStep.value) {
    return 'Add at least one step to arm the dial trainer.'
  }

  if (!safeDialEnabled.value) {
    return 'Set the sequence, then arm the dial and rotate the phone like a lock dial.'
  }

  if (safeDialWrongDirection.value) {
    return 'Reverse direction. You are moving away from the current target.'
  }

  return `${safeDialStepRemaining.value.toFixed(0)}° remaining on this step. Light cues mark progress, strong confirmation marks the target.`
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
    (waterBucketRotationMagnitude.value ?? 0) >= 70
  ) {
    return 'Major spill'
  }

  if (
    waterBucketTilt.value >= WATER_BUCKET_WARN_TILT ||
    (waterBucketRotationMagnitude.value ?? 0) >= 40
  ) {
    return 'Sloshing'
  }

  return 'Steady'
})
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
}

function resetWaterBucketRun() {
  waterBucketStartTimestamp.value = 0
  waterBucketLastTimestamp.value = 0
  waterBucketWaterLevel.value = 100
  waterBucketLastDurationMs.value = 0
  waterBucketSpillEvents.value = 0
  waterBucketWasSpilling.value = false
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
  waterBucketLastTimestamp.value = timestamp
  waterBucketLastDurationMs.value = Math.max(0, timestamp - waterBucketStartTimestamp.value)

  const beta = sample.orientation.beta
  const gamma = sample.orientation.gamma
  const tilt =
    typeof beta === 'number' && typeof gamma === 'number'
      ? Math.hypot(
          beta - waterBucketBaseline.value.beta,
          gamma - waterBucketBaseline.value.gamma
        )
      : null
  const rotation = Math.hypot(sample.rotationRate.beta ?? 0, sample.rotationRate.gamma ?? 0)

  let spillRate = 0

  if (tilt != null) {
    if (tilt > WATER_BUCKET_SAFE_TILT) {
      spillRate += (tilt - WATER_BUCKET_SAFE_TILT) * 1.35
    }

    if (tilt > WATER_BUCKET_WARN_TILT) {
      spillRate += (tilt - WATER_BUCKET_WARN_TILT) * 1.2
    }

    if (tilt > WATER_BUCKET_SPILL_TILT) {
      spillRate += 16
    }
  }

  if (rotation > WATER_BUCKET_SAFE_ROTATION) {
    spillRate += (rotation - WATER_BUCKET_SAFE_ROTATION) * 0.22
  }

  const spillingNow = spillRate > 4

  if (spillingNow && !waterBucketWasSpilling.value) {
    waterBucketSpillEvents.value += 1
    triggerHaptic(25)
  }

  waterBucketWasSpilling.value = spillingNow
  waterBucketWaterLevel.value = Math.max(
    0,
    waterBucketWaterLevel.value - spillRate * (deltaMs / 1000)
  )

  if (waterBucketWaterLevel.value <= 0) {
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

  if (!safeDialCurrentStep.value) {
    return
  }

  const stepDegrees = getSafeDialStepDegrees(safeDialCurrentStep.value)
  const progress = safeDialStepProgress.value
  const nextGuideTick = Math.floor(Math.min(progress, stepDegrees) / SAFE_DIAL_GUIDE_DEGREES)

  if (nextGuideTick > safeDialGuideTickIndex.value && progress < stepDegrees) {
    safeDialGuideTickIndex.value = nextGuideTick
    triggerHaptic(buildTickPattern(10))
  }

  if (progress < stepDegrees) {
    return
  }

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
                      : `${Math.round(safeDialRelativeAngle) % 360}°`
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
            Rotate your phone like a real safe dial. {{ safeDialFeedbackLabel }} feedback
            fires every {{ SAFE_DIAL_GUIDE_DEGREES }}° and a strong pulse at each lock point.
          </p>
        </section>

        <section class="panel stack">
          <div class="section-head">
            <div>
              <p class="eyebrow">Balance game</p>
              <h2>Water bucket challenge</h2>
            </div>
            <span class="chip">{{ safeDialFeedbackLabel }}</span>
          </div>

          <div class="water-bucket">
            <div class="water-bucket__viz">
              <div class="water-bucket__frame">
                <span class="water-bucket__handle"></span>
                <div
                  class="water-bucket__water"
                  :style="{
                    height: `${Math.max(8, waterBucketWaterDisplay)}%`,
                    transform: `translateX(${clamp((waterBucketRollOffset ?? 0) * 0.45, -14, 14)}px)`
                  }"
                >
                  <span
                    class="water-bucket__surface"
                    :style="{
                      transform: `translateX(-50%) rotate(${clamp(-(waterBucketRollOffset ?? 0), -18, 18)}deg)`
                    }"
                  ></span>
                </div>
              </div>
              <div class="water-bucket__caption">
                <strong>{{ waterBucketWaterDisplay }}%</strong>
                <small>water left</small>
              </div>
            </div>

            <div class="water-bucket__target">
              <p class="eyebrow">Hold it like a tray</p>
              <h3>{{ waterBucketEnabled ? 'Keep it flat' : 'Ready to balance' }}</h3>
              <div class="safe-dial__stats">
                <span>{{ (waterBucketElapsedMs / 1000).toFixed(1) }}s / 15.0s</span>
                <span>
                  {{
                    waterBucketTilt == null ? 'Tilt n/a' : `${waterBucketTilt.toFixed(1)}° tilt`
                  }}
                </span>
                <span>
                  {{
                    waterBucketRotationMagnitude == null
                      ? 'Motion n/a'
                      : `${waterBucketRotationMagnitude.toFixed(0)}°/s motion`
                  }}
                </span>
                <span>{{ waterBucketRiskLabel }}</span>
                <span>{{ waterBucketSpillEvents }} spill alerts</span>
              </div>
              <div class="guide-progress">
                <div class="guide-progress__header">
                  <span class="label">Bucket survival</span>
                  <strong>{{ waterBucketGoalProgress }}%</strong>
                </div>
                <div class="guide-progress__track">
                  <span
                    class="guide-progress__fill"
                    :style="{ width: `${waterBucketGoalProgress}%` }"
                  ></span>
                </div>
              </div>
              <p class="comparison-copy">
                {{ waterBucketGuidanceCopy }}
              </p>
            </div>
          </div>

          <div class="water-bucket__stats">
            <article class="safe-sequence-track__card">
              <strong>{{ waterBucketPitchOffset == null ? 'n/a' : `${waterBucketPitchOffset.toFixed(1)}°` }}</strong>
              <span>Pitch drift</span>
              <small>front / back</small>
            </article>
            <article class="safe-sequence-track__card">
              <strong>{{ waterBucketRollOffset == null ? 'n/a' : `${waterBucketRollOffset.toFixed(1)}°` }}</strong>
              <span>Roll drift</span>
              <small>left / right</small>
            </article>
            <article class="safe-sequence-track__card">
              <strong>{{ (waterBucketBestTimeMs / 1000).toFixed(1) }}s</strong>
              <span>Best run</span>
              <small>personal record</small>
            </article>
          </div>

          <div class="button-row">
            <button class="button button--secondary" @click="startWaterBucketGame">
              {{ waterBucketEnabled ? 'Restart Bucket Game' : 'Start Bucket Game' }}
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
              Set Flat Point
            </button>
          </div>

          <p class="comparison-copy">
            The bucket leaks when tilt or sudden wrist motion gets too high. Start with the
            phone flat in your palm and see if you can keep water in the bucket for 15 seconds.
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

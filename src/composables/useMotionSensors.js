import { computed, onBeforeUnmount, ref } from 'vue'

const HISTORY_LIMIT = 180

// ── Low-pass filter (exponential moving average) ──────────────────────
// Smoothing factors: 0 = ignore new data, 1 = no smoothing (pass-through).
// Typical phone IMUs report at 60-100 Hz; these alphas reject jitter while
// preserving real gesture dynamics.
const ACCEL_ALPHA = 0.35        // acceleration: moderate smoothing (noisy sensor)
const GYRO_ALPHA = 0.45         // rotation rate: lighter smoothing (less noisy, fast signals)
const ORIENTATION_ALPHA = 0.30  // orientation angles: heavier smoothing (derived/fused, can drift)

// Noise gate thresholds — values below these are clamped to zero to prevent
// drift and phantom motion when the device is stationary.
const ACCEL_NOISE_FLOOR = 0.08  // m/s²  (typical phone noise ~0.05-0.12)
const GYRO_NOISE_FLOOR = 0.6    // °/s   (typical phone noise ~0.3-1.0)

function round(value, digits = 3) {
  if (value == null || Number.isNaN(value)) {
    return null
  }

  return Number(value.toFixed(digits))
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function gateNoise(value, floor) {
  if (value == null) return null
  return Math.abs(value) < floor ? 0 : value
}

function emaScalar(previous, current, alpha) {
  if (current == null) return previous
  if (previous == null) return current
  return previous + alpha * (current - previous)
}

function makeVector(source) {
  return {
    x: round(numberOrNull(source?.x)),
    y: round(numberOrNull(source?.y)),
    z: round(numberOrNull(source?.z))
  }
}

function makeFilteredVector(source, previous, alpha, noiseFloor) {
  const raw = makeVector(source)
  return {
    x: round(gateNoise(emaScalar(previous?.x ?? null, raw.x, alpha), noiseFloor)),
    y: round(gateNoise(emaScalar(previous?.y ?? null, raw.y, alpha), noiseFloor)),
    z: round(gateNoise(emaScalar(previous?.z ?? null, raw.z, alpha), noiseFloor))
  }
}

function makeRotation(source) {
  return {
    alpha: round(numberOrNull(source?.alpha)),
    beta: round(numberOrNull(source?.beta)),
    gamma: round(numberOrNull(source?.gamma))
  }
}

function makeFilteredRotation(source, previous, alpha, noiseFloor) {
  const raw = makeRotation(source)
  return {
    alpha: round(gateNoise(emaScalar(previous?.alpha ?? null, raw.alpha, alpha), noiseFloor)),
    beta: round(gateNoise(emaScalar(previous?.beta ?? null, raw.beta, alpha), noiseFloor)),
    gamma: round(gateNoise(emaScalar(previous?.gamma ?? null, raw.gamma, alpha), noiseFloor))
  }
}

function createEmptySample() {
  return {
    sequence: 0,
    timestamp: 0,
    interval: null,
    acceleration: makeVector(),
    accelerationIncludingGravity: makeVector(),
    rotationRate: makeRotation(),
    orientation: {
      alpha: null,
      beta: null,
      gamma: null,
      absolute: false,
      compassHeading: null
    }
  }
}

function resolveCompassHeading(event) {
  if (typeof event?.webkitCompassHeading === 'number') {
    return round(event.webkitCompassHeading)
  }

  if (typeof event?.alpha === 'number') {
    return round((360 - event.alpha + 360) % 360)
  }

  return null
}

export function useMotionSensors() {
  const permissionState = ref('idle')
  const supportState = ref({
    motion: typeof window !== 'undefined' && 'DeviceMotionEvent' in window,
    orientation:
      typeof window !== 'undefined' && 'DeviceOrientationEvent' in window
  })
  const listening = ref(false)
  const currentSample = ref(createEmptySample())
  const history = ref([])
  const lastError = ref('')
  const sampleRevision = ref(0)
  const sampleListeners = new Set()
  let sampleSequence = 0

  let lastOrientation = createEmptySample().orientation
  let removeListeners = () => {}

  // Filter state — holds the previous filtered values for EMA continuity
  let prevAccel = null
  let prevAccelGravity = null
  let prevRotation = null
  let prevOrientationAngles = null

  function pushSample(sample) {
    const nextSample = {
      ...sample,
      sequence: ++sampleSequence
    }

    currentSample.value = nextSample
    history.value = [...history.value.slice(-(HISTORY_LIMIT - 1)), nextSample]
    sampleRevision.value += 1
    sampleListeners.forEach((listener) => listener(nextSample))
  }

  function handleMotion(event) {
    const timestamp = Math.round(event.timeStamp || performance.now())

    const filteredAccel = makeFilteredVector(event.acceleration, prevAccel, ACCEL_ALPHA, ACCEL_NOISE_FLOOR)
    const filteredAccelGravity = makeFilteredVector(event.accelerationIncludingGravity, prevAccelGravity, ACCEL_ALPHA, 0)
    const filteredRotation = makeFilteredRotation(event.rotationRate, prevRotation, GYRO_ALPHA, GYRO_NOISE_FLOOR)

    prevAccel = filteredAccel
    prevAccelGravity = filteredAccelGravity
    prevRotation = filteredRotation

    pushSample({
      timestamp,
      interval: round(numberOrNull(event.interval)),
      acceleration: filteredAccel,
      accelerationIncludingGravity: filteredAccelGravity,
      rotationRate: filteredRotation,
      orientation: { ...lastOrientation }
    })
  }

  function handleOrientation(event) {
    // Orientation angles use EMA but no noise gate (absolute angles, not deltas)
    const rawAlpha = numberOrNull(event.alpha)
    const rawBeta = numberOrNull(event.beta)
    const rawGamma = numberOrNull(event.gamma)

    const filteredBeta = round(emaScalar(prevOrientationAngles?.beta ?? null, rawBeta, ORIENTATION_ALPHA))
    const filteredGamma = round(emaScalar(prevOrientationAngles?.gamma ?? null, rawGamma, ORIENTATION_ALPHA))
    // Alpha wraps 0-360 so EMA is applied only if the jump is small (avoids 359→1 glitch)
    const prevAlpha = prevOrientationAngles?.alpha
    let filteredAlpha
    if (prevAlpha != null && rawAlpha != null && Math.abs(((rawAlpha - prevAlpha + 540) % 360) - 180) < 30) {
      filteredAlpha = round(prevAlpha + ORIENTATION_ALPHA * (((rawAlpha - prevAlpha + 540) % 360) - 180))
      if (filteredAlpha < 0) filteredAlpha += 360
      if (filteredAlpha >= 360) filteredAlpha -= 360
    } else {
      filteredAlpha = round(rawAlpha)
    }

    prevOrientationAngles = { alpha: filteredAlpha, beta: filteredBeta, gamma: filteredGamma }

    lastOrientation = {
      alpha: filteredAlpha,
      beta: filteredBeta,
      gamma: filteredGamma,
      absolute: Boolean(event.absolute),
      compassHeading: resolveCompassHeading(event)
    }

    if (!currentSample.value.timestamp) {
      pushSample({
        ...createEmptySample(),
        timestamp: Math.round(event.timeStamp || performance.now()),
        orientation: { ...lastOrientation }
      })
      return
    }

    currentSample.value = {
      ...currentSample.value,
      orientation: { ...lastOrientation }
    }
  }

  async function requestPermissionIfNeeded(sensorClass) {
    if (typeof sensorClass?.requestPermission !== 'function') {
      return 'granted'
    }

    return sensorClass.requestPermission()
  }

  async function start() {
    if (listening.value) {
      return true
    }

    if (!supportState.value.motion && !supportState.value.orientation) {
      permissionState.value = 'unsupported'
      lastError.value = 'This browser does not expose motion sensors.'
      return false
    }

    lastError.value = ''

    try {
      const motionPermission = supportState.value.motion
        ? await requestPermissionIfNeeded(window.DeviceMotionEvent)
        : 'granted'
      const orientationPermission = supportState.value.orientation
        ? await requestPermissionIfNeeded(window.DeviceOrientationEvent)
        : 'granted'

      if (motionPermission !== 'granted' || orientationPermission !== 'granted') {
        permissionState.value = 'denied'
        lastError.value =
          'Sensor access was denied. Open this on a phone and grant motion permission.'
        return false
      }

      const motionOptions = { passive: true }
      window.addEventListener('devicemotion', handleMotion, motionOptions)
      window.addEventListener(
        'deviceorientationabsolute',
        handleOrientation,
        motionOptions
      )
      window.addEventListener('deviceorientation', handleOrientation, motionOptions)

      removeListeners = () => {
        window.removeEventListener('devicemotion', handleMotion, motionOptions)
        window.removeEventListener(
          'deviceorientationabsolute',
          handleOrientation,
          motionOptions
        )
        window.removeEventListener(
          'deviceorientation',
          handleOrientation,
          motionOptions
        )
      }

      listening.value = true
      permissionState.value = 'granted'
      return true
    } catch (error) {
      permissionState.value = 'denied'
      lastError.value =
        error instanceof Error ? error.message : 'Unable to enable sensors.'
      return false
    }
  }

  function stop() {
    removeListeners()
    removeListeners = () => {}
    listening.value = false
  }

  function clearHistory() {
    history.value = history.value.slice(-1)
  }

  function onSample(listener) {
    sampleListeners.add(listener)

    return () => {
      sampleListeners.delete(listener)
    }
  }

  onBeforeUnmount(stop)

  return {
    clearHistory,
    currentSample,
    history,
    isListening: computed(() => listening.value),
    lastError,
    onSample,
    permissionState,
    sampleRevision,
    start,
    stop,
    supportState
  }
}

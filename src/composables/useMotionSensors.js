import { computed, onBeforeUnmount, ref } from 'vue'

const HISTORY_LIMIT = 180

function round(value, digits = 3) {
  if (value == null || Number.isNaN(value)) {
    return null
  }

  return Number(value.toFixed(digits))
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function makeVector(source) {
  return {
    x: round(numberOrNull(source?.x)),
    y: round(numberOrNull(source?.y)),
    z: round(numberOrNull(source?.z))
  }
}

function makeRotation(source) {
  return {
    alpha: round(numberOrNull(source?.alpha)),
    beta: round(numberOrNull(source?.beta)),
    gamma: round(numberOrNull(source?.gamma))
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

    pushSample({
      timestamp,
      interval: round(numberOrNull(event.interval)),
      acceleration: makeVector(event.acceleration),
      accelerationIncludingGravity: makeVector(event.accelerationIncludingGravity),
      rotationRate: makeRotation(event.rotationRate),
      orientation: { ...lastOrientation }
    })
  }

  function handleOrientation(event) {
    lastOrientation = {
      alpha: round(numberOrNull(event.alpha)),
      beta: round(numberOrNull(event.beta)),
      gamma: round(numberOrNull(event.gamma)),
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

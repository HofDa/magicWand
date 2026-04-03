function round(value, digits = 2) {
  if (value == null || Number.isNaN(value)) {
    return null
  }

  return Number(value.toFixed(digits))
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function vectorMagnitude(vector) {
  return Math.sqrt(
    numberOrZero(vector?.x) ** 2 +
      numberOrZero(vector?.y) ** 2 +
      numberOrZero(vector?.z) ** 2
  )
}

function angleDelta(current, base) {
  if (current == null || base == null) {
    return 0
  }

  const delta = ((current - base + 540) % 360) - 180
  return delta
}

function durationBetween(firstSample, lastSample) {
  if (!firstSample || !lastSample) {
    return 0
  }

  return Math.max(0, numberOrZero(lastSample.timestamp) - numberOrZero(firstSample.timestamp))
}

// ── Normalization scales ──────────────────────────────────────────────
// Chosen to map real-world gesture ranges into roughly [-1, 1].
// Typical wand gesture: 2-15 m/s² accel peaks, 50-400 °/s rotation peaks.
// Previous values (/8 accel, /200 gyro) were too aggressive — they clipped
// moderate gestures and couldn't distinguish gentle from strong motions.
const ACCEL_SCALE = 15    // m/s²  — covers the practical gesture range without clipping
const GYRO_SCALE = 300    // °/s   — wrist flicks peak ~200-400 °/s on phones
const PITCH_ROLL_SCALE = 120 // °  — wider range avoids saturation during full swings
const HEADING_SCALE = 180 // °     — half-circle normalization

// Dead zone: acceleration deltas below this are treated as zero to reject
// sensor drift and small hand tremors from contaminating the feature vector.
const ACCEL_DEAD_ZONE = 0.15 // m/s²
const GYRO_DEAD_ZONE = 1.5   // °/s

function applyDeadZone(value, threshold) {
  return Math.abs(value) < threshold ? 0 : value
}

function featureVector(sample, baseline) {
  const ax = applyDeadZone(numberOrZero(sample.acceleration?.x) - numberOrZero(baseline.acceleration?.x), ACCEL_DEAD_ZONE)
  const ay = applyDeadZone(numberOrZero(sample.acceleration?.y) - numberOrZero(baseline.acceleration?.y), ACCEL_DEAD_ZONE)
  const az = applyDeadZone(numberOrZero(sample.acceleration?.z) - numberOrZero(baseline.acceleration?.z), ACCEL_DEAD_ZONE)
  const ra = applyDeadZone(numberOrZero(sample.rotationRate?.alpha), GYRO_DEAD_ZONE)
  const rb = applyDeadZone(numberOrZero(sample.rotationRate?.beta), GYRO_DEAD_ZONE)
  const rg = applyDeadZone(numberOrZero(sample.rotationRate?.gamma), GYRO_DEAD_ZONE)

  return [
    clamp(ax / ACCEL_SCALE, -1.5, 1.5),
    clamp(ay / ACCEL_SCALE, -1.5, 1.5),
    clamp(az / ACCEL_SCALE, -1.5, 1.5),
    clamp(ra / GYRO_SCALE, -1.5, 1.5),
    clamp(rb / GYRO_SCALE, -1.5, 1.5),
    clamp(rg / GYRO_SCALE, -1.5, 1.5),
    clamp(angleDelta(sample.orientation?.beta, baseline.orientation?.beta) / PITCH_ROLL_SCALE, -1.2, 1.2),
    clamp(angleDelta(sample.orientation?.gamma, baseline.orientation?.gamma) / PITCH_ROLL_SCALE, -1.2, 1.2),
    clamp(angleDelta(sample.orientation?.compassHeading, baseline.orientation?.compassHeading) / HEADING_SCALE, -1.2, 1.2)
  ]
}

function resampleVectors(vectors, size = 64) {
  if (!vectors.length) {
    return []
  }

  if (vectors.length === 1) {
    return Array.from({ length: size }, () => [...vectors[0]])
  }

  return Array.from({ length: size }, (_, index) => {
    const exactIndex = (index / (size - 1)) * (vectors.length - 1)
    const lowerIndex = Math.floor(exactIndex)
    const upperIndex = Math.min(vectors.length - 1, Math.ceil(exactIndex))
    const ratio = exactIndex - lowerIndex

    return vectors[lowerIndex].map((value, dimension) => {
      const upperValue = vectors[upperIndex][dimension]
      return value + (upperValue - value) * ratio
    })
  })
}

function vectorDistance(vectorA, vectorB) {
  return Math.sqrt(
    vectorA.reduce((total, value, index) => {
      const delta = value - vectorB[index]
      return total + delta * delta
    }, 0)
  )
}

function getAxisTrend(samples, accessor) {
  const totals = samples.reduce(
    (aggregate, sample) => {
      aggregate.x += numberOrZero(accessor(sample)?.x)
      aggregate.y += numberOrZero(accessor(sample)?.y)
      aggregate.z += numberOrZero(accessor(sample)?.z)
      return aggregate
    },
    { x: 0, y: 0, z: 0 }
  )

  const dominantAxis = ['x', 'y', 'z'].sort(
    (left, right) => Math.abs(totals[right]) - Math.abs(totals[left])
  )[0]

  return { axis: dominantAxis, value: totals[dominantAxis] }
}

function directionLabel(axis, value) {
  if (axis === 'x') {
    return value >= 0 ? 'sweep toward the right edge' : 'sweep toward the left edge'
  }

  if (axis === 'y') {
    return value >= 0 ? 'lift toward the top edge' : 'drop toward the bottom edge'
  }

  return value >= 0 ? 'push the wand forward' : 'pull the wand back'
}

function rotationLabel(axis, value) {
  if (Math.abs(value) < 25) {
    return ''
  }

  if (axis === 'x') {
    return value >= 0 ? 'roll clockwise through the wrist' : 'roll counter-clockwise through the wrist'
  }

  if (axis === 'y') {
    return value >= 0 ? 'pitch the tip forward' : 'pitch the tip back'
  }

  return value >= 0 ? 'twist clockwise around the wand axis' : 'twist counter-clockwise around the wand axis'
}

function intensityLabel(amount) {
  if (amount < 4) {
    return 'a light'
  }

  if (amount < 8) {
    return 'a steady'
  }

  return 'a sharp'
}

function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`
}

function movementCue(axis, value) {
  if (axis === 'x') {
    return value >= 0 ? 'Right' : 'Left'
  }

  if (axis === 'y') {
    return value >= 0 ? 'Up' : 'Down'
  }

  return value >= 0 ? 'Forward' : 'Back'
}

function movementSymbol(axis, value) {
  if (axis === 'x') {
    return value >= 0 ? '→' : '←'
  }

  if (axis === 'y') {
    return value >= 0 ? '↑' : '↓'
  }

  return value >= 0 ? '⇡' : '⇣'
}

function rotationCue(axis, value) {
  if (Math.abs(value) < 25) {
    return 'Hold'
  }

  if (axis === 'x') {
    return value >= 0 ? 'Roll CW' : 'Roll CCW'
  }

  if (axis === 'y') {
    return value >= 0 ? 'Pitch Fwd' : 'Pitch Back'
  }

  return value >= 0 ? 'Twist CW' : 'Twist CCW'
}

function rotationSymbol(value) {
  if (Math.abs(value) < 25) {
    return '•'
  }

  return value >= 0 ? '↻' : '↺'
}

function getSegmentCount(samples) {
  return Math.min(
    samples.length,
    clamp(Math.round(durationBetween(samples[0], samples.at(-1)) / 700), 2, 4)
  )
}

function buildInstructionSegments(samples) {
  if (samples.length < 6) {
    return []
  }

  const segmentCount = getSegmentCount(samples)
  const chunkSize = Math.ceil(samples.length / segmentCount)
  let elapsedMs = 0

  return Array.from({ length: segmentCount }, (_, index) => {
    const slice = samples.slice(index * chunkSize, (index + 1) * chunkSize)
    const durationMs = Math.max(250, durationBetween(slice[0], slice.at(-1)) || 250)
    const accelerationTrend = getAxisTrend(slice, (sample) => sample.acceleration)
    const rotationTrend = getAxisTrend(slice, (sample) => ({
      x: sample.rotationRate?.gamma,
      y: sample.rotationRate?.beta,
      z: sample.rotationRate?.alpha
    }))
    const movementStrength = vectorMagnitude({
      x: accelerationTrend.axis === 'x' ? accelerationTrend.value / slice.length : 0,
      y: accelerationTrend.axis === 'y' ? accelerationTrend.value / slice.length : 0,
      z: accelerationTrend.axis === 'z' ? accelerationTrend.value / slice.length : 0
    })

    const opening =
      index === 0 ? 'Open with' : index === segmentCount - 1 ? 'Finish with' : 'Then'
    const motionText = directionLabel(accelerationTrend.axis, accelerationTrend.value)
    const wristText = rotationLabel(rotationTrend.axis, rotationTrend.value)
    const detail = wristText ? `${motionText} and ${wristText}` : motionText
    const segment = {
      index,
      opening,
      durationMs,
      durationLabel: formatDuration(durationMs),
      startMs: elapsedMs,
      endMs: elapsedMs + durationMs,
      motionText,
      motionCue: movementCue(accelerationTrend.axis, accelerationTrend.value),
      motionSymbol: movementSymbol(accelerationTrend.axis, accelerationTrend.value),
      wristText,
      wristCue: rotationCue(rotationTrend.axis, rotationTrend.value),
      wristSymbol: rotationSymbol(rotationTrend.value),
      intensityText: intensityLabel(movementStrength),
      stepText: `${opening} ${intensityLabel(movementStrength)} ${detail} for ${formatDuration(durationMs)}.`
    }

    elapsedMs += durationMs
    return segment
  })
}

export function compactSamples(samples, maxSamples = 360) {
  if (samples.length <= maxSamples) {
    return samples
  }

  return Array.from({ length: maxSamples }, (_, index) => {
    const exactIndex = Math.floor((index / (maxSamples - 1)) * (samples.length - 1))
    return samples[exactIndex]
  })
}

export function extractMetrics(samples) {
  if (!samples.length) {
    return {
      durationMs: 0,
      sampleCount: 0,
      peakAcceleration: 0,
      peakRotation: 0,
      motionEnergy: 0,
      headingSpan: 0
    }
  }

  const baseline = samples[0]
  let peakAcceleration = 0
  let peakRotation = 0
  let motionEnergy = 0
  let headingSpan = 0

  for (const sample of samples) {
    const acceleration = vectorMagnitude(sample.acceleration)
    const rotation = vectorMagnitude(sample.rotationRate)
    peakAcceleration = Math.max(peakAcceleration, acceleration)
    peakRotation = Math.max(peakRotation, rotation)
    motionEnergy += acceleration + rotation / 20
    headingSpan = Math.max(
      headingSpan,
      Math.abs(
        angleDelta(
          sample.orientation?.compassHeading,
          baseline.orientation?.compassHeading
        )
      )
    )
  }

  return {
    durationMs: durationBetween(samples[0], samples.at(-1)),
    sampleCount: samples.length,
    peakAcceleration: round(peakAcceleration),
    peakRotation: round(peakRotation),
    motionEnergy: round(motionEnergy),
    headingSpan: round(headingSpan)
  }
}

export function createInstructionSteps(samples) {
  const segments = buildInstructionSegments(samples)
  return segments.length
    ? segments.map((segment) => segment.stepText)
    : ['Make a larger motion so the app can infer a full spell path.']
}

export function createInstructionGuide(samples) {
  return buildInstructionSegments(samples)
}

// ── Warping-tolerant distance ─────────────────────────────────────────
// Instead of strict point-to-point comparison, each template point is matched
// against a local neighbourhood (±WARP_WINDOW) in the attempt. This gives
// tolerance to small timing offsets — like a lightweight band-constrained DTW
// but in O(n·w) instead of O(n²), which is fine for 64-point vectors.
const WARP_WINDOW = 3

function warpTolerantAverageDistance(templateVectors, attemptVectors) {
  const n = templateVectors.length
  let totalDistance = 0

  for (let i = 0; i < n; i++) {
    let bestDist = Infinity
    const lo = Math.max(0, i - WARP_WINDOW)
    const hi = Math.min(n - 1, i + WARP_WINDOW)

    for (let j = lo; j <= hi; j++) {
      const d = vectorDistance(templateVectors[i], attemptVectors[j])
      if (d < bestDist) bestDist = d
    }

    totalDistance += bestDist
  }

  return totalDistance / n
}

export function compareRecordings(templateSamples, attemptSamples) {
  const templateMetrics = extractMetrics(templateSamples)
  const attemptMetrics = extractMetrics(attemptSamples)

  if (templateSamples.length < 8 || attemptSamples.length < 8) {
    return {
      score: 0,
      verdict: 'insufficient',
      distance: null,
      templateMetrics,
      attemptMetrics,
      tips: ['Record at least a second of motion for both the spell and the copy.']
    }
  }

  const templateVectors = resampleVectors(
    templateSamples.map((sample) => featureVector(sample, templateSamples[0]))
  )
  const attemptVectors = resampleVectors(
    attemptSamples.map((sample) => featureVector(sample, attemptSamples[0]))
  )

  // Use warping-tolerant distance for real-world timing tolerance
  const averageDistance = warpTolerantAverageDistance(templateVectors, attemptVectors)

  const durationRatio =
    Math.max(templateMetrics.durationMs, attemptMetrics.durationMs) /
    Math.max(1, Math.min(templateMetrics.durationMs, attemptMetrics.durationMs))

  const energyRatio =
    attemptMetrics.motionEnergy / Math.max(1, templateMetrics.motionEnergy)
  const rotationRatio =
    attemptMetrics.peakRotation / Math.max(1, templateMetrics.peakRotation)

  // ── Scoring weights ──────────────────────────────────────────────
  // Shape distance is the primary signal (weight 38). Duration, energy, and
  // rotation are secondary signals that penalise obviously wrong attempts
  // without dominating the score for close-but-imperfect matches.
  // The duration penalty is now symmetric — too fast is just as wrong as too slow.
  const score = Math.round(
    clamp(
      100 -
        averageDistance * 38 -
        Math.max(0, durationRatio - 1) * 18 -
        Math.abs(1 - clamp(energyRatio, 0.3, 3)) * 14 -
        Math.abs(1 - clamp(rotationRatio, 0.3, 3)) * 10,
      0,
      100
    )
  )

  const tips = []

  if (attemptMetrics.durationMs < templateMetrics.durationMs * 0.7) {
    tips.push('The copy is much shorter than the original. Slow down and follow the full arc.')
  } else if (attemptMetrics.durationMs < templateMetrics.durationMs * 0.85) {
    tips.push('The copy is a bit fast. Try matching the original tempo more closely.')
  } else if (attemptMetrics.durationMs > templateMetrics.durationMs * 1.4) {
    tips.push('The copy runs long. Tighten the path and avoid pausing between phases.')
  } else if (attemptMetrics.durationMs > templateMetrics.durationMs * 1.2) {
    tips.push('Slightly slow. Pick up the pace to match the original rhythm.')
  }

  if (attemptMetrics.motionEnergy < templateMetrics.motionEnergy * 0.6) {
    tips.push('Much less energy than the original. Drive the motion with more conviction.')
  } else if (attemptMetrics.motionEnergy < templateMetrics.motionEnergy * 0.8) {
    tips.push('A little weak. Push the stroke with more acceleration.')
  } else if (attemptMetrics.motionEnergy > templateMetrics.motionEnergy * 1.5) {
    tips.push('Too forceful. The original spell is smoother — ease off the acceleration.')
  }

  if (attemptMetrics.peakRotation < templateMetrics.peakRotation * 0.6) {
    tips.push('Not enough wrist rotation. The template spell twists more aggressively.')
  } else if (attemptMetrics.peakRotation > templateMetrics.peakRotation * 1.6) {
    tips.push('Too much wrist rotation. Dial back the twist to match the original.')
  }

  if (!tips.length) {
    tips.push('Your timing and motion envelope are close. Focus on keeping the same rhythm on every repetition.')
  }

  // Verdict thresholds — slightly more forgiving for "close" to reward
  // users who are genuinely replicating the gesture shape.
  let verdict = 'unstable'

  if (score >= 82) {
    verdict = 'locked'
  } else if (score >= 64) {
    verdict = 'close'
  } else if (score >= 40) {
    verdict = 'forming'
  }

  return {
    score,
    verdict,
    distance: round(averageDistance, 3),
    templateMetrics,
    attemptMetrics,
    tips
  }
}

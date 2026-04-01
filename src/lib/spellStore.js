const STORAGE_KEY = 'magic-wand.spellbook.v1'

function cloneSamples(samples) {
  return samples.map((sample) => ({
    timestamp: sample.timestamp,
    interval: sample.interval,
    acceleration: { ...sample.acceleration },
    accelerationIncludingGravity: { ...sample.accelerationIncludingGravity },
    rotationRate: { ...sample.rotationRate },
    orientation: { ...sample.orientation }
  }))
}

export function createSpellId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `spell-${Date.now()}-${Math.round(Math.random() * 1e5)}`
}

export function loadSpellbook() {
  if (typeof localStorage === 'undefined') {
    return []
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveSpellbook(spells) {
  if (typeof localStorage === 'undefined') {
    return false
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(spells))
    return true
  } catch {
    return false
  }
}

export function buildSpellRecord(baseSpell) {
  return {
    ...baseSpell,
    samples: cloneSamples(baseSpell.samples)
  }
}

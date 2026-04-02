
<script setup>
import { computed } from 'vue'

const props = defineProps({
  heading: {
    type: Number,
    default: null
  }
})

const cardinals = [
  { label: 'N', deg: 0 },
  { label: 'NE', deg: 45 },
  { label: 'E', deg: 90 },
  { label: 'SE', deg: 135 },
  { label: 'S', deg: 180 },
  { label: 'SW', deg: 225 },
  { label: 'W', deg: 270 },
  { label: 'NW', deg: 315 }
]

const ticks = Array.from({ length: 36 }, (_, i) => i * 10)

const cardinalLabel = computed(() => {
  if (props.heading == null) {
    return '--'
  }

  const h = ((props.heading % 360) + 360) % 360
  const index = Math.round(h / 45) % 8
  return cardinals[index].label
})

const safeHeading = computed(() =>
  typeof props.heading === 'number' && Number.isFinite(props.heading)
    ? props.heading
    : 0
)
</script>

<template>
  <div class="compass">
    <div class="compass__rose">
      <!-- Fixed pointer at top -->
      <span class="compass__pointer"></span>

      <!-- Rotating ring -->
      <div
        class="compass__ring"
        :style="{ transform: `rotate(${-safeHeading}deg)` }"
      >
        <!-- Degree ticks -->
        <span
          v-for="tick in ticks"
          :key="tick"
          class="compass__tick"
          :class="{ 'compass__tick--major': tick % 90 === 0 }"
          :style="{ transform: `rotate(${tick}deg)` }"
        ></span>

        <!-- Cardinal labels -->
        <span
          v-for="c in cardinals"
          :key="c.label"
          class="compass__cardinal"
          :class="{ 'compass__cardinal--primary': c.deg % 90 === 0 }"
          :style="{ transform: `rotate(${c.deg}deg)` }"
        >
          <span :style="{ transform: `rotate(${-c.deg + safeHeading}deg)` }">
            {{ c.label }}
          </span>
        </span>
      </div>

      <!-- Centre readout -->
      <div class="compass__readout">
        <strong>{{ heading == null ? 'n/a' : `${Math.round(((heading % 360) + 360) % 360)}°` }}</strong>
        <small>{{ cardinalLabel }}</small>
      </div>
    </div>
  </div>
</template>

<style scoped>
.compass {
  display: grid;
  place-items: center;
}

.compass__rose {
  position: relative;
  width: min(62vw, 240px);
  aspect-ratio: 1;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.05), transparent 48%),
    conic-gradient(
      from 0deg,
      rgba(255, 213, 107, 0.18),
      rgba(126, 213, 255, 0.14),
      rgba(185, 142, 255, 0.16),
      rgba(255, 156, 115, 0.18),
      rgba(255, 213, 107, 0.18)
    );
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.compass__rose::after {
  content: '';
  position: absolute;
  inset: 22px;
  border-radius: 50%;
  background: rgba(10, 10, 20, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.compass__pointer {
  position: absolute;
  top: 6px;
  left: 50%;
  width: 0;
  height: 0;
  border-left: 7px solid transparent;
  border-right: 7px solid transparent;
  border-top: 14px solid var(--accent-coral, #ff9c73);
  transform: translateX(-50%);
  z-index: 3;
  filter: drop-shadow(0 0 8px rgba(255, 156, 115, 0.5));
}

.compass__ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  transition: transform 120ms ease-out;
}

.compass__tick {
  position: absolute;
  top: 3px;
  left: 50%;
  width: 1px;
  height: 10px;
  background: rgba(255, 255, 255, 0.2);
  transform-origin: 50% calc(min(31vw, 120px) - 3px);
}

.compass__tick--major {
  width: 2px;
  height: 14px;
  background: rgba(255, 213, 107, 0.6);
}

.compass__cardinal {
  position: absolute;
  top: 18px;
  left: 50%;
  width: 0;
  display: flex;
  justify-content: center;
  transform-origin: 50% calc(min(31vw, 120px) - 18px);
  font-size: 0.72rem;
  color: var(--text-soft, rgba(244, 239, 255, 0.72));
  letter-spacing: 0.06em;
  z-index: 1;
}

.compass__cardinal--primary {
  font-size: 0.82rem;
  font-weight: 700;
  color: rgba(255, 213, 107, 0.92);
}

.compass__cardinal > span {
  display: block;
  transform-origin: center center;
}

.compass__readout {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  place-content: center;
  gap: 0.15rem;
  z-index: 2;
  text-align: center;
}

.compass__readout strong {
  font-size: 1.8rem;
  line-height: 1;
}

.compass__readout small {
  color: var(--text-soft, rgba(244, 239, 255, 0.72));
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.8rem;
}
</style>

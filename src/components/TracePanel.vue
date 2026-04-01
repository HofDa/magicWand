<script setup>
import { computed } from 'vue'

const props = defineProps({
  fields: {
    type: Array,
    required: true
  },
  samples: {
    type: Array,
    required: true
  },
  title: {
    type: String,
    required: true
  }
})

function readPath(source, path) {
  return path.split('.').reduce((value, segment) => value?.[segment], source)
}

const lines = computed(() => {
  if (!props.samples.length) {
    return []
  }

  return props.fields.map((field) => {
    const points = props.samples
      .map((sample, index) => {
        const rawValue = readPath(sample, field.path)
        const normalized = Math.max(-1, Math.min(1, (rawValue ?? 0) / field.scale))
        const x = props.samples.length === 1 ? 50 : (index / (props.samples.length - 1)) * 100
        const y = 50 - normalized * 42
        return `${x},${y}`
      })
      .join(' ')

    return {
      ...field,
      points
    }
  })
})
</script>

<template>
  <section class="trace-panel">
    <header class="trace-panel__header">
      <p>{{ title }}</p>
    </header>
    <svg viewBox="0 0 100 100" class="trace-panel__chart" preserveAspectRatio="none">
      <line x1="0" y1="50" x2="100" y2="50" class="trace-panel__baseline" />
      <polyline
        v-for="line in lines"
        :key="line.label"
        :points="line.points"
        :stroke="line.color"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2.2"
      />
    </svg>
    <div class="trace-panel__legend">
      <span v-for="line in fields" :key="line.label">
        <i :style="{ background: line.color }"></i>{{ line.label }}
      </span>
    </div>
  </section>
</template>


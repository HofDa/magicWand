<script setup>
defineProps({
  items: {
    type: Array,
    required: true
  },
  title: {
    type: String,
    required: true
  }
})

function safeValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
</script>

<template>
  <section class="vector-panel">
    <header class="vector-panel__header">
      <p>{{ title }}</p>
    </header>
    <div v-for="item in items" :key="item.label" class="vector-row">
      <span class="vector-row__label">{{ item.label }}</span>
      <div class="vector-row__track">
        <span class="vector-row__zero"></span>
        <span
          class="vector-row__fill"
          :style="{
            background: item.color,
            left: `${safeValue(item.value) >= 0 ? 50 : 50 + (safeValue(item.value) / item.scale) * 50}%`,
            width: `${Math.min(50, Math.abs((safeValue(item.value) / item.scale) * 50))}%`
          }"
        ></span>
      </div>
      <span class="vector-row__value">
        {{ safeValue(item.value).toFixed(1) }}{{ item.unit ?? '' }}
      </span>
    </div>
  </section>
</template>


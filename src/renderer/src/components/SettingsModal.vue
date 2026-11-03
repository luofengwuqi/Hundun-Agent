<script setup>
import { ref, reactive } from 'vue'

const props = defineProps({ cfg: { type: Object, required: true } })
const emit = defineEmits(['save', 'close'])

const form = reactive({
  baseUrl: props.cfg.baseUrl || '',
  apiKey: props.cfg.apiKey || '',
  model: props.cfg.model || '',
  temperature: props.cfg.temperature ?? 0.7,
  contextWindow: props.cfg.contextWindow || 32000,
  checkpoints: (props.cfg.checkpoints || []).map((c) => ({ ...c }))
})

const testing = ref(false)
const status = ref('')
const statusKind = ref('')

async function test() {
  testing.value = true
  status.value = '正在连…'
  statusKind.value = ''
  const r = await window.hundun.cfg.test({
    baseUrl: form.baseUrl,
    apiKey: form.apiKey,
    model: form.model
  })
  testing.value = false
  if (r.ok) {
    status.value = '连上了，它回了：' + r.reply
    statusKind.value = 'ok'
  } else {
    status.value = r.error
    statusKind.value = 'bad'
  }
}

function save() {
  emit('save', {
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey.trim(),
    model: form.model.trim(),
    temperature: Number(form.temperature) || 0.7,
    contextWindow: Number(form.contextWindow) || 32000,
    checkpoints: form.checkpoints
  })
}

function openDir() {
  window.hundun.life.open()
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="modal">
      <h2>设置</h2>
      <p class="sub">记忆全部存在本机，只有对话内容会发给你选的模型。</p>

      <div class="field">
        <label>接口地址</label>
        <input v-model="form.baseUrl" placeholder="https://api.deepseek.com/v1" />
        <div class="tip">任何 OpenAI 兼容地址都行，末尾加不加 /v1 都可以</div>
      </div>

      <div class="field">
        <label>API Key</label>
        <input v-model="form.apiKey" type="password" placeholder="sk-..." spellcheck="false" />
        <div class="tip">只存本机 ~/.config/HundunAgent/config.json，不上传</div>
      </div>

      <div class="row2">
        <div class="field">
          <label>模型</label>
          <input v-model="form.model" placeholder="deepseek-chat" />
        </div>
        <div class="field">
          <label>上下文窗口（token）</label>
          <input v-model="form.contextWindow" type="number" min="4000" step="1000" />
        </div>
      </div>

      <div class="field">
        <label>检查点（它主动找你）</label>
        <div v-for="cp in form.checkpoints" :key="cp.id" class="cp-row">
          <input type="checkbox" v-model="cp.enabled" />
          <span>{{ cp.label }}</span>
          <input type="time" v-model="cp.time" />
        </div>
        <div class="tip">静音日（顶部「今天别烦我」）会跳过全部检查点</div>
      </div>

      <div class="field">
        <label>记忆目录</label>
        <div class="cp-row">
          <span style="width: auto">~/life</span>
          <button class="mini" @click="openDir">打开</button>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn" :disabled="testing" @click="test">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <span class="status" :class="statusKind">{{ status }}</span>
        <div class="spacer" />
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

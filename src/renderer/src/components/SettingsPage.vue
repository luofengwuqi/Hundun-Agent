<script setup>
/**
 * 设置页（D072）。原来是个弹窗，一屏塞六个输入框 —— 模型配置一旦不是「填两个字符串」，
 * 弹窗就装不下了。现在它和「对话」「打扰」并列，是自己的一列。
 *
 * 模型这块照 opencode 的格式来：一份 JSON 说清有哪些 provider、各自有哪些模型、
 * 现在用哪个。**JSON 是唯一的源**，写进去之后 baseUrl／apiKey／model 都由它算出来。
 */
import { ref, computed, onMounted, watch } from 'vue'

const props = defineProps({ cfg: { type: Object, required: true } })
const emit = defineEmits(['saved'])

/* ---------------- 模型 ---------------- */

const text = ref('')
const preview = ref(null) // { ok, errors, warnings, providers, selected }
const imported = ref('')
const applying = ref(false)
const applyMsg = ref('')
const applyKind = ref('')

/** 已保存的那份（老配置没有，用 store 生成的 seed 顶上） */
const savedJson = computed(() => props.cfg.modelConfig || props.cfg.modelSeed || null)
const savedText = computed(() => (savedJson.value ? JSON.stringify(savedJson.value, null, 2) : ''))
const dirty = computed(() => text.value.trim() !== savedText.value.trim())

text.value = savedText.value

let timer = null
watch(text, () => {
  clearTimeout(timer)
  // 每敲一个字都解析一遍太吵，但延迟不能长：他改完地址就想去点测试
  timer = setTimeout(runPreview, 260)
})

async function runPreview() {
  if (!text.value.trim()) {
    preview.value = null
    return
  }
  preview.value = await window.hundun.cfg.previewModel(text.value)
}

onMounted(runPreview)

const inUseText = computed(() => {
  if (props.cfg.modelBroken) return '配置坏了'
  if (!props.cfg.model) return '还没选模型'
  return props.cfg.model
})

function fmtCtx(n) {
  if (!n) return ''
  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

/** 编辑器里现在指向的那个模型（未保存也算，他点了就该看见勾） */
function picked(pid, mid) {
  const s = preview.value?.selected
  return Boolean(s && s.providerId === pid && s.modelId === mid)
}

async function importFile() {
  const r = await window.hundun.cfg.pickModelFile()
  if (!r || r.canceled) return
  if (!r.ok) {
    applyMsg.value = r.error
    applyKind.value = 'bad'
    return
  }
  text.value = r.text
  imported.value = r.name
  applyMsg.value = ''
  applyKind.value = ''
  await runPreview()
}

function formatJson() {
  try {
    text.value = JSON.stringify(JSON.parse(text.value), null, 2)
    imported.value = ''
  } catch (e) {
    applyMsg.value = 'JSON 语法错误：' + e.message
    applyKind.value = 'bad'
  }
}

async function apply() {
  applying.value = true
  applyMsg.value = ''
  applyKind.value = ''
  const r = await window.hundun.cfg.applyModel(text.value)
  applying.value = false
  if (!r.ok) {
    applyMsg.value = (r.errors || ['应用失败']).join('；')
    applyKind.value = 'bad'
    return
  }
  preview.value = { ...(preview.value || {}), warnings: r.warnings || [] }
  const n = (r.warnings || []).length
  applyMsg.value = n ? `已应用，有 ${n} 条提醒` : '已应用'
  applyKind.value = n ? 'warn' : 'ok'
  if (r.cfg) emit('saved', r.cfg)
}

/** 点一个模型＝改顶层 model 再应用。不做「先记住再让他点保存」—— 点了就是要用这个。 */
async function pickModel(pid, mid) {
  let obj
  try {
    obj = JSON.parse(text.value)
  } catch {
    return
  }
  obj.model = pid + '/' + mid
  text.value = JSON.stringify(obj, null, 2)
  await runPreview()
  if (preview.value?.ok) await apply()
}

/* ---------------- 测试连接 ---------------- */

const testing = ref(false)
const testMsg = ref('')
const testKind = ref('')

async function test() {
  const s = preview.value?.selected
  if (!s) {
    testMsg.value = '先把配置写对，才有东西可测'
    testKind.value = 'bad'
    return
  }
  testing.value = true
  testMsg.value = '正在连…'
  testKind.value = ''
  const r = await window.hundun.cfg.test({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.modelId })
  testing.value = false
  if (r.ok) {
    testMsg.value = '连上了，它回了：' + r.reply
    testKind.value = 'ok'
  } else {
    testMsg.value = r.error
    testKind.value = 'bad'
  }
}

/* ---------------- 其它参数 ---------------- */

const temperature = ref(props.cfg.temperature ?? 0.7)
const contextWindow = ref(props.cfg.contextWindow ?? 32000)

/** 上下文窗口谁说了算：模型配置里写了 limit.context 就听它的，没写才听这个输入框 */
const ctxFromModel = computed(() => {
  const s = preview.value?.selected
  return Boolean(s && s.contextWindow > 0)
})

const ctxHint = computed(() =>
  ctxFromModel.value
    ? '这个值由模型配置里的 limit.context 决定，在这儿改了，下次应用模型配置会被覆盖'
    : '模型配置里没写 limit.context，用的就是这个值'
)

async function saveCfg(patch) {
  const r = await window.hundun.cfg.set(patch)
  if (r && r.ok && r.cfg) emit('saved', r.cfg)
  return r
}

async function setTemp(e) {
  const v = Math.max(0, Math.min(2, Number(e.target.value) || 0))
  temperature.value = v
  e.target.value = v
  await saveCfg({ temperature: v })
}

async function setCtx(e) {
  const v = Math.max(4000, Number(e.target.value) || 32000)
  contextWindow.value = v
  e.target.value = v
  await saveCfg({ contextWindow: v })
}

/* ---------------- 记忆 / 关于 ---------------- */

const info = ref({})
const reindexing = ref(false)
const reindexMsg = ref('')

onMounted(async () => {
  try {
    info.value = await window.hundun.info()
  } catch {}
})

async function openLife() {
  window.hundun.life.open()
}

async function reindex() {
  reindexing.value = true
  reindexMsg.value = ''
  const r = await window.hundun.life.reindex()
  reindexing.value = false
  reindexMsg.value = r && r.ok === false ? r.error || '重建失败' : `重建完成，索引 ${r}` + ' 条'
}

const dirLabel = computed(() => {
  const p = info.value.lifeDir || ''
  if (!p) return '当前身份目录'
  const parts = p.split(/[\\/]/).filter(Boolean)
  return '…/' + parts.slice(-4).join('/')
})
</script>

<template>
  <section class="set-col">
    <div class="set-wrap">
      <header class="set-head">
        <h1>设置</h1>
        <p class="set-sub">记忆全在本机，只有对话内容会发给你选的模型。</p>
      </header>

      <!-- ============ 模型 ============ -->
      <section class="set-block">
        <div class="set-title">
          <h2>模型</h2>
          <span class="set-badge" :class="{ bad: props.cfg.modelBroken || !props.cfg.hasApiKey }">
            {{ inUseText }}
          </span>
        </div>
        <p class="set-note">
          格式照 opencode：<code>provider</code> 里写有哪些服务商和模型，顶层 <code>model</code> 用
          <code>provider/模型</code> 指定现在用哪个。key 可以写成 <code>{env:变量名}</code> 或
          <code>{file:路径}</code>，那样它不会进配置文件。
        </p>

        <div class="json-box">
          <div class="json-bar">
            <button class="mini" @click="importFile">从文件导入</button>
            <button class="mini" :disabled="!preview || !preview.ok" @click="formatJson">格式化</button>
            <span v-if="imported" class="json-file">{{ imported }}</span>
            <span class="json-spacer" />
            <span v-if="dirty" class="json-dirty">未应用</span>
            <button class="btn primary sm" :disabled="applying || !dirty" @click="apply">
              {{ applying ? '应用中…' : '应用' }}
            </button>
          </div>
          <textarea v-model="text" class="json-edit" spellcheck="false" autocomplete="off" />
        </div>

        <!-- 解析结果 -->
        <div v-if="preview" class="preview">
          <div v-if="preview.errors?.length" class="pline bad">
            <span class="pmark">×</span>
            <div>
              <div v-for="(e, i) in preview.errors" :key="'e' + i">{{ e }}</div>
            </div>
          </div>
          <div v-if="preview.warnings?.length" class="pline warn">
            <span class="pmark">!</span>
            <div>
              <div v-for="(w, i) in preview.warnings" :key="'w' + i">{{ w }}</div>
            </div>
          </div>

          <div v-if="preview.providers?.length" class="prov-list">
            <div v-for="p in preview.providers" :key="p.id" class="prov">
              <div class="prov-head">
                <span class="prov-name">{{ p.name }}</span>
                <span class="prov-id">{{ p.id }}</span>
                <span v-if="!p.hasKey" class="prov-tag">无 key</span>
              </div>
              <div class="prov-url">{{ p.baseUrl }}</div>
              <div class="model-list">
                <button
                  v-for="m in p.models"
                  :key="m.id"
                  class="model-row"
                  :class="{ on: picked(p.id, m.id) }"
                  :disabled="!preview.ok"
                  @click="pickModel(p.id, m.id)"
                >
                  <span class="model-tick" />
                  <span class="model-name">{{ m.name }}</span>
                  <span class="model-id">{{ m.id }}</span>
                  <span v-if="m.context" class="model-ctx">{{ fmtCtx(m.context) }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="act-row">
          <button class="btn sm" :disabled="testing" @click="test">
            {{ testing ? '测试中…' : '测试连接' }}
          </button>
          <span class="status" :class="testKind">{{ testMsg }}</span>
        </div>
        <div v-if="applyMsg" class="act-row">
          <span class="status" :class="applyKind">{{ applyMsg }}</span>
        </div>
      </section>

      <!-- ============ 对话 ============ -->
      <section class="set-block">
        <h2>对话</h2>
        <div class="cfg-row">
          <div class="cfg-label">
            <span>温度</span>
            <small>越高越跳，越低越稳。</small>
          </div>
          <input
            class="cfg-num"
            type="number"
            min="0"
            max="2"
            step="0.1"
            :value="temperature"
            @change="setTemp"
          />
        </div>
        <div class="cfg-row">
          <div class="cfg-label">
            <span>上下文窗口</span>
            <small>{{ ctxHint }}</small>
          </div>
          <input
            class="cfg-num"
            type="number"
            min="4000"
            step="1000"
            :value="contextWindow"
            @change="setCtx"
          />
        </div>
      </section>

      <!-- ============ 记忆 ============ -->
      <section class="set-block">
        <h2>记忆</h2>
        <div class="cfg-row">
          <div class="cfg-label">
            <span>当前身份目录</span>
            <small :title="info.lifeDir">{{ dirLabel }}</small>
          </div>
          <div class="cfg-act">
            <button class="mini" @click="openLife">打开</button>
          </div>
        </div>
        <div class="cfg-row">
          <div class="cfg-label">
            <span>检索索引</span>
            <small>改了记忆文件之后，让它重新读一遍</small>
          </div>
          <div class="cfg-act">
            <button class="mini" :disabled="reindexing" @click="reindex">
              {{ reindexing ? '重建中…' : '重建' }}
            </button>
            <span v-if="reindexMsg" class="status ok">{{ reindexMsg }}</span>
          </div>
        </div>
      </section>

      <!-- ============ 关于 ============ -->
      <section class="set-block last">
        <h2>关于</h2>
        <div class="about">
          <span>馄饨 Agent {{ info.version || '' }}</span>
          <span class="dot">·</span>
          <span>Electron {{ info.electron || '?' }}</span>
          <span class="dot">·</span>
          <span>Node {{ info.node || '?' }}</span>
        </div>
      </section>
    </div>
  </section>
</template>

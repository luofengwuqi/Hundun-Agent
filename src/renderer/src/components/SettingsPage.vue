<script setup>
/**
 * 设置页（D072）。原来是个弹窗，一屏塞六个输入框 —— 模型配置一旦不是「填两个字符串」，
 * 弹窗就装不下了。现在它和「对话」「打扰」并列，是自己的一列。
 *
 * 模型这块照 opencode 的格式来：一份 JSON 说清有哪些 provider、各自有哪些模型、
 * 现在用哪个。**JSON 是唯一的源**，写进去之后 baseUrl／apiKey／model 都由它算出来。
 *
 * 但格式是给机器看的，第一句话是给人说的（D077）：所以上面多一栏「简单」——
 * 选一家、选一个、填个 key，完事。它不落成另一份配置，而是现场生成同一份 JSON，
 * 所以下面那栏里能看见它写成了什么，「直接写 JSON」也没被拿走。
 */
import { ref, computed, onMounted, watch } from 'vue'

// logo 的唯一源是 build/logo.svg，构建时原样拷到 out/renderer/。
// 字面量 './logo.svg' 会被 esbuild 当模块依赖去解析（找不到就报错），所以走变量。
// 位置必须在 import 之后：插在 import 前面，hoist 会让 const 排到顶部，ESM 语法报错。
const LOGO = './logo.svg'

const props = defineProps({ cfg: { type: Object, required: true } })
const emit = defineEmits(['saved'])

/* ---------------- 简单模式（D077） ---------------- */

const presets = ref([])
const simple = ref({ preset: '', baseUrl: '', apiKey: '', model: '' })
const sMsg = ref('')
const sKind = ref('')
const sBusy = ref(false)
/** 他手填的模型名不在目录里时，多出来一个输入框 */
const sCustomModel = ref('')
/** 哪一栏：认得出目录就是简单，认不出（手写的 JSON、多 provider）就直接给他 JSON */
const view = ref(props.cfg.modelSimple ? 'simple' : 'json')
/** 配好之后表单是收起来的 —— 每天要看的是「在用什么」，不是六个输入框 */
const editing = ref(false)

/**
 * 去服务商后台拿 key。
 *
 * 走主进程的 shell.openExternal 而不是 <a href>：渲染进程只是个浏览器，
 * 直接开外链会在应用窗口里把界面整个换掉，而且回不来。
 */
function openKey(url) {
  if (url) window.hundun.openExternal(url)
}

const curPreset = computed(() => presets.value.find((p) => p.id === simple.value.preset) || null)

/** 目录里的模型 + 他可能手填的那个。手填的那个单独标出来，不然它会在列表里凭空消失 */
const sModels = computed(() => {
  const p = curPreset.value
  if (!p) return []
  const list = p.models.map((m) => ({ id: m.id, name: m.name, extra: false }))
  const cur = String(simple.value.model || '').trim()
  if (cur && !list.some((m) => m.id === cur)) list.push({ id: cur, name: cur, extra: true })
  return list
})

const sNeedsKey = computed(() => !curPreset.value?.noKey && !curPreset.value?.custom)

function loadPresets() {
  const c = props.cfg.modelSimple
  if (!c) return
  simple.value = { ...simple.value, ...c }
  // 还没配过就先给他看「都有哪几家」。默认停在 DeepSeek 表单上，等于替他已经选了
  if (!props.cfg.hasApiKey && !c.apiKey) simple.value.preset = ''
  // 存的是「目录外的那个模型名」时，把它放进手填框，免得他以为丢了
  const p = presets.value.find((x) => x.id === simple.value.preset)
  if (p && c.model && !p.custom && !p.models.some((m) => m.id === c.model)) sCustomModel.value = c.model
}

onMounted(async () => {
  try {
    presets.value = await window.hundun.cfg.presets()
  } catch {}
  // 目录回来之后再过一遍：目录外的模型名要认出来得先有目录
  loadPresets()
})

/**
 * 选服务商 = 一次真正的切换，不是「改了还没存」。
 * 换一家还留着一个用不了的模型名和别人的 key，下次打开会是个说不清的半成品；
 * 而切走再切回来想把 key 找回来 —— 那种期待不该靠界面上的一行字符串来满足。
 */
async function pickPreset(p) {
  const before = { ...simple.value }
  const key = before.preset === p.id ? before.apiKey : ''
  simple.value = {
    preset: p.id,
    baseUrl: p.custom ? before.baseUrl || '' : '',
    apiKey: key,
    model: p.models[0]?.id || (p.custom ? String(before.model || '') : '')
  }
  if (p.custom) sCustomModel.value = before.model || ''
  sMsg.value = ''
  sKind.value = ''
  // 换一家 = 现在就存，不给「改了还没应用」留半截状态。缺 key 的那几家先别存，等填完再说
  if (p.noKey || String(key).trim()) await saveModel()
  else editing.value = true
}

/** 只改当前用的那个：目录、地址都不动，所以走「只换 key」那条更窄的路 */
async function saveModel() {
  const p = curPreset.value
  if (!p) return
  const model = String(simple.value.model || '').trim() || (p.models[0]?.id ?? '')
  if (sNeedsKey.value && !String(simple.value.apiKey || '').trim()) {
    sMsg.value = '先填 API Key'
    sKind.value = 'bad'
    return
  }
  if (p.custom && !String(simple.value.baseUrl || '').trim()) {
    sMsg.value = '自定义服务商要填接口地址'
    sKind.value = 'bad'
    return
  }
  sBusy.value = true
  sMsg.value = ''
  const r = await window.hundun.cfg.applySimple({ ...simple.value, model })
  sBusy.value = false
  if (!r.ok) {
    sMsg.value = (r.errors || ['没存上']).join('；')
    sKind.value = 'bad'
    return
  }
  simple.value.model = model
  sMsg.value = '已保存'
  sKind.value = 'ok'
  if (r.cfg) emit('saved', r.cfg)
}

/** 换 key 不动模型：唯一的理由是不该因为改个 key 就把备用链的顺序冲掉 */
async function saveKey() {
  sBusy.value = true
  const r = await window.hundun.cfg.setKey(simple.value.apiKey)
  sBusy.value = false
  if (!r.ok) {
    sMsg.value = (r.errors || ['没存上']).join('；')
    sKind.value = 'bad'
    return
  }
  sMsg.value = '已保存'
  sKind.value = 'ok'
  if (r.cfg) emit('saved', r.cfg)
}

/** 手填模型名：加进目录之外的那一格，然后照常保存 */
function useTypedModel() {
  const v = String(sCustomModel.value || '').trim()
  if (!v) return
  simple.value.model = v
  saveModel()
}

/** 已经配好、而且默认在简单栏：这时候它是一张卡片，不是一堆下拉框 */
/** 已经配好、而且认得出是简单配置：这时候它是一张卡片，不是一堆下拉框 */
const showCard = computed(
  () => Boolean(curPreset.value) && Boolean(props.cfg.hasApiKey) && !props.cfg.modelBroken
)
/** JSON 里带了备用模型或改了排序：简单栏只画第一个，装不下这个事实，得说出来 */
const multiInJson = computed(() => (props.cfg.modelChain || []).length > 1)

/* ---------------- 模型（直接写 JSON） ---------------- */

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

/**
 * 角标跟着**编辑器里那份**走，不跟已保存的走。
 *
 * 它和下面第一张卡片必须说同一句话：他刚点了「先用」，卡片已经换成 R1 了，
 * 角标还挂着 Chat，那到底是哪个在用？—— 这种不一致没法靠用户在界面上自己解释。
 * 「改了还没生效」这件事用后缀说，不用两个不同的名字说。
 */
const inUseText = computed(() => {
  if (props.cfg.modelBroken) return '配置坏了'
  // 用显示名而不是 model id：卡片上写「DeepSeek Chat」，角标写「deepseek-chat」
  // 会让人以为这是两个东西。
  const first = preview.value?.chain?.[0]
  if (first) return first.modelName
  const saved = props.cfg.modelChain && props.cfg.modelChain[0]
  if (saved) return saved.modelName
  if (!props.cfg.model) return '还没选模型'
  return props.cfg.model
})

const badgeText = computed(() => inUseText.value + (dirty.value ? ' · 未应用' : ''))

function fmtCtx(n) {
  if (!n) return ''
  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

/**
 * 按顺序试的那条链。第一张就是现在用的，后面的都是备用。
 * 用 preview 而不是 props.cfg：手改 JSON 还没应用时，卡片也要跟着变，
 * 否则改完上面、下面的卡片还是旧的，人就不知道哪个是真的。
 */
const chain = computed(() => preview.value?.chain || [])
const providers = computed(() => preview.value?.providers || [])
const editable = computed(() => Boolean(preview.value?.ok))

/** 还没进链的模型，按 provider 分组 —— 就是「+ 添加模型」里能点的那些 */
const candidates = computed(() => {
  const used = new Set(chain.value.map((m) => m.providerId + '/' + m.modelId))
  const out = []
  for (const p of providers.value) {
    const rest = p.models.filter((m) => !used.has(p.id + '/' + m.id))
    if (rest.length) out.push({ id: p.id, name: p.name, models: rest })
  }
  return out
})

const refOf = (m) => m.providerId + '/' + m.modelId

/**
 * 卡片的每个动作都走这里：改对象 → 写回编辑器 → 预览 → 应用。
 *
 * 改的是编辑器里那份文本，不是磁盘上那份。这样「改了一半的 JSON」不会被
 * 点一下卡片就悄悄覆盖掉；反过来，卡片操作也不会因为草稿没应用而改了没反应。
 */
async function editChain(op, ref, extra) {
  let obj
  try {
    obj = JSON.parse(text.value)
  } catch {
    editMsg.value = 'JSON 有语法错误，先把编辑器里的改对'
    editKind.value = 'bad'
    return
  }
  const r = await window.hundun.cfg.editModel({ config: obj, op, ref, ...(extra || {}) })
  if (!r.ok) {
    editMsg.value = r.error || '改不动'
    editKind.value = 'bad'
    return
  }
  editMsg.value = ''
  text.value = JSON.stringify(r.config, null, 2)
  await runPreview()
  if (preview.value?.ok) await apply(true)
}

const editMsg = ref('')
const editKind = ref('')

/**
 * 单独测一个模型。
 *
 * 底下那个「测试连接」只测首选 —— 而备用模型最容易出的问题是「配了但从没通过」：
 * 等主模型真挂了才发现备用也不通，那就等于根本没有备用。
 * 结果按 ref 记在卡片上，不弹窗：他要的是「这四张里哪张是通的」一眼看到。
 */
const tested = ref({})

async function testOne(m) {
  const r = refOf(m)
  tested.value = { ...tested.value, [r]: { state: 'run' } }
  const res = await window.hundun.cfg.test({
    baseUrl: m.baseUrl,
    apiKey: m.apiKey,
    model: m.modelId
  })
  tested.value = {
    ...tested.value,
    [r]: res.ok ? { state: 'ok' } : { state: 'bad', detail: res.error }
  }
}

const setHead = (m) => editChain('move', refOf(m), { to: 0 })
const moveUp = (m, i) => editChain('move', refOf(m), { to: i - 1 })
const moveDown = (m, i) => editChain('move', refOf(m), { to: i + 1 })
const drop = (m) => editChain('remove', refOf(m))
const addOne = (p, m) => {
  adding.value = false
  editChain('add', p.id + '/' + m.id)
}

/* ---- 拖拽排序 ---- */

const dragFrom = ref(-1)
const dragOver = ref(-1)

function onDragStart(i, e) {
  dragFrom.value = i
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    // Firefox 不 setData 就根本不开始拖
    e.dataTransfer.setData('text/plain', String(i))
  }
}

function onDrop(i) {
  const from = dragFrom.value
  dragFrom.value = -1
  dragOver.value = -1
  if (from < 0 || from === i) return
  const m = chain.value[from]
  if (m) editChain('move', refOf(m), { to: i })
}

/* ---- 编辑器 ---- */

const showJson = ref(false)
const adding = ref(false)

/** 在最底下用一句人话说清那份 JSON 里现在是什么，不然「没了吗」得自己去下面找 */
const jsonSummary = computed(() => {
  const c = chain.value
  if (!c.length) return ''
  return c.length === 1 ? '现在是一份没改过的简单配置' : `JSON 里排了 ${c.length} 个模型，前${c.length - 1}个是备用`
})

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

async function apply(silent = false) {
  applying.value = true
  if (!silent) {
    applyMsg.value = ''
    applyKind.value = ''
  }
  const r = await window.hundun.cfg.applyModel(text.value)
  applying.value = false
  if (!r.ok) {
    applyMsg.value = (r.errors || ['应用失败']).join('；')
    applyKind.value = 'bad'
    return
  }
  preview.value = { ...(preview.value || {}), warnings: r.warnings || [] }
  const n = (r.warnings || []).length
  // 卡片上点一下不该弹一句「已应用」：那是他刚做的事，重复一遍只会让界面吵。
  if (!silent) {
    applyMsg.value = n ? `已应用，有 ${n} 条提醒` : '已应用'
    applyKind.value = n ? 'warn' : 'ok'
  }
  if (r.cfg) emit('saved', r.cfg)
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

async function openRules() {
  window.hundun.life.openRules()
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
          <span
            class="set-badge"
            :class="{ bad: props.cfg.modelBroken || !props.cfg.hasApiKey, warn: dirty && view === 'json' }"
          >
            {{ badgeText }}
          </span>
        </div>

        <div class="switch">
          <button :class="{ on: view === 'simple' }" @click="view = 'simple'">简单</button>
          <button :class="{ on: view === 'json' }" @click="view = 'json'">直接写 JSON</button>        </div>

        <!-- ================= 简单 ================= -->
        <div v-if="view === 'simple'" class="simple">
          <p v-if="!showCard" class="set-note">
            选一个模型服务商，把它的 API Key 填进来就能用了。想配好几个、排备用顺序，切到「直接写
            JSON」。
          </p>

          <!-- 还没选服务商：一排按钮 -->
          <div v-if="!simple.preset" class="sgrid">
            <button v-for="p in presets" :key="p.id" class="sprov" @click="pickPreset(p)">
              <span class="sprov-name">{{ p.name }}</span>
              <span class="sprov-meta">{{ p.custom ? '自己填地址' : p.noKey ? '不用 key' : p.models.length + ' 个模型' }}</span>
            </button>
          </div>

          <template v-else>
            <!-- 已经配好的样子：一张卡，不是一堆输入框 -->
            <div v-if="showCard" class="mcard head">
              <span class="mrank">1</span>
              <div class="mmain">
                <div class="mline">
                  <span class="mname">{{ curPreset.name }}</span>
                  <span class="mtag">先用这个</span>
                </div>
                <div class="msub">
                  {{ sModels.find((m) => m.id === simple.model)?.name || simple.model }}
                  <span v-if="simple.model && simple.model !== (sModels.find((m) => m.id === simple.model)?.name || '')">
                    · {{ simple.model }}</span
                  >
                </div>
                <div class="murl">{{ props.cfg.baseUrl }}</div>
              </div>
              <div class="mops" style="opacity: 1">
                <button class="mop" @click="simple.preset = ''">换一家</button>
              </div>
            </div>

            <!-- 要改的地方：只在没配好，或者他点了「改」时出现 -->
            <div v-if="!showCard || editing" class="sform">
              <div class="cfg-row">
                <div class="cfg-label">
                  <span>服务商</span>
                  <small v-if="curPreset.custom">任何说 OpenAI 兼容接口的服务，地址里一般带 /v1</small>
                  <small v-else>{{ curPreset.name }}</small>
                </div>
                <button class="mini" @click="simple.preset = ''">换一家</button>
              </div>

              <div v-if="curPreset.custom" class="cfg-row">
                <div class="cfg-label">
                  <span>接口地址</span>
                  <small>形如 https://api.example.com/v1</small>
                </div>
                <input v-model.trim="simple.baseUrl" class="cfg-text" placeholder="https://" spellcheck="false" />
              </div>

              <div v-if="sNeedsKey || curPreset.custom" class="cfg-row">
                <div class="cfg-label">
                  <span>API Key</span>
                  <small>
                    <a v-if="curPreset.keyUrl" class="slink" @click.prevent="openKey(curPreset.keyUrl)">
                      去 {{ curPreset.name }} 拿一个
                    </a>
                    <span v-else>存在本机 config.json，权限 600，不会发到别处</span>
                  </small>
                </div>
                <input
                  v-model.trim="simple.apiKey"
                  class="cfg-text"
                  type="password"
                  spellcheck="false"
                  autocomplete="off"
                  placeholder="sk-…"
                />
              </div>

              <div class="cfg-row">
                <div class="cfg-label">
                  <span>用哪个模型</span>
                  <small>排在前面的通常更聪明，也通常更贵</small>
                </div>
                <div class="smodels">
                  <button
                    v-for="m in sModels"
                    :key="m.id"
                    class="smodel"
                    :class="{ on: simple.model === m.id }"
                    @click="simple.model = m.id"
                  >
                    <span class="smodel-name">{{ m.name }}</span>
                    <span v-if="m.extra" class="smodel-tag">自己填的</span>
                  </button>
                </div>
              </div>

              <div class="cfg-row">
                <div class="cfg-label">
                  <span>目录里没有</span>
                  <small>它们新发的模型，直接填名字用</small>
                </div>
                <div class="sadd">
                  <input
                    v-model.trim="sCustomModel"
                    class="cfg-text"
                    spellcheck="false"
                    :placeholder="curPreset.models[0]?.id || '模型名'"
                    @keydown.enter.prevent="useTypedModel"
                  />
                  <button class="mini" :disabled="!sCustomModel.trim() || sBusy" @click="useTypedModel">用这个</button>
                </div>
              </div>

              <div class="sact">
                <button v-if="!showCard" class="btn primary sm" :disabled="sBusy" @click="saveModel">
                  {{ sBusy ? '保存中…' : '就它了' }}
                </button>
                <button v-else class="btn primary sm" :disabled="sBusy" @click="saveKey">
                  {{ sBusy ? '保存中…' : '保存密钥' }}
                </button>
                <span v-if="sMsg" class="status" :class="sKind">{{ sMsg }}</span>
              </div>
            </div>

            <div v-else class="sact">
              <button class="mini" @click="editing = true">改密钥 / 换模型</button>
              <span class="json-spacer" />
              <span class="status" :class="testKind">{{ testMsg }}</span>
              <button class="btn sm" :disabled="testing" @click="test">{{ testing ? '测试中…' : '测试连接' }}</button>
            </div>

            <p v-if="multiInJson" class="chain-hint smulti">
              这份配置里排了 {{ chain.length }} 个模型、按顺序备用 —— 这里只显示第一个。改那边请去「直接写
              JSON」，这儿一存会把备用链换掉。
            </p>
          </template>
        </div>

        <!-- ================= JSON ================= -->
        <div v-else class="simple">
          <p class="set-note">
            排在前面的先用，连不上就换下一个。拖动卡片也能改顺序。key 写成
            <code>{env:变量名}</code> 或 <code>{file:路径}</code>，那样它不会进配置文件。
          </p>

          <!-- 解析结果：错误放最上面，因为下面的卡片全都建在它上面 -->
          <div v-if="preview && (preview.errors?.length || preview.warnings?.length)" class="preview">
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
          </div>

          <!-- 一条链：第一张是现在用的，后面按顺序备用 -->
          <div v-if="chain.length" class="mchain">
            <div
              v-for="(m, i) in chain"
              :key="refOf(m)"
              class="mcard"
              :class="{ head: i === 0, over: dragOver === i && dragFrom !== i }"
              draggable="true"
              @dragstart="onDragStart(i, $event)"
              @dragover.prevent="dragOver = i"
              @dragleave="dragOver = -1"
              @drop.prevent="onDrop(i)"
              @dragend="dragOver = -1"
            >
              <span class="mrank">{{ i + 1 }}</span>
              <div class="mmain">
                <div class="mline">
                  <span class="mname">{{ m.modelName }}</span>
                  <span v-if="i === 0" class="mtag">先用这个</span>
                  <span v-else class="mtag alt">备用</span>
                </div>
                <div class="msub">
                  {{ m.providerName }}<span v-if="m.modelId !== m.modelName"> · {{ m.modelId }}</span
                  ><span v-if="m.contextWindow"> · {{ fmtCtx(m.contextWindow) }}</span>
                  <span
                    v-if="tested[refOf(m)] && tested[refOf(m)].state !== 'run'"
                    class="mtest"
                    :class="tested[refOf(m)].state"
                    :title="tested[refOf(m)].detail || '连上了'"
                  >
                    {{ tested[refOf(m)].state === 'ok' ? '通' : '不通' }}
                  </span>
                </div>
                <div class="murl">{{ m.baseUrl }}</div>
              </div>
              <div class="mops">
                <button class="mop" title="只测这一个" @click="testOne(m)">
                  {{ tested[refOf(m)]?.state === 'run' ? '…' : '测' }}
                </button>
                <button v-if="i > 0" class="mop" title="设为先用" @click="setHead(m)">先用</button>
                <button v-if="i > 0" class="mop" title="上移" @click="moveUp(m, i)">↑</button>
                <button v-if="i < chain.length - 1" class="mop" title="下移" @click="moveDown(m, i)">
                  ↓
                </button>
                <button v-if="chain.length > 1" class="mop del" title="移出列表" @click="drop(m)">
                  ✕
                </button>
              </div>
            </div>
          </div>
          <p v-else-if="!preview || !preview.errors?.length" class="empty-chain">
            还没有模型。下面写一份 JSON，或者从文件导入。
          </p>

          <!-- 一份没动过的简单配置：不用再跟他解释一遍，想添备用的才点开 -->
          <div v-if="chain.length === 1" class="squiet">
            这是那份 JSON 生成的，平时不用看。
            <button class="mini" @click="showJson = true">展开看看</button>
          </div>

          <div v-else class="chain-foot">
            <button
              class="mini chain-toggle"
              :disabled="!editable || !candidates.length"
              @click="adding = !adding"
            >
              {{ adding ? '收起' : '+ 添加模型' }}
            </button>
            <span v-if="editable && !candidates.length" class="chain-hint">
              配置里的模型都已经在列表里了
            </span>
            <span v-if="editMsg" class="status" :class="editKind">{{ editMsg }}</span>
          </div>

          <!-- 候选：配置里有、但还没排进链的 -->
          <div v-if="adding && candidates.length" class="cand">
            <div v-for="p in candidates" :key="p.id" class="cand-group">
              <div class="cand-head">
                {{ p.name }} <span class="cand-id">{{ p.id }}</span>
              </div>
              <button v-for="m in p.models" :key="m.id" class="cand-row" @click="addOne(p, m)">
                <span class="cand-name">{{ m.name }}</span>
                <span class="cand-mid">{{ m.id }}</span>
                <span v-if="m.context" class="cand-ctx">{{ fmtCtx(m.context) }}</span>
                <span class="cand-plus">+</span>
              </button>
            </div>
          </div>

          <div class="act-row">
            <button class="mini" @click="importFile">从文件导入</button>
            <button v-if="chain.length > 1 || showJson" class="mini" @click="showJson = !showJson">
              {{ showJson ? '收起 JSON' : '编辑 JSON' }}
            </button>
            <span class="json-file" v-if="imported" :title="imported">{{ imported }}</span>
            <span class="json-spacer" />
            <span class="status" :class="testKind">{{ testMsg }}</span>
            <button class="btn sm" :disabled="testing" @click="test">
              {{ testing ? '测试中…' : '测试连接' }}
            </button>
          </div>

          <div v-if="showJson" class="json-box json-fold">
            <div class="json-bar">
              <button class="mini" :disabled="!preview || !preview.ok" @click="formatJson">格式化</button>
              <span class="json-spacer" />
              <button class="btn primary sm" :disabled="applying || !dirty" @click="apply()">
                {{ applying ? '应用中…' : '应用' }}
              </button>
            </div>
            <textarea v-model="text" class="json-edit" spellcheck="false" autocomplete="off" />
          </div>

          <div v-if="applyMsg" class="act-row">
            <span class="status" :class="applyKind">{{ applyMsg }}</span>
          </div>

          <p v-if="jsonSummary && chain.length > 1" class="chain-hint sjson-sum">{{ jsonSummary }}</p>
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
            <span>你自己写的规矩</span>
            <small>RULES.md，改完保存就生效，不用重启</small>
          </div>
          <div class="cfg-act">
            <button class="mini" @click="openRules">打开</button>
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
          <img class="about-mark" :src="LOGO" alt="馄饨" draggable="false" />
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

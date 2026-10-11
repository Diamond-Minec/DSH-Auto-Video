/**
 * dsh-plugin-auto-video — 宿主半边。
 *
 * 一段文案 → 一个 mp4：edge-tts 配音 + 精确对齐字幕 + 背景音乐 + 图片/视频拼接，
 * 全部本地用 ffmpeg 合成。**不依赖剪映**（剪映 6+ 草稿已加密，明文档稿它读不了）。
 *
 * 工程约束（沿用已验证的第三方插件实践）：
 *   · 只 import node 内置模块，运行时不硬依赖任何 @deepseek-ai/*
 *   · 不导出 Config（需要 schemastery，profile 里解析不到）
 *   · 一切注册放进 ctx.effect 并交出清理函数
 *
 * @module dsh-plugin-auto-video
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'auto-video'
export const inject = ['systemPrompt', 'webServer']

const PLUGIN_ID = 'auto-video'
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE_DIR = path.dirname(PLUGIN_DIR)
const BASE = '/autovideo/api'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'auto-video')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const SETUP_LOG = path.join(DATA_DIR, 'setup.log')

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v'])

/** 设置页里给普通人看的声音列表 */
export const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '女声 · 温柔自然（推荐）' },
  { id: 'zh-CN-XiaoyiNeural', label: '女声 · 活泼年轻' },
  { id: 'zh-CN-YunxiNeural', label: '男声 · 清亮年轻' },
  { id: 'zh-CN-YunjianNeural', label: '男声 · 沉稳解说' },
  { id: 'zh-CN-YunyangNeural', label: '男声 · 新闻播报' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '女声 · 东北口音' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '女声 · 陕西口音' },
]

/**
 * 交流群信息。二维码图片随插件出货（assets/qq-group.png），
 * 由 /qrcode 路由以同源方式提供给设置页 —— 浏览器读不了本地文件路径。
 * 换群只需改这里的三行 + 换掉那张图。
 */
export const QQ_GROUP = {
  name: 'DSH交流群？！？！',
  number: '1022445657',
  link: 'https://qm.qq.com/q/wGtYMp17S8',
  image: 'assets/qq-group.png',
}

/* ------------------------------------------------------------------ 日志 --- */

function makeLogger(ctx) {
  let sink = null
  try {
    const raw = ctx.logger
    sink = typeof raw === 'function' ? raw(PLUGIN_ID) : raw
  } catch {
    sink = null
  }
  return (level, message, err) => {
    const text = err ? `${message} — ${(err && err.message) || String(err)}` : message
    try {
      if (sink && typeof sink[level] === 'function') return sink[level](text)
      if (sink && typeof sink.info === 'function') return sink.info(text)
    } catch {
      /* 日志失败绝不能影响插件 */
    }
    if (level === 'error' || level === 'warn') console.error(`[${PLUGIN_ID}] ${text}`)
  }
}

/* ------------------------------------------------------------- 配置处理 --- */

function defaults() {
  return {
    venvDir: path.join(WORKSPACE_DIR, 'runtimes', 'jianying-venv'),
    outDir: path.join(DSH_HOME, 'autovideo-output'),
    voice: 'zh-CN-XiaoxiaoNeural',
    orientation: 'landscape',
    bgmVolume: 0.6,
    bgm: '',
    subtitleFontSize: 0,
    burnSubtitles: true,
    mediaDir: '',
    skillRoot: path.join(WORKSPACE_DIR, 'reference', 'jianying-editor-skill'),
  }
}

function dropEmpty(obj) {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  for (const [key, value] of Object.entries(obj)) {
    if (value === '' || value === null || value === undefined) continue
    out[key] = value
  }
  return out
}

function readConfigFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function mergeConfig(patchRaw) {
  return { ...defaults(), ...dropEmpty(patchRaw), ...dropEmpty(readConfigFile()) }
}

function normalizePatch(input) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const key of ['venvDir', 'outDir', 'voice', 'orientation', 'bgm', 'mediaDir', 'skillRoot']) {
    if (typeof input[key] === 'string') out[key] = input[key].trim()
  }
  if (input.bgmVolume !== undefined) {
    const num = Number(input.bgmVolume)
    if (Number.isFinite(num)) out.bgmVolume = Math.min(1, Math.max(0, num))
  }
  if (input.subtitleFontSize !== undefined) {
    const num = Number(input.subtitleFontSize)
    if (Number.isFinite(num) && num >= 0) out.subtitleFontSize = Math.round(num)
  }
  if (input.burnSubtitles !== undefined) out.burnSubtitles = !!input.burnSubtitles
  if (out.orientation && !['landscape', 'portrait'].includes(out.orientation)) out.orientation = 'landscape'
  return out
}

function writeConfigFile(patch) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfigFile(), ...patch }, null, 2), 'utf8')
}

/* --------------------------------------------------------------- 工具函数 --- */

function exists(target) {
  try {
    return !!target && fs.existsSync(target)
  } catch {
    return false
  }
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function resolvePython(cfg) {
  if (cfg.venvDir) {
    const venvPython = path.join(cfg.venvDir, 'Scripts', 'python.exe')
    if (exists(venvPython)) return { python: venvPython, isVenv: true, venvDir: cfg.venvDir }
  }
  return { python: 'python', isVenv: false, venvDir: cfg.venvDir || '' }
}

function detectBasePython(cfg) {
  const score = (p) => Number((path.basename(path.dirname(p)).match(/\d+/g) || []).join('') || 0)
  const found = []
  const local = process.env.LOCALAPPDATA || ''
  const programs = path.join(local, 'Programs', 'Python')
  if (isDir(programs)) {
    try {
      for (const entry of fs.readdirSync(programs)) {
        const candidate = path.join(programs, entry, 'python.exe')
        if (exists(candidate)) found.push(candidate)
      }
    } catch {
      /* ignore */
    }
  }
  found.push('C:\\Program Files\\python\\python.exe')
  const usable = found.filter(exists)
  if (cfg.basePython && exists(cfg.basePython)) return cfg.basePython
  if (usable.length) return usable.sort((a, b) => score(b) - score(a))[0]
  return 'python'
}

function runProcess(command, args, { cwd, env, timeoutMs = 900000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: cwd || WORKSPACE_DIR,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
      })
    } catch (err) {
      return resolve({ code: -1, stdout: '', stderr: String((err && err.message) || err) })
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish(-2)
    }, timeoutMs)
    child.stdout?.on('data', (b) => { stdout += b.toString('utf8') })
    child.stderr?.on('data', (b) => { stderr += b.toString('utf8') })
    child.on('error', (err) => { stderr += String((err && err.message) || err); finish(-1) })
    child.on('close', (code) => finish(code === null ? -1 : code))
  })
}

/** 扫素材文件夹，按文件名排序返回可用的图片/视频 */
function collectMediaFrom(dir, limit = 40) {
  if (!isDir(dir)) return []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)) files.push(path.join(dir, entry.name))
  }
  files.sort((a, b) => a.localeCompare(b, 'zh'))
  return files.slice(0, limit)
}

function listOutputs(dir, limit = 40) {
  if (!isDir(dir)) return []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.mp4') continue
    const full = path.join(dir, entry.name)
    try {
      const stat = fs.statSync(full)
      files.push({ name: entry.name, path: full, size: stat.size, modified: stat.mtimeMs })
    } catch {
      /* ignore */
    }
  }
  files.sort((a, b) => b.modified - a.modified)
  return files.slice(0, limit)
}

/* ----------------------------------------------------------- 状态与安装 --- */

let setupChild = null
let setupState = { running: false, code: null, lastLine: '' }

function readSetupState() {
  let log = ''
  try {
    if (exists(SETUP_LOG)) {
      const raw = fs.readFileSync(SETUP_LOG, 'utf8')
      log = raw.length > 8000 ? raw.slice(-8000) : raw
    }
  } catch { /* ignore */ }
  return { ...setupState, log }
}

async function buildStatus(cfg) {
  const py = resolvePython(cfg)
  const checker = path.join(PLUGIN_DIR, 'py', 'check.py')
  const deps = { checked: false, missing: [], ffmpeg: '', ffmpegVersion: '', ready: false, raw: '' }

  if (py.isVenv && exists(checker)) {
    const result = await runProcess(py.python, [checker], { timeoutMs: 120000 })
    deps.checked = true
    deps.raw = (result.stdout + result.stderr).trim()
    const missing = /^MISSING=(.*)$/m.exec(deps.raw)
    deps.missing = missing && missing[1] !== 'NONE' ? missing[1].split(',').filter(Boolean) : []
    deps.ffmpeg = (/^FFMPEG=(.*)$/m.exec(deps.raw) || [])[1] || ''
    deps.ffmpegVersion = (/^FFMPEG_VERSION=(.*)$/m.exec(deps.raw) || [])[1] || ''
    deps.ready = ((/^READY=(.*)$/m.exec(deps.raw) || [])[1] || '').trim() === 'yes'
  }

  let outDirWritable = false
  try {
    fs.mkdirSync(cfg.outDir, { recursive: true })
    fs.accessSync(cfg.outDir, fs.constants.W_OK)
    outDirWritable = true
  } catch { /* ignore */ }

  const outputs = listOutputs(cfg.outDir)
  const mediaCount = collectMediaFrom(cfg.mediaDir).length

  return {
    ready: deps.ready && outDirWritable,
    python: { path: py.python, isVenv: py.isVenv, venvDir: py.venvDir },
    deps,
    outDir: { path: cfg.outDir, exists: isDir(cfg.outDir), writable: outDirWritable, count: outputs.length },
    mediaDir: { path: cfg.mediaDir, exists: isDir(cfg.mediaDir), count: mediaCount },
    skill: { root: cfg.skillRoot, found: exists(path.join(cfg.skillRoot, 'scripts', 'cloud_manager.py')) },
    voices: VOICES,
    qqGroup: QQ_GROUP,
    setup: readSetupState(),
    os: { platform: process.platform },
  }
}

function startSetup(cfg, log) {
  if (setupChild) return { started: false, reason: '已经在装了，请稍等' }
  const script = path.join(PLUGIN_DIR, 'py', 'setup.py')
  if (!exists(script)) return { started: false, reason: '插件里找不到 py/setup.py' }
  const basePython = detectBasePython(cfg)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(SETUP_LOG, '', 'utf8')
  setupState = { running: true, code: null, lastLine: '' }

  let child
  try {
    child = spawn(basePython, [script, '--venv', cfg.venvDir,
      '--mirror', 'https://pypi.tuna.tsinghua.edu.cn/simple'], { cwd: WORKSPACE_DIR, windowsHide: true })
  } catch (err) {
    setupState = { running: false, code: -1, lastLine: String(err.message) }
    return { started: false, reason: `启动失败：${err.message}` }
  }
  setupChild = child
  const append = (text) => {
    try { fs.appendFileSync(SETUP_LOG, text, 'utf8') } catch { /* ignore */ }
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    if (lines.length) setupState.lastLine = lines[lines.length - 1]
  }
  child.stdout?.on('data', (b) => append(b.toString('utf8')))
  child.stderr?.on('data', (b) => append(b.toString('utf8')))
  const settle = (code) => {
    setupChild = null
    setupState = { running: false, code: code === null ? -1 : code, lastLine: setupState.lastLine }
    append(`\n[退出码 ${code}]\n`)
    log(code === 0 ? 'info' : 'warn', `运行环境安装结束，退出码 ${code}`)
  }
  child.on('error', (err) => { append(`\n[启动失败 ${err.message}]\n`); settle(-1) })
  child.on('close', (code) => settle(code))
  log('info', `开始安装运行环境（${basePython}）`)
  return { started: true, basePython, venvDir: cfg.venvDir }
}

/* -------------------------------------------------------------- 合成成片 --- */

async function makeVideo(cfg, request, log) {
  const scriptPath = path.join(PLUGIN_DIR, 'py', 'auto_video.py')
  if (!exists(scriptPath)) return { ok: false, error: '插件里找不到 py/auto_video.py' }
  const py = resolvePython(cfg)
  if (!py.isVenv) {
    return { ok: false, error: '运行环境还没装好。请到设置页点「一键装好运行环境」。', needsSetup: true }
  }

  const script = String(request.script || '').trim()
  if (!script) return { ok: false, error: '没有填文案' }

  let media = Array.isArray(request.media) ? request.media.filter(Boolean) : []
  if (!media.length && isDir(cfg.mediaDir)) {
    media = collectMediaFrom(cfg.mediaDir)
  }

  const payload = {
    title: String(request.title || '').slice(0, 120),
    script,
    voice: String(request.voice || cfg.voice),
    rate: String(request.rate || '+0%'),
    orientation: String(request.orientation || cfg.orientation),
    media,
    bgm: String(request.bgm || cfg.bgm || ''),
    bgmVolume: request.bgmVolume === undefined ? cfg.bgmVolume : Number(request.bgmVolume),
    subtitleFontSize: Number(request.subtitleFontSize || cfg.subtitleFontSize || 0),
    burnSubtitles: request.burnSubtitles === undefined ? cfg.burnSubtitles !== false : !!request.burnSubtitles,
    skillRoot: cfg.skillRoot,
    outDir: cfg.outDir,
  }

  fs.mkdirSync(DATA_DIR, { recursive: true })
  const stamp = Date.now()
  const reqFile = path.join(DATA_DIR, `request-${stamp}.json`)
  const outFile = path.join(DATA_DIR, `result-${stamp}.json`)
  fs.writeFileSync(reqFile, JSON.stringify(payload, null, 2), 'utf8')

  log('info', `开始合成：${payload.title || '(未命名)'}（${payload.script.length} 字，素材 ${media.length} 个）`)
  const result = await runProcess(py.python, [scriptPath, '--json', reqFile, '--out', outFile], {
    env: { PYTHONIOENCODING: 'utf-8' },
    timeoutMs: 1800000,
  })

  let parsed = null
  try {
    if (exists(outFile)) parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'))
  } catch { parsed = null }
  for (const f of [reqFile, outFile]) {
    try { fs.unlinkSync(f) } catch { /* ignore */ }
  }

  if (!parsed) {
    const detail = (result.stderr || result.stdout || '').trim().slice(-2000)
    return { ok: false, error: `合成失败（退出码 ${result.code}）。${detail ? '\n' + detail : ''}`, code: 'pipeline-failed' }
  }
  if (parsed.ok) log('info', `成片已生成：${parsed.data.output}`)
  else log('warn', `合成失败：${parsed.reason}`)
  return parsed
}

/* ------------------------------------------------------------- 提示词段 --- */

function buildPromptSection(cfg) {
  const py = resolvePython(cfg)
  const scriptPath = path.join(PLUGIN_DIR, 'py', 'auto_video.py')
  const lines = [
    '## 自动成片（本地 ffmpeg 合成，不依赖剪映）',
    '',
    '用户要「做视频 / 出成片 / 把文案变成视频」时，用这个能力，不要凭空描述步骤，也不要尝试用剪映——',
    '本机剪映是 7.9，草稿文件已加密，脚本生成的明文档稿它读不了。',
    '',
    '### 一行命令就能出片',
    '```',
    `"${py.python}" "${scriptPath}" --json 请求.json`,
    '```',
    '请求 JSON 字段：',
    '- `script`（必填）：要念的文案。会按标点自动切句，逐句配音并对齐字幕',
    '- `title`：成片名（也当文件名）',
    '- `voice`：配音音色，默认 `' + cfg.voice + '`。可选：' + VOICES.map((v) => v.id).join('、'),
    '- `orientation`：`landscape` 横屏 1920x1080 / `portrait` 竖屏 1080x1920',
    '- `media`：图片或视频的**绝对路径数组**，会等比裁切填满并依次出现；不传就用渐变背景 + 标题',
    `- \`bgm\`：本地音乐文件；\`bgmQuery\`：剪映云曲库 id/关键词（需能连它的云接口），二者选一`,
    `- \`bgmVolume\`：配乐音量，默认 ${cfg.bgmVolume}（有人声时别超过 0.7）`,
    '- `subtitleFontSize`：字幕像素大小，留空自动',
    '',
    `- 素材文件夹：${cfg.mediaDir || '(未设置)'} —— 里面放图片/视频，请求里不传 media 时会自动全用上`,
    `- 成片输出到：${cfg.outDir}`,
    '',
    '### 建议做法',
    '1. 先确认环境：跑 `"<上面的 python>" "' + path.join(PLUGIN_DIR, 'py', 'check.py') + '"`，',
    '   看到 `READY=yes` 才算就绪；否则让用户到设置页点「一键装好运行环境」。',
    '2. 文案长度决定片长：中文大约每秒 4~5 个字，30 秒片约 130~150 字。',
    '3. 出片后把成片的绝对路径告诉用户，并说明可以直接双击播放。',
    '4. 用户不满意时优先调文案、音色、配乐音量、素材顺序——不要改合成参数硬凑。',
  ]
  if (!py.isVenv) {
    lines.push('', '> ⚠️ 当前运行环境未就绪，上面的命令会失败；先让用户去设置页装好。')
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------- 路由工具 --- */

function sendJson(res, code, obj) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 2 * 1024 * 1024) {
        raw = raw.slice(0, 2 * 1024 * 1024)
        try { req.destroy() } catch { /* ignore */ }
      }
    })
    req.on('end', () => resolve(raw))
    req.on('error', () => resolve(''))
  })
}

function revealInExplorer(target) {
  try {
    if (isDir(target)) {
      spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('explorer.exe', ['/select,' + target.replace(/\//g, '\\')], { detached: true, stdio: 'ignore' }).unref()
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

/* ------------------------------------------------------------------ 主体 --- */

export function apply(ctx, patchRaw) {
  const log = makeLogger(ctx)
  let cfg = mergeConfig(patchRaw)

  ctx.effect(() => {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch { /* ignore */ }
    log('info', `自动成片插件已加载。运行环境：${cfg.venvDir}`)
  }, 'auto-video.init')

  // 1) 让模型知道怎么出片
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'auto-video',
      order: 10260,
      text: buildPromptSection(cfg),
    }),
    'auto-video.prompt',
  )

  // 2) 设置页用的同源路由
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      handler: async (req, res) => {
        const method = (req.method || 'GET').toUpperCase()
        const url = String(req.url || '')
        const sub = url.split('?')[0].slice(BASE.length).replace(/^\/+/, '').replace(/\/+$/, '')

        try {
          if (sub === 'status' && (method === 'GET' || method === 'HEAD')) {
            return sendJson(res, 200, { ok: true, config: cfg, status: await buildStatus(cfg) })
          }

          if (sub === 'config' && method === 'POST') {
            const raw = await readBody(req)
            let payload
            try { payload = JSON.parse(raw || '{}') } catch {
              return sendJson(res, 400, { ok: false, error: '请求不是合法 JSON' })
            }
            try {
              writeConfigFile(normalizePatch(payload))
            } catch (err) {
              return sendJson(res, 500, { ok: false, error: `保存失败：${err.message}` })
            }
            cfg = mergeConfig(patchRaw)
            log('info', '设置已更新')
            return sendJson(res, 200, { ok: true, config: cfg, status: await buildStatus(cfg) })
          }

          if (sub === 'outputs' && (method === 'GET' || method === 'HEAD')) {
            return sendJson(res, 200, { ok: true, outDir: cfg.outDir, outputs: listOutputs(cfg.outDir) })
          }

          if (sub === 'media' && (method === 'GET' || method === 'HEAD')) {
            return sendJson(res, 200, {
              ok: true,
              mediaDir: cfg.mediaDir,
              exists: isDir(cfg.mediaDir),
              media: collectMediaFrom(cfg.mediaDir).map((p) => ({ name: path.basename(p), path: p })),
            })
          }

          if (sub === 'setup' && method === 'POST') {
            return sendJson(res, 200, { ok: true, ...startSetup(cfg, log) })
          }

          if (sub === 'setup' && (method === 'GET' || method === 'HEAD')) {
            return sendJson(res, 200, { ok: true, setup: readSetupState() })
          }

          if (sub === 'make' && method === 'POST') {
            const raw = await readBody(req)
            let payload
            try { payload = JSON.parse(raw || '{}') } catch {
              return sendJson(res, 400, { ok: false, error: '请求不是合法 JSON' })
            }
            const result = await makeVideo(cfg, payload, log)
            return sendJson(res, result.ok ? 200 : 500, result)
          }

          if (sub === 'file' && (method === 'GET' || method === 'HEAD')) {
            // 只允许读成片目录里的文件，避免变成任意文件读取
            const query = (url.split('?')[1] || '')
            const wanted = decodeURIComponent((/[?&]path=([^&]*)/.exec('?' + query) || [])[1] || '')
            const resolved = path.resolve(wanted)
            const root = path.resolve(cfg.outDir)
            if (!resolved.toLowerCase().startsWith(root.toLowerCase()) || !exists(resolved)) {
              return sendJson(res, 403, { ok: false, error: '不允许访问这个路径' })
            }
            let stat
            try {
              stat = fs.statSync(resolved)
            } catch (err) {
              return sendJson(res, 500, { ok: false, error: String(err.message) })
            }
            const total = stat.size
            const range = req.headers?.range
            res.setHeader('Content-Type', 'video/mp4')
            res.setHeader('Accept-Ranges', 'bytes')
            if (range) {
              const match = /bytes=(\d*)-(\d*)/.exec(range)
              const start = match && match[1] ? Number(match[1]) : 0
              const end = match && match[2] ? Number(match[2]) : total - 1
              if (start >= total || end >= total || start > end) {
                res.statusCode = 416
                res.setHeader('Content-Range', `bytes */${total}`)
                return res.end()
              }
              res.statusCode = 206
              res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
              res.setHeader('Content-Length', String(end - start + 1))
              if (method === 'HEAD') return res.end()
              return fs.createReadStream(resolved, { start, end }).pipe(res)
            }
            res.statusCode = 200
            res.setHeader('Content-Length', String(total))
            if (method === 'HEAD') return res.end()
            return fs.createReadStream(resolved).pipe(res)
          }

          if (sub === 'qrcode' && (method === 'GET' || method === 'HEAD')) {
            const image = path.join(PLUGIN_DIR, QQ_GROUP.image)
            if (!exists(image)) {
              return sendJson(res, 404, { ok: false, error: '找不到交流群二维码图片' })
            }
            let stat
            try {
              stat = fs.statSync(image)
            } catch (err) {
              return sendJson(res, 500, { ok: false, error: String(err.message) })
            }
            res.statusCode = 200
            res.setHeader('Content-Type', 'image/png')
            res.setHeader('Content-Length', String(stat.size))
            res.setHeader('Cache-Control', 'public, max-age=86400')
            if (method === 'HEAD') return res.end()
            return fs.createReadStream(image).pipe(res)
          }

          if (sub === 'open' && method === 'POST') {
            const raw = await readBody(req)
            let payload = {}
            try { payload = JSON.parse(raw || '{}') } catch { /* 允许空 */ }
            const target = String(payload.path || cfg.outDir)
            return sendJson(res, 200, revealInExplorer(target))
          }

          return sendJson(res, 404, { ok: false, error: 'not found' })
        } catch (err) {
          log('error', '路由处理失败', err)
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    }),
    'auto-video.routes()',
  )

  // 3) 可选：能拿到 defineTool 就再送两个模型可见工具
  ctx.inject(['tools'], (child) => {
    import('@deepseek-ai/dsh-tools')
      .then(({ defineTool }) => {
        const envTool = defineTool({
          name: 'autovideo_environment',
          description:
            '查看“自动成片”的运行环境是否就绪：ffmpeg 能不能用、配音和字幕依赖是否齐全、成片会存到哪个文件夹。做视频之前先调它。',
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
          async execute() {
            return JSON.stringify(await buildStatus(cfg), null, 2)
          },
        })
        const makeTool = defineTool({
          name: 'autovideo_make',
          description:
            '把一段文案直接做成成片 mp4：自动配音、精确对齐字幕、可选背景音乐，并把给的图片/视频拼起来。返回成片的绝对路径。',
          parameters: {
            script: { type: 'string', required: true, description: '要念的文案，会按标点自动切句' },
            title: { type: 'string', description: '成片名（同时作为文件名）' },
            voice: { type: 'string', description: `配音音色，默认 ${cfg.voice}` },
            orientation: { type: 'string', description: 'landscape 横屏 / portrait 竖屏' },
            media: { type: 'array', items: { type: 'string' }, description: '图片或视频的绝对路径，会依次出现' },
            bgm: { type: 'string', description: '本地背景音乐文件路径' },
            bgmQuery: { type: 'string', description: '或剪映云曲库的 id/关键词' },
            bgmVolume: { type: 'number', description: '配乐音量 0~1' },
            subtitleFontSize: { type: 'number', description: '字幕像素大小，留空自动' },
          },
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
          async execute(args) {
            const result = await makeVideo(cfg, {
              script: args.script,
              title: args.title || '',
              voice: args.voice || cfg.voice,
              orientation: args.orientation || cfg.orientation,
              media: args.media || [],
              bgm: args.bgm || cfg.bgm || '',
              bgmQuery: args.bgmQuery || '',
              bgmVolume: args.bgmVolume === undefined ? cfg.bgmVolume : args.bgmVolume,
              subtitleFontSize: args.subtitleFontSize,
            }, log)
            return JSON.stringify(result, null, 2)
          },
        })
        child.effect(() => child.tools.register(envTool), 'auto-video.tool.environment')
        child.effect(() => child.tools.register(makeTool), 'auto-video.tool.make')
        log('info', '已注册模型可见工具：autovideo_environment、autovideo_make')
      })
      .catch((err) => {
        log('warn', `无法加载 @deepseek-ai/dsh-tools，跳过工具注册（设置页与命令行能力不受影响）：${(err && err.message) || err}`)
      })
  })
}

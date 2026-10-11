#!/usr/bin/env node
/**
 * Host 冒烟测试：mock 一个 Cordis ctx，真实 import 本插件的 index.js，
 * 跑通 apply() 与全部同源路由。
 *
 *   node tools/smoke.mjs            # 只测接线与接口
 *   node tools/smoke.mjs --make     # 额外真出一条成片（需要先装好运行环境）
 *
 * 这不是替代在 DSH 里真装一遍，而是把「模块能否加载、apply 是否抛错、
 * 路由与提示词段是否注册、接口结构是否正确、成片能否产出」这些最容易写错的地方钉住。
 */

import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = '/autovideo/api'
const DO_MAKE = process.argv.includes('--make')
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-smoke-'))

const reg = { effects: [], sections: [], routes: [], tools: [], logs: [] }
const logger = {
  info: (m) => reg.logs.push(['info', m]),
  warn: (m) => reg.logs.push(['warn', m]),
  error: (m) => reg.logs.push(['error', m]),
  debug: () => {},
}
const childCtx = {
  effect(fn, label) { const d = fn(); reg.effects.push({ label, dispose: d }); return d },
  tools: { register(tool) { reg.tools.push(tool); return () => {} } },
  logger,
}
const ctx = {
  logger,
  effect(fn, label) { const d = fn(); reg.effects.push({ label, dispose: d }); return d },
  systemPrompt: { section(spec) { reg.sections.push(spec); return () => {} } },
  webServer: { register(route) { reg.routes.push(route); return () => {} } },
  inject(names, cb) { cb(childCtx) },
}

function makeReq(method, url, body, headers) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers || {}
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
  return req
}

/** 支持被流 pipe 的 mock 响应 */
function call(handler, method, url, body, headers) {
  return new Promise((resolve) => {
    const chunks = []
    const res = new Writable({ write(chunk, enc, cb) { chunks.push(Buffer.from(chunk)); cb() } })
    res.statusCode = 0
    res.headers = {}
    res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v }
    res.on('finish', () => {
      const buf = Buffer.concat(chunks)
      let parsed = buf.toString('utf8')
      try { parsed = JSON.parse(parsed) } catch { /* 二进制保留字符串 */ }
      resolve({ status: res.statusCode, headers: res.headers, body: parsed, bytes: buf.length })
    })
    Promise.resolve(handler(makeReq(method, url, body, headers), res)).catch((err) => {
      resolve({ status: -1, body: { error: String(err) }, bytes: 0 })
    })
  })
}

const failures = []
function check(label, cond, detail) {
  if (!cond) failures.push(label)
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function line(t) { console.log(`\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`) }

/* --------------------------------------------------------------------- run --- */

line('1. import + apply')
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
check('导出 name', typeof mod.name === 'string', `name=${mod.name}`)
check('导出 inject（数组）', Array.isArray(mod.inject), JSON.stringify(mod.inject))
check('导出 apply', typeof mod.apply === 'function')

try {
  mod.apply(ctx, {
    venvDir: process.env.AUTOVIDEO_VENV || '',
    outDir: OUT_DIR,
    voice: 'zh-CN-XiaoxiaoNeural',
    orientation: 'landscape',
    bgmVolume: 0.6,
    bgm: '',
    subtitleFontSize: 0,
    burnSubtitles: true,
    mediaDir: '',
    skillRoot: '',
  })
  check('apply() 未抛错', true)
} catch (err) {
  check('apply() 未抛错', false, `${err.name}: ${err.message}`)
}

line('2. 注册结果')
check('注册了提示词段', reg.sections.length === 1, reg.sections.map((s) => s.name).join(','))
check('注册了前缀路由', reg.routes.length === 1 && reg.routes[0].kind === 'prefix',
  JSON.stringify(reg.routes.map((r) => r.path)))
check('注册了 ctx.effect', reg.effects.length >= 3, reg.effects.map((e) => e.label).join(' | '))
const section = reg.sections[0]
if (section) {
  check('提示词段含出片命令', /auto_video\.py/.test(section.text))
  check('提示词段含参数说明', /script/.test(section.text) && /voice/.test(section.text))
  console.log(`      长度 ${section.text.length} 字符，order=${section.order}`)
}

await new Promise((r) => setTimeout(r, 1500))
if (reg.tools.length > 0) {
  check('工具注册成功', true, reg.tools.map((t) => t.name).join(', '))
} else {
  const warned = reg.logs.some(([l, m]) => l === 'warn' && /dsh-tools/.test(m))
  check('解析不到 dsh-tools 时优雅降级（留 warn、不抛错）', warned)
}

const handler = reg.routes[0]?.handler
if (!handler) {
  check('拿到路由 handler', false)
} else {
  line('3. GET /status')
  const st = await call(handler, 'GET', `${BASE}/status`)
  check('status 200', st.status === 200, `status=${st.status}`)
  const s = st.body?.status
  check('status 结构完整', !!s && !!(s.python && s.deps && s.outDir && s.mediaDir && s.voices))
  if (s) {
    console.log(`      运行环境：${s.python.path}  venv=${s.python.isVenv}`)
    console.log(`      ffmpeg：${s.deps.ffmpeg || '(未找到)'}  版本=${s.deps.ffmpegVersion || '-'}`)
    console.log(`      缺失依赖：[${s.deps.missing.join(',')}]`)
    console.log(`      成片目录：${s.outDir.path}  可写=${s.outDir.writable}`)
    console.log(`      声音选项：${(s.voices || []).length} 个`)
    if (!s.ready) console.log('      （环境未就绪：加装运行环境后重跑，或忽略此处的 FAIL）')
  }

  line('4. GET /outputs 与 /media')
  check('outputs 200', (await call(handler, 'GET', `${BASE}/outputs`)).status === 200)
  check('media 200', (await call(handler, 'GET', `${BASE}/media`)).status === 200)

  line('5. POST /config 并回读')
  const saved = await call(handler, 'POST', `${BASE}/config`, { bgmVolume: 0.35, orientation: 'portrait', subtitleFontSize: 40 })
  check('config 保存成功', saved.status === 200 && saved.body?.ok === true, saved.body?.error || '')
  check('config 立即生效',
    saved.body?.config?.bgmVolume === 0.35 && saved.body?.config?.orientation === 'portrait',
    `bgmVolume=${saved.body?.config?.bgmVolume} orientation=${saved.body?.config?.orientation}`)
  await call(handler, 'POST', `${BASE}/config`, { bgmVolume: 0.6, orientation: 'landscape', subtitleFontSize: 0 })

  line('6. 路由健壮性')
  check('未知子路径 404', (await call(handler, 'GET', `${BASE}/nope`)).status === 404)
  const escape = await call(handler, 'GET', `${BASE}/file?path=${encodeURIComponent(path.join(os.tmpdir(), 'not-ours.mp4'))}`)
  check('file 拒绝成片目录外的路径', escape.status === 403, `status=${escape.status}`)
  check('非法 JSON 返回 400',
    (await call(handler, 'POST', `${BASE}/make`, undefined)).status === 400 ||
    (await call(handler, 'POST', `${BASE}/make`, {})).status === 500)
  check('setup 200', (await call(handler, 'GET', `${BASE}/setup`)).status === 200)

  line('6b. GET /qrcode（交流群二维码）')
  const qr = await call(handler, 'GET', `${BASE}/qrcode`)
  check('qrcode 200', qr.status === 200, `status=${qr.status}`)
  check('Content-Type 为 image/png', qr.headers?.['content-type'] === 'image/png', qr.headers?.['content-type'])
  check('返回了图片字节', qr.bytes > 5000, `bytes=${qr.bytes}`)
  const qq = s?.qqGroup
  check('status 里带上了交流群信息', !!qq && !!qq.link && !!qq.name, qq ? `${qq.name} / ${qq.number}` : '(缺失)')
  if (qq) check('交流群链接是 qm.qq.com', /^https:\/\/qm\.qq\.com\//.test(qq.link), qq.link)

  if (DO_MAKE) {
    line('7. POST /make（真出一条成片）')
    const made = await call(handler, 'POST', `${BASE}/make`, {
      title: 'smoke-test',
      script: '这是自动成片插件跑出来的测试视频。配音、字幕和时间轴都是自动对齐的。整条片子在本机用 ffmpeg 合成。',
      orientation: 'landscape',
    })
    check('make 返回 200', made.status === 200, `status=${made.status}`)
    check('make ok=true', made.body?.ok === true, JSON.stringify(made.body).slice(0, 400))
    const out = made.body?.data?.output
    if (out) {
      console.log(`      成片：${out}`)
      console.log(`      ${made.body.data.durationSeconds} 秒 · ${(made.body.data.sizeBytes / 1048576).toFixed(2)} MB · ${made.body.data.width}x${made.body.data.height}`)
      check('成片文件存在', fs.existsSync(out))
      check('成片不是空文件', fs.existsSync(out) && fs.statSync(out).size > 100000)

      line('8. GET /file（Range 流式预览）')
      const ranged = await call(handler, 'GET', `${BASE}/file?path=${encodeURIComponent(out)}`, undefined, { range: 'bytes=0-2047' })
      check('Range 返回 206', ranged.status === 206, `status=${ranged.status}`)
      check('Range 长度正确', ranged.bytes === 2048, `bytes=${ranged.bytes}`)
      check('Content-Type 为 video/mp4', ranged.headers?.['content-type'] === 'video/mp4', ranged.headers?.['content-type'])
    }
  } else {
    line('7. POST /make')
    console.log('      （未加 --make，跳过真实出片）')
  }
}

line('9. 清理 effect（dispose 不应抛错）')
let disposeOk = true
for (const e of reg.effects) {
  try { if (typeof e.dispose === 'function') e.dispose() } catch (err) { disposeOk = false; console.log(`      ${e.label} 抛错：${err.message}`) }
}
check('所有 effect 可安全 dispose', disposeOk)

fs.rmSync(OUT_DIR, { recursive: true, force: true })

line('结果')
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
} else {
  console.log('全部通过。')
}

/**
 * dsh-plugin-auto-video — 浏览器半边（设置页）。
 *
 * 形态照官方 ui-plugin 规范：window.__ModuleLoader__ 注册的惰性工厂，id 等于包名；
 * React 从浏览器模块表 require。数据全走宿主注册的同源路由 /autovideo/api/*。
 *
 * 文案原则：给普通人看，不用术语。
 * 样式原则：不写死颜色，容器与文字用 currentColor + color-mix 跟随宿主主题；
 *           只有状态圆点用固定色（属于图形而非界面配色）。
 *
 * @module dsh-plugin-auto-video/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-auto-video',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;
    const API = '/autovideo/api';

    const CSS = `
.av-wrap{display:flex;flex-direction:column;gap:14px;color:inherit;font-size:13.5px;line-height:1.7}
.av-h{margin:0;font-size:15px;font-weight:600;color:inherit}
.av-sub{margin:16px 0 0;padding-top:14px;font-size:13.5px;font-weight:600;color:inherit;
  border-top:1px solid color-mix(in srgb,currentColor 14%,transparent)}
.av-desc{margin:0;color:inherit;opacity:.72;font-size:12.5px}
.av-card{border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:11px;
  padding:12px 14px;background:color-mix(in srgb,currentColor 3%,transparent);
  display:flex;flex-direction:column;gap:9px}
.av-card.good{border-color:color-mix(in srgb,currentColor 26%,transparent);
  background:color-mix(in srgb,currentColor 6%,transparent)}
.av-big{font-size:14.5px;font-weight:600;display:flex;align-items:center;gap:8px}
.av-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;display:inline-block}
.av-row{display:flex;align-items:center;gap:9px;font-size:13px}
.av-between{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.av-kv{display:flex;flex-direction:column;gap:2px;min-width:0}
.av-name{font-weight:500}
.av-val{color:inherit;opacity:.62;font-size:12px;word-break:break-all}
.av-btn{padding:7px 16px;border-radius:9px;border:1px solid color-mix(in srgb,currentColor 30%,transparent);
  background:color-mix(in srgb,currentColor 11%,transparent);color:inherit;cursor:pointer;
  font:inherit;font-size:12.5px;white-space:nowrap;display:inline-block;text-align:center;
  text-decoration:none;box-sizing:border-box}
.av-btn:hover{background:color-mix(in srgb,currentColor 19%,transparent)}
.av-btn[disabled]{opacity:.45;cursor:default}
.av-btn-main{border-color:color-mix(in srgb,currentColor 42%,transparent);
  background:color-mix(in srgb,currentColor 20%,transparent);font-weight:600}
.av-btn-mini{padding:4px 11px;font-size:12px}
.av-choice{display:flex;gap:9px;flex-wrap:wrap}
.av-opt{padding:9px 14px;border-radius:10px;cursor:pointer;text-align:left;
  border:1px solid color-mix(in srgb,currentColor 22%,transparent);
  background:color-mix(in srgb,currentColor 4%,transparent);color:inherit;font:inherit;font-size:12.5px}
.av-opt[data-on="1"]{border-color:color-mix(in srgb,currentColor 55%,transparent);
  background:color-mix(in srgb,currentColor 16%,transparent);font-weight:600}
.av-opt small{display:block;font-weight:400;opacity:.65;font-size:11.5px;margin-top:2px}
.av-ta,.av-in,.av-sel{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:10px;
  border:1px solid color-mix(in srgb,currentColor 22%,transparent);
  background:color-mix(in srgb,currentColor 4%,transparent);color:inherit;font:inherit;font-size:13px;outline:none}
.av-ta{min-height:130px;line-height:1.7;resize:vertical}
.av-ta:focus,.av-in:focus,.av-sel:focus{border-color:color-mix(in srgb,currentColor 45%,transparent)}
.av-sel{appearance:none;cursor:pointer}
.av-slider{width:100%;accent-color:currentColor}
.av-note{border-radius:9px;padding:9px 12px;font-size:12.5px;
  border:1px solid color-mix(in srgb,currentColor 20%,transparent);
  background:color-mix(in srgb,currentColor 5%,transparent)}
.av-note.bad{border-color:color-mix(in srgb,currentColor 34%,transparent)}
.av-pre{margin:0;padding:10px 12px;border-radius:9px;overflow:auto;max-height:180px;
  background:color-mix(in srgb,currentColor 6%,transparent);font-size:11.5px;line-height:1.55;
  white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace}
.av-list{display:flex;flex-direction:column;gap:6px}
.av-item{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:7px 11px;border-radius:9px;
  border:1px solid color-mix(in srgb,currentColor 14%,transparent);
  background:color-mix(in srgb,currentColor 3%,transparent)}
.av-item b{font-weight:550;font-size:12.5px}
.av-meta{color:inherit;opacity:.55;font-size:11.5px}
.av-adv summary{cursor:pointer;font-size:12.5px;opacity:.75;user-select:none}
.av-adv[open] summary{margin-bottom:10px}
.av-grid{display:flex;flex-direction:column;gap:10px}
.av-video{width:100%;max-height:360px;border-radius:10px;background:#000;display:block}
.av-count{color:inherit;opacity:.6;font-size:12px}
.av-group{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.av-qr{width:176px;max-width:44vw;height:auto;display:block;border-radius:12px;
  border:1px solid color-mix(in srgb,currentColor 18%,transparent);
  background-color:#1b1b1b}
.av-group-side{display:flex;flex-direction:column;gap:8px;align-items:flex-start;
  min-width:0;flex:1 1 240px}
.av-group-name{font-size:13.5px;font-weight:600}
`;

    /* ------------------------------------------------------------ 小工具 -- */

    const post = (sub, body) =>
      fetch(`${API}/${sub}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then((r) => r.json());

    const get = (sub) => fetch(`${API}/${sub}`, { cache: 'no-store' }).then((r) => r.json());

    const fileUrl = (p) => `${API}/file?path=${encodeURIComponent(p)}`;

    const fmtTime = (ms) => {
      if (!ms) return '';
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

    function Dot({ ok }) {
      const color = ok === true ? '#2ea043' : ok === false ? '#f85149' : '#d29922';
      return h('span', { className: 'av-dot', style: { background: color } });
    }

    /* -------------------------------------------------------------- 状态卡 -- */

    function HealthCard({ data, onReload }) {
      if (!data) return h('div', { className: 'av-card' }, h('div', { className: 'av-desc' }, '正在检查…'));
      const s = data.status;
      const ready = s.ready;
      const headline = ready ? '可以出片了：给我一段文案就行' : '还差几步，先按下面的提示弄好';

      const rows = [
        {
          ok: s.python.isVenv,
          name: '运行环境',
          value: s.python.isVenv ? s.python.path : '还没装。点下面的按钮一次装好，以后不用管。',
        },
        {
          ok: !!s.deps.ffmpeg,
          name: '合成引擎（ffmpeg）',
          value: s.deps.ffmpeg
            ? `${s.deps.ffmpeg}${s.deps.ffmpegVersion ? `（版本 ${s.deps.ffmpegVersion}）` : ''}`
            : s.deps.checked
              ? '没找到。运行环境可能没装完整。'
              : '还没检查（先装好运行环境）',
        },
        {
          ok: s.deps.checked && s.deps.missing.length === 0,
          name: '配音与字幕组件',
          value: !s.deps.checked
            ? '还没检查（先装好运行环境）'
            : s.deps.missing.length
              ? `还缺：${s.deps.missing.join('、')}`
              : '齐了',
        },
        {
          ok: s.outDir.writable,
          name: '成片存到哪儿',
          value: `${s.outDir.path}${s.outDir.writable ? `（已经有 ${s.outDir.count} 部）` : '（这个文件夹不能用）'}`,
        },
      ];

      return h(
        'div',
        { className: `av-card${ready ? ' good' : ''}` },
        h('div', { className: 'av-big' }, h(Dot, { ok: ready }), headline),
        h('div', { className: 'av-grid' },
          rows.map((row) =>
            h('div', { className: 'av-row', key: row.name },
              h(Dot, { ok: row.ok }),
              h('div', { className: 'av-kv' },
                h('span', { className: 'av-name' }, row.name),
                h('span', { className: 'av-val' }, row.value))))),
        h('div', { className: 'av-between' },
          h('span', { className: 'av-desc' }, '改完设置或装完环境后，点右边重新检查。'),
          h('button', { className: 'av-btn av-btn-mini', onClick: onReload }, '重新检查')),
      );
    }

    /* ------------------------------------------------------------ 装环境 -- */

    function SetupBlock({ data, onDone }) {
      const [busy, setBusy] = useState(false);
      const [setup, setSetup] = useState(null);
      const [msg, setMsg] = useState('');
      const timer = useRef(null);

      const poll = useCallback(() => {
        get('setup')
          .then((r) => {
            setSetup(r.setup);
            if (r.setup && !r.setup.running) {
              if (timer.current) clearInterval(timer.current);
              timer.current = null;
              onDone();
            }
          })
          .catch(() => {});
      }, [onDone]);

      useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

      const start = () => {
        setMsg('');
        setBusy(true);
        post('setup')
          .then((r) => {
            setBusy(false);
            if (!r.started) setMsg(r.reason || '没能开始安装');
            if (timer.current) clearInterval(timer.current);
            timer.current = setInterval(poll, 2000);
            poll();
          })
          .catch((e) => { setBusy(false); setMsg(String(e)); });
      };

      const running = (setup && setup.running) || busy;
      const s = data && data.status;
      const needed = s && (!s.python.isVenv || !s.deps.ready);

      return h(
        'div',
        { className: 'av-card' },
        h('div', { className: 'av-between' },
          h('div', { className: 'av-kv' },
            h('span', { className: 'av-name' }, needed ? '需要装一下运行环境' : '运行环境已经装好了'),
            h('span', { className: 'av-desc' },
              needed
                ? '点一次按钮就行，会自动下载需要的组件（几十兆，很快）。'
                : '想重装或换电脑时，也可以再点一次。')),
          h('button', { className: 'av-btn av-btn-main', disabled: running, onClick: start },
            running ? '正在装，请稍等…' : '一键装好运行环境')),

        msg ? h('div', { className: 'av-note bad' }, msg) : null,

        setup
          ? h('div', { className: 'av-kv' },
              h('span', { className: 'av-desc' },
                setup.running ? '正在安装……'
                  : setup.code === 0 ? '上一次安装：成功'
                    : setup.code === null ? '' : `上一次安装：没成功（结束码 ${setup.code}）`),
              setup.lastLine ? h('span', { className: 'av-val' }, setup.lastLine) : null,
              setup.log ? h('pre', { className: 'av-pre' }, setup.log) : null)
          : null,
      );
    }

    /* ------------------------------------------------------------ 默认设置 -- */

    function SettingsBlock({ cfg, status, onSaved }) {
      const [form, setForm] = useState(null);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState('');

      useEffect(() => {
        if (cfg) {
          setForm({
            voice: cfg.voice || 'zh-CN-XiaoxiaoNeural',
            orientation: cfg.orientation || 'landscape',
            bgmVolume: typeof cfg.bgmVolume === 'number' ? cfg.bgmVolume : 0.6,
            subtitleFontSize: Number(cfg.subtitleFontSize || 0),
            burnSubtitles: cfg.burnSubtitles !== false,
            bgm: cfg.bgm || '',
            mediaDir: cfg.mediaDir || '',
            outDir: cfg.outDir || '',
            venvDir: cfg.venvDir || '',
            skillRoot: cfg.skillRoot || '',
          });
        }
      }, [cfg]);

      if (!form) return null;
      const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));
      const voices = (status && status.voices) || [];

      const save = () => {
        setBusy(true);
        setMsg('');
        post('config', form)
          .then((r) => { setBusy(false); setMsg(r.ok ? '已保存，马上生效，不用重启。' : r.error || '保存失败'); if (r.ok && onSaved) onSaved(r); })
          .catch((e) => { setBusy(false); setMsg(String(e)); });
      };

      return h(
        'div',
        { className: 'av-card' },
        h('div', { className: 'av-kv' },
          h('span', { className: 'av-name' }, '片子默认做成什么样'),
          h('span', { className: 'av-desc' }, '这些是默认值。你也可以直接跟 DSH 说「用男声」「做竖屏」，它会照办。')),

        h('div', { className: 'av-kv' },
          h('span', { className: 'av-name' }, '声音'),
          h('select', { className: 'av-sel', value: form.voice, onChange: (e) => set({ voice: e.target.value }) },
            voices.map((v) => h('option', { key: v.id, value: v.id }, v.label)))),

        h('div', { className: 'av-kv' },
          h('span', { className: 'av-name' }, '画面方向'),
          h('div', { className: 'av-choice' },
            h('button', { className: 'av-opt', 'data-on': form.orientation === 'landscape' ? '1' : '0',
              onClick: () => set({ orientation: 'landscape' }) }, '横屏', h('small', null, '像电脑屏幕、B 站')),
            h('button', { className: 'av-opt', 'data-on': form.orientation === 'portrait' ? '1' : '0',
              onClick: () => set({ orientation: 'portrait' }) }, '竖屏', h('small', null, '像手机、抖音')))),

        h('div', { className: 'av-kv' },
          h('div', { className: 'av-between' },
            h('span', { className: 'av-name' }, '背景音乐音量'),
            h('span', { className: 'av-val' }, `${Math.round(form.bgmVolume * 100)}%`)),
          h('input', { className: 'av-slider', type: 'range', min: '0', max: '1', step: '0.05',
            value: String(form.bgmVolume), onChange: (e) => set({ bgmVolume: Number(e.target.value) }) }),
          h('span', { className: 'av-desc' }, '有人说话的时候，60% 左右刚好听得清又不吵。')),

        h('div', { className: 'av-kv' },
          h('div', { className: 'av-between' },
            h('span', { className: 'av-name' }, '字幕大小'),
            h('span', { className: 'av-val' }, form.subtitleFontSize ? `${form.subtitleFontSize} 像素` : '自动')),
          h('input', { className: 'av-slider', type: 'range', min: '0', max: '80', step: '2',
            value: String(form.subtitleFontSize), onChange: (e) => set({ subtitleFontSize: Number(e.target.value) }) }),
          h('span', { className: 'av-desc' }, '拖到 0 就是自动（按画面高度算，横屏约 32、竖屏约 57）。')),

        h('div', { className: 'av-between' },
          h('div', { className: 'av-kv' },
            h('span', { className: 'av-name' }, '把字幕烧进画面'),
            h('span', { className: 'av-desc' }, '开着的话，换任何播放器都能看到字幕；关掉就只剩一个 .srt 文件。')),
          h('button', { className: 'av-opt', 'data-on': form.burnSubtitles ? '1' : '0',
            onClick: () => set({ burnSubtitles: !form.burnSubtitles }) }, form.burnSubtitles ? '开着' : '关着')),

        h('div', { className: 'av-kv' },
          h('span', { className: 'av-name' }, '素材文件夹'),
          h('input', { className: 'av-in', value: form.mediaDir, placeholder: '例如 D:\\我的素材',
            onChange: (e) => set({ mediaDir: e.target.value }) }),
          h('span', { className: 'av-desc' },
            '把图片和视频丢进这个文件夹，做片子时会自动按文件名顺序用上。留空就只用渐变背景。' +
            (status && status.mediaDir && status.mediaDir.exists ? `（现在里面有 ${status.mediaDir.count} 个）` : ''))),

        h('div', { className: 'av-kv' },
          h('span', { className: 'av-name' }, '默认背景音乐'),
          h('input', { className: 'av-in', value: form.bgm, placeholder: '留空 = 不加配乐；也可以填本地音乐文件路径',
            onChange: (e) => set({ bgm: e.target.value }) }),
          h('span', { className: 'av-desc' }, '想用剪映云曲库的话，直接跟 DSH 说要哪首，它会按 id 或关键词去取。')),

        h('details', { className: 'av-adv' },
          h('summary', null, '高级（东西装在别处了才需要改）'),
          h('div', { className: 'av-grid' },
            h('div', null,
              h('span', { className: 'av-desc' }, '成片存到哪个文件夹'),
              h('input', { className: 'av-in', value: form.outDir, placeholder: '留空 = DSH 目录下的 autovideo-output',
                onChange: (e) => set({ outDir: e.target.value }) })),
            h('div', null,
              h('span', { className: 'av-desc' }, '运行环境装在哪儿'),
              h('input', { className: 'av-in', value: form.venvDir, placeholder: '留空 = 插件旁边的 runtimes 文件夹',
                onChange: (e) => set({ venvDir: e.target.value }) })),
            h('div', null,
              h('span', { className: 'av-desc' }, '剪映自动化工具包在哪儿（只为取云端音乐）'),
              h('input', { className: 'av-in', value: form.skillRoot, placeholder: '留空 = 插件旁边的 reference 文件夹',
                onChange: (e) => set({ skillRoot: e.target.value }) })))),

        h('div', { className: 'av-between' },
          h('span', { className: 'av-desc' }, msg),
          h('button', { className: 'av-btn av-btn-main', disabled: busy, onClick: save },
            busy ? '保存中…' : '保存设置')),
      );
    }

    /* -------------------------------------------------------------- 做一条 -- */

    function MakeBlock({ data, onMade }) {
      const cfg = data && data.config;
      const status = data && data.status;
      const [title, setTitle] = useState('我的第一条成片');
      const [script, setScript] = useState(
        '大家好，这是用自动成片做出来的第一条视频。配音、字幕、配乐都是自动配好的，不需要任何剪辑基础。你可以把文案换成自己的，再点一次按钮。'
      );
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);
      const [preview, setPreview] = useState('');
      const [elapsed, setElapsed] = useState(0);

      useEffect(() => {
        if (!busy) return undefined;
        const start = Date.now();
        const id = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
        return () => clearInterval(id);
      }, [busy]);

      const run = () => {
        setBusy(true);
        setResult(null);
        setPreview('');
        setElapsed(0);
        post('make', { title, script, voice: cfg && cfg.voice, orientation: cfg && cfg.orientation })
          .then((r) => {
            setBusy(false);
            setResult(r);
            if (r.ok && r.data && r.data.output) setPreview(r.data.output);
            if (r.ok && onMade) onMade();
          })
          .catch((e) => { setBusy(false); setResult({ ok: false, error: String(e) }); });
      };

      const openFolder = (p) => post('open', { path: p || (cfg && cfg.outDir) }).catch(() => {});

      return h(
        'div',
        { className: 'av-card' },
        h('div', { className: 'av-kv' },
          h('span', { className: 'av-name' }, '做一条试试'),
          h('span', { className: 'av-desc' },
            '填个名字和文案就行。中文大概每秒念 4~5 个字，30 秒的片子写 130~150 字。' +
            (status && status.mediaDir && status.mediaDir.exists && status.mediaDir.count
              ? ` 会自动用上素材文件夹里的 ${status.mediaDir.count} 个图片/视频。`
              : ''))),

        h('div', null,
          h('span', { className: 'av-desc' }, '片子叫什么'),
          h('input', { className: 'av-in', value: title, onChange: (e) => setTitle(e.target.value) })),

        h('div', null,
          h('span', { className: 'av-desc' }, '要念的文案'),
          h('textarea', { className: 'av-ta', value: script, onChange: (e) => setScript(e.target.value) })),
        h('span', { className: 'av-count' }, `${script.replace(/\s/g, '').length} 字 · 大约 ${Math.max(1, Math.round(script.replace(/\s/g, '').length / 4.5))} 秒`),

        h('div', { className: 'av-between' },
          h('span', { className: 'av-desc' }, busy ? `正在合成…… 已经等了 ${elapsed} 秒` : '合成大约十几秒到一分钟，看片长。'),
          h('button', { className: 'av-btn av-btn-main', disabled: busy || !script.trim(), onClick: run },
            busy ? '正在做…' : '做一条试试')),

        result
          ? h('div', { className: `av-note${result.ok ? '' : ' bad'}` },
              result.ok
                ? h('div', { className: 'av-kv' },
                    h('span', null, `做好了：${result.data.durationSeconds} 秒 · ${fmtSize(result.data.sizeBytes)}`),
                    h('span', { className: 'av-val' }, result.data.output),
                    result.data.notes && result.data.notes.length
                      ? h('span', { className: 'av-val' }, '小提示：' + result.data.notes.join('；'))
                      : null)
                : h('pre', { className: 'av-pre' }, result.error || '没成功'))
          : null,

        preview
          ? h('div', { className: 'av-kv' },
              h('video', { className: 'av-video', controls: true, src: fileUrl(preview), preload: 'metadata' }),
              h('div', { className: 'av-between' },
                h('span', { className: 'av-desc' }, '可以直接在这里看，也可以到文件夹里双击播放。'),
                h('div', { className: 'av-choice' },
                  h('button', { className: 'av-btn av-btn-mini', onClick: () => openFolder(preview) }, '在文件夹里显示'),
                  h('button', { className: 'av-btn av-btn-mini', onClick: () => openFolder() }, '打开成片文件夹'))))
          : null,
      );
    }

    /* ------------------------------------------------------------ 成片列表 -- */

    function OutputsBlock({ outputs, outDir, onPlay }) {
      if (!outputs || !outputs.length) {
        return h('div', { className: 'av-card' },
          h('span', { className: 'av-desc' }, `还没有成片。存到：${outDir || '未知'}`));
      }
      return h(
        'div',
        { className: 'av-card' },
        h('span', { className: 'av-desc' }, `已有的成片（存在 ${outDir}）`),
        h('div', { className: 'av-list' },
          outputs.slice(0, 10).map((o) =>
            h('div', { className: 'av-item', key: o.path },
              h('div', { className: 'av-kv' },
                h('b', null, o.name),
                h('span', { className: 'av-meta' }, `${fmtSize(o.size)} · ${fmtTime(o.modified)}`)),
              h('button', { className: 'av-btn av-btn-mini', onClick: () => onPlay(o.path) }, '播放')))),
      );
    }

    /* ------------------------------------------------------------ 交流群 -- */

    function GroupBlock({ qq }) {
      if (!qq) return null;
      return h(
        'div',
        { className: 'av-card' },
        h('div', { className: 'av-kv' },
          h('span', { className: 'av-name' }, '加入 QQ 交流群'),
          h('span', { className: 'av-desc' }, '遇到问题、想提需求、想看看别人怎么用，都欢迎进群。')),

        h('div', { className: 'av-group' },
          h('img', {
            className: 'av-qr',
            src: `${API}/qrcode`,
            alt: `QQ 交流群二维码：${qq.name}`,
            loading: 'lazy',
          }),
          h('div', { className: 'av-group-side' },
            h('span', { className: 'av-group-name' }, qq.name),
            qq.number ? h('span', { className: 'av-desc' }, `群号：${qq.number}`) : null,
            h('span', { className: 'av-desc' }, '手机 QQ 扫左边二维码；在电脑上就直接点下面的按钮。'),
            h('a', {
              className: 'av-btn av-btn-main',
              href: qq.link,
              target: '_blank',
              rel: 'noopener noreferrer',
            }, `点击链接加入群聊【${qq.name}】`),
            h('span', { className: 'av-desc' }, '按钮点不开也没关系：打开 QQ 搜上面的群号一样能找到。'))),
      );
    }

    /* ---------------------------------------------------------------- 主体 -- */

    function App() {
      const [data, setData] = useState(null);
      const [outputs, setOutputs] = useState([]);
      const [outDir, setOutDir] = useState('');
      const [err, setErr] = useState('');
      const [tick, setTick] = useState(0);
      const [playing, setPlaying] = useState('');

      const reload = useCallback(() => setTick((n) => n + 1), []);

      useEffect(() => {
        let alive = true;
        get('status')
          .then((r) => { if (alive) { setData(r); setErr(''); } })
          .catch((e) => { if (alive) setErr(String(e)); });
        get('outputs')
          .then((r) => { if (alive && r && r.ok) { setOutputs(r.outputs); setOutDir(r.outDir); } })
          .catch(() => {});
        return () => { alive = false; };
      }, [tick]);

      return h(
        'div',
        { className: 'av-wrap' },
        h('style', null, CSS),
        h('p', { className: 'av-h' }, '自动成片'),
        h('p', { className: 'av-desc' }, '给我一段文案，直接给你一个 mp4：自动配音、自动字幕、自动配乐、自动把图片和视频拼起来。'),

        err ? h('div', { className: 'av-note bad' }, `连不上插件后台：${err}`) : null,

        h(HealthCard, { data, onReload: reload }),
        h(SetupBlock, { data, onDone: reload }),
        h(SettingsBlock, { cfg: data && data.config, status: data && data.status, onSaved: (r) => setData(r) }),
        h(MakeBlock, { data, onMade: reload }),

        playing
          ? h('div', { className: 'av-card' },
              h('span', { className: 'av-name' }, '正在播放'),
              h('video', { className: 'av-video', controls: true, autoPlay: true, src: fileUrl(playing) }),
              h('button', { className: 'av-btn av-btn-mini', onClick: () => setPlaying('') }, '收起'))
          : null,

        h(OutputsBlock, { outputs, outDir, onPlay: setPlaying }),

        h(GroupBlock, { qq: data && data.status && data.status.qqGroup }),

        h('p', { className: 'av-desc' },
          '说明：全部在本机用 ffmpeg 合成，不经过剪映，也不上传任何东西。配音用的是微软 edge-tts 的在线语音。'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'auto-video', order: 525, label: () => '自动成片' },
            () => h(App),
          ),
        );
      },
    };
  },
});

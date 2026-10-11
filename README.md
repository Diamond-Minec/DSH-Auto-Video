# DSH Auto Video

**Give it a script. Get back an MP4.**

An [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that turns plain text
into a finished video — voiceover, frame-accurate subtitles, background music and your own
photos or clips, all assembled and encoded **locally with ffmpeg**.

No video editor. No cloud upload. No editing skills.

[中文说明](README.zh.md) · [Changelog](CHANGELOG.md) · [MIT License](LICENSE)

---

## Why this exists

The original plan was to drive **剪映 / JianYing** (CapCut CN) by generating draft projects.
That route is a dead end, and the evidence is concrete:

- The upstream library's own docs state: *"JianYing 6+ encrypts `draft_content.json`, so
  these features only support JianYing 5.9 and below."*
- On a real **JianYing 7.9.0.12811** install, the draft files are genuine ciphertext —
  base64-decoded, and gzip / zlib / brotli all fail.
- A draft generator that emits **plaintext** JSON therefore produces drafts JianYing never
  shows and cannot export. Game over, regardless of code quality.

So this plugin drops the editor entirely and **encodes the video itself**. That turned out
to be strictly better: no version coupling, no encryption format, no waiting for an app to
rescan a folder — the output is a playable MP4 the moment it finishes.

## How it works

```
script text
 ├─ split into short sentences on punctuation
 ├─ edge-tts each sentence  → measure each clip's duration   ← why subtitles land exactly on the voice
 ├─ accumulate a timeline   → emit SRT
 ├─ visuals: given photos/clips → letterboxed to a common size, shown in order
 │           none given        → animated gradient background + title
 ├─ background music (local file, or JianYing's cloud library)
 └─ ffmpeg: mix audio + burn subtitles + h264/aac → MP4
```

- **Voice**: Microsoft `edge-tts` (online, free, natural). 7 Chinese voices built in.
- **Encoder**: the full ffmpeg 7.1 shipped by `imageio-ffmpeg` (libx264 + libass).
- **Chinese subtitles**: burned with libass using Microsoft YaHei — verified visually.

## Install

This plugin is installed from a **local folder or a git checkout**, not from npm
(`"private": true`).

```
DSH → Settings → Plugins → install local directory → <this folder>
```

Then open **Settings → 自动成片 (Auto Video)** and click **一键装好运行环境**
("set up the runtime") once. That creates a private Python venv and installs two packages
(`edge-tts`, `imageio-ffmpeg`) — about 40 MB, no system changes.

## What you get in the settings page

Everything is written in plain language, not jargon:

- **Status card** — runtime / ffmpeg / voice+subtitle components / output folder, each with
  a green-amber-red dot and a human explanation
- **Voice** — 女声·温柔自然 (recommended) / 女声·活泼年轻 / 男声·清亮年轻 / 男声·沉稳解说 /
  男声·新闻播报 / 东北口音 / 陕西口音
- **Orientation** — landscape 1920×1080 or portrait 1080×1920
- **Music volume** — slider, with the note "60% is about right when someone is talking"
- **Subtitle size** — slider; 0 means automatic
- **Burn subtitles in** — toggle
- **Media folder** — drop your photos and clips here; they get used automatically in
  filename order
- **Default background music** — leave empty for no music
- **Try one** — type a name and a script, get a video, **play it right there in the page**
- **Recent videos** — list with playback and "show in folder"
- All the technical knobs live under a collapsed *Advanced* section

## For the agent

The plugin injects a system-prompt section teaching the agent how to produce a video in one
command. If `@deepseek-ai/dsh-tools` resolves, it also registers two model-visible tools:
`autovideo_environment` and `autovideo_make`.

Command-line equivalent:

```bash
python py/auto_video.py --json request.json
```

### Request fields

| Field | Meaning |
|---|---|
| `script` | **required** — the text to narrate |
| `title` | video name, also the filename |
| `voice` | e.g. `zh-CN-XiaoxiaoNeural` (default) |
| `orientation` | `landscape` 1920×1080 or `portrait` 1080×1920 |
| `media` | array of **absolute paths** to images/videos |
| `bgm` / `bgmQuery` | local music file / JianYing cloud library id or keyword |
| `bgmVolume` | music level 0–1, default 0.6 |
| `subtitleFontSize` | pixels; 0 = automatic |
| `burnSubtitles` | default `true` |
| `outDir` | where the MP4 goes |

## Verified on a real machine

Every item below was confirmed by extracting frames and checking the streams — not by
assuming a file existing means it plays.

| Check | Result |
|---|---|
| Script only, no media | 15.08 s / 2.2 MB / 1920×1080 |
| Media + cloud music | 18.0 s / 4.96 MB; cloud track downloaded as `.m4a` and mixed |
| Demo video | 55.61 s / 11.28 MB, 4 assets in sequence, cloud music |
| Audio actually present | `mean_volume -19.4 dB / max_volume -4.2 dB` |
| Streams | h264 High + aac LC 44.1 kHz stereo |
| Chinese subtitles | visually confirmed, switching correctly over time |
| Chinese title | visually confirmed (`drawtext`) |
| Aspect handling | 16:9 fills the frame; odd ratios get letterboxed |
| `node tools/smoke.mjs --make` | 27 checks pass, incl. Range 206 preview and 403 on paths outside the output folder |

## Develop

No build step, no dependencies to install for development:

```bash
node tools/verify.mjs        # static checks: syntax, manifest invariants, engineering rules
node tools/smoke.mjs         # simulate the Host: load the plugin, exercise every route
node tools/smoke.mjs --make   # ...and actually produce a video (needs the runtime)
```

`tools/verify.mjs` needs nothing but Node. It is the same check CI runs and covers the two
rules that matter most in this environment:

1. **No static `@deepseek-ai/*` import.** A profile-installed plugin cannot resolve those
   packages, so a static import fails at load with `ERR_MODULE_NOT_FOUND`.
2. **Never export `Config`.** It requires `schemastery`, which is equally unresolvable.
   Configuration is normalised by hand instead.

## Repository layout

```
DSH-Auto-Video/
├─ package.json          dsh.bundle.patch + dsh.client declarations
├─ cordis.patch.yml      one insert row; every default is documented in Chinese comments
├─ index.js              Host half: routes, prompt section, optional tools
├─ client.js             Browser half: settings page with inline playback
├─ icon.svg  locale/{zh,en}.json
├─ py/
│  ├─ auto_video.py      the pipeline
│  ├─ check.py           environment self-check (prints READY=yes|no)
│  └─ setup.py           create venv + install edge-tts and imageio-ffmpeg
└─ tools/
   ├─ verify.mjs         static verification (CI)
   └─ smoke.mjs          Host simulation
```

The npm package name is `dsh-plugin-auto-video`, following the `dsh-plugin-*` convention
used by other DSH plugins. The repository is called `DSH-Auto-Video`.

## Known limits

- Voiceover uses Microsoft's **online** edge-tts service — you need a network connection.
- Cloud music relies on JianYing's private API; if upstream changes it, that feature breaks.
  Use a local music file instead.
- With no media supplied you get a gradient background plus a title, which suits talking-head
  or news-style content. For richer visuals, supply your own images or clips.

## Community

Questions, bug reports, feature ideas — or just curious what other people are making with it?

<img src="assets/qq-group.png" alt="DSH QQ group QR code" width="220">

**QQ group — [点击链接加入群聊【DSH交流群？！？！】](https://qm.qq.com/q/wGtYMp17S8)**
(group number `1022445657`)

Scan the QR code with mobile QQ, or just click the link on desktop.
The same card lives at the bottom of the plugin's settings page.

## License

[MIT](LICENSE)

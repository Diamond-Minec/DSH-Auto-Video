# Changelog

本项目的所有重要改动都记录在这里。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-10-11

首个可用版本。

### 新增

- **合成管线**（`py/auto_video.py`）：
  - 文案按标点自动切句，逐句 `edge-tts` 合成并测量时长
  - 由累积时间轴生成 SRT，字幕与人声精确对齐
  - 画面组装：图片/视频等比裁切到统一尺寸后依次出现；无素材时使用动态渐变背景 + 标题
  - `gradients` 滤镜失败时自动回退纯色背景，保证一定能出片
  - 背景音乐支持本地文件与剪映云曲库（`CloudManager.download_asset`），带音量控制与结尾淡出
  - ffmpeg 混音（`amix normalize=0`，不会把人声减半）+ libass 烧录中文字幕 + h264/aac 输出
  - 沿用技能包的 `{"ok","code","reason","data"}` JSON 契约，并把库的 stdout 噪声隔离到 stderr

- **插件宿主半边**（`index.js`）：
  - 同源路由 `/autovideo/api/*`：`status`、`config`、`outputs`、`media`、`setup`、`make`、`file`、`open`
  - `file` 路由支持 Range 请求（可拖动进度条预览），并限制只能读成片目录内的文件
  - 注入系统提示词段，告诉 agent 一行命令出片
  - 可选注册 `autovideo_environment`、`autovideo_make` 两个模型可见工具（拿不到 `dsh-tools` 时优雅降级）
  - 配置来源优先级：内置默认值 < 组合包 patch < 设置页保存的文件

- **插件浏览器半边**（`client.js`）：挂载到 `settings.section` 的设置页
  - 环境状态卡（绿/黄/红点 + 人话解释）
  - 一键安装运行环境，带实时进度
  - 大白话的默认设置：声音、横竖屏、配乐音量、字幕大小、是否烧录、素材文件夹
  - 「做一条试试」并**在页面内直接播放**成片
  - 最近成片列表，可播放与「在文件夹里显示」
  - **加入 QQ 交流群**卡片：群二维码 + 群名 + 群号 + 一键入群链接

- **交流群入口**：
  - 二维码随插件出货（`assets/qq-group.png`），由 `/autovideo/api/qrcode` 以同源方式提供
    （浏览器读不了本地文件路径）
  - 群名、群号、入群链接定义在 `index.js` 的 `QQ_GROUP` 常量里，随 `status` 响应下发给设置页
  - 两个 README 里也带上了同一张卡片

- **验证工具**：
  - `tools/verify.mjs` —— 零依赖静态自检（JSON/JS/Python 语法、manifest 不变量、工程约束、仓库卫生、二维码素材）
  - `tools/render.mjs` —— 用最小渲染器把 `client.js` 真正执行一遍，递归求值函数组件并断言
    设置页渲染出了二维码、群名、群号与入群链接（不需要浏览器，可进 CI）
  - `tools/smoke.mjs` —— 模拟 Cordis `ctx` 跑通 `apply()` 与全部路由，`--make` 可真出一条成片
  - `.github/workflows/ci.yml` —— 每次推送依次跑上面三个

### 说明

- 本插件**不依赖剪映**。原「生成剪映草稿」方案因剪映 6+ 草稿加密而不可行，
  详见 [README 的「为什么要这样做」](README.zh.md#为什么要这样做)。
- 运行时零 `@deepseek-ai/*` 依赖，也不导出 `Config`（两者在本环境都解析不到）。

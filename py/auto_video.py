#!/usr/bin/env python
"""自动成片：edge-tts 配音 + ffmpeg 合成 → 直接出 mp4，**完全不依赖剪映**。

为什么走这条路：剪映 6+ 起对草稿文件加密，明文档稿它读不了（实测 7.9 的
draft_content.json / draft_meta_info.json 都是密文）。所以绕开剪映，自己用
ffmpeg 合成，最后直接拿到成片。

流程：
  1. 文案按标点切成短句
  2. 逐句 edge-tts 合成 → 量每句时长 → 拼成整条旁白（句间留停顿）
  3. 由累积时长生成 SRT（所以字幕和人声是精确对齐的）
  4. 画面：给了素材就拼素材（图片/视频自动裁切填满），没给就生成渐变背景 + 标题
  5. 背景音乐（本地文件或剪映云端曲库）
  6. 混音 + 烧录字幕 + h264/aac 出片

契约（沿用技能包规则）：{"ok": bool, "code": str, "reason": str, "data": {...}}
"""

import argparse
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import traceback

_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr  # 库/ffmpeg 的噪声不许污染最终 JSON

FPS = 30
SR = 44100
PAUSE_BETWEEN_SENTENCES = 0.18
SENTENCE_ENDERS = "。！？!?；;…"
CLAUSE_BREAKS = "，,、：:"
MAX_SUBTITLE_CHARS = 18


# --------------------------------------------------------------------- 基础 ---

def say(msg):
    print(msg, flush=True)


def run(cmd, cwd=None, timeout=1800):
    """跑一个子进程，返回 (returncode, stdout, stderr)。"""
    try:
        proc = subprocess.run(
            [str(c) for c in cmd],
            cwd=cwd,
            capture_output=True,
            timeout=timeout,
            errors="ignore",
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except subprocess.TimeoutExpired:
        return -2, "", "timeout"
    except OSError as exc:
        return 127, "", str(exc)


def probe_duration(ffmpeg, path):
    """用 ffmpeg -i 的 stderr 拿时长（秒）。没有 ffprobe，这样最稳。"""
    _, _, err = run([ffmpeg, "-hide_banner", "-i", path])
    match = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", err)
    if not match:
        return 0.0
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def find_ffmpeg():
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.exists(exe):
            return exe
    except Exception:
        pass
    found = shutil.which("ffmpeg")
    if found:
        return found
    raise RuntimeError(
        "找不到 ffmpeg。请在运行环境里执行：python -m pip install imageio-ffmpeg"
    )


def hhmmss(seconds):
    if seconds < 0:
        seconds = 0
    total_ms = int(round(seconds * 1000))
    hours, rem = divmod(total_ms, 3600000)
    minutes, rem = divmod(rem, 60000)
    secs, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


# ----------------------------------------------------------------- 文案切句 ---

def split_script(text, max_chars=MAX_SUBTITLE_CHARS):
    """切成适合做一行字幕的短句。先按句末标点断，再按逗号断，最后硬切。"""
    text = re.sub(r"\s+", "", (text or "").strip())
    if not text:
        return []

    # 1) 按句末标点分段（标点跟着上一段）
    pieces = []
    buffer = ""
    for char in text:
        buffer += char
        if char in SENTENCE_ENDERS:
            pieces.append(buffer)
            buffer = ""
    if buffer.strip():
        pieces.append(buffer)

    # 2) 过长的再按逗号断
    refined = []
    for piece in pieces:
        if len(piece) <= max_chars:
            refined.append(piece)
            continue
        buffer = ""
        for char in piece:
            buffer += char
            if char in CLAUSE_BREAKS and len(buffer) >= 4:
                refined.append(buffer)
                buffer = ""
        if buffer.strip():
            refined.append(buffer)

    # 3) 还超长的硬切
    final = []
    for piece in refined:
        piece = piece.strip()
        while len(piece) > max_chars * 2:
            final.append(piece[: max_chars * 2])
            piece = piece[max_chars * 2 :]
        if piece:
            final.append(piece)
    return [p for p in final if p.strip()]


def build_srt(entries):
    """entries: [(start, end, text)]"""
    lines = []
    for index, (start, end, text) in enumerate(entries, 1):
        lines.append(str(index))
        lines.append(f"{hhmmss(start)} --> {hhmmss(end)}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


# ------------------------------------------------------------------ TTS 部分 ---

async def tts_one(text, voice, rate, out_mp3):
    import edge_tts

    communicate = edge_tts.Communicate(text, voice, rate=rate)
    written = 0
    with open(out_mp3, "wb") as handle:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                handle.write(chunk["data"])
                written += len(chunk["data"])
    return written


def synthesize_sentences(sentences, voice, rate, work, ffmpeg):
    """逐句合成并量时长，返回 [(text, wav_path, duration)]。"""
    results = []
    for index, sentence in enumerate(sentences):
        mp3 = os.path.join(work, f"seg_{index:03d}.mp3")
        wav = os.path.join(work, f"seg_{index:03d}.wav")
        say(f"[tts] {index + 1}/{len(sentences)}  {sentence}")
        try:
            asyncio.run(tts_one(sentence, voice, rate, mp3))
        except Exception as exc:
            raise RuntimeError(f"第 {index + 1} 句合成失败（{type(exc).__name__}: {exc}）") from exc
        if not os.path.exists(mp3) or os.path.getsize(mp3) == 0:
            raise RuntimeError(f"第 {index + 1} 句没有产生音频，检查网络与音色名")

        code, _, err = run([
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", mp3, "-ar", str(SR), "-ac", "2", wav,
        ])
        if code != 0:
            raise RuntimeError(f"第 {index + 1} 句转 wav 失败：{err.strip()[:300]}")
        duration = probe_duration(ffmpeg, wav)
        if duration <= 0:
            raise RuntimeError(f"第 {index + 1} 句时长读不出来")
        results.append((sentence, wav, duration))
    return results


def concat_narration(segments, work, ffmpeg):
    """把逐句 wav 与停顿拼成整条旁白，同时算出每句的起止时间。"""
    silence = os.path.join(work, "silence.wav")
    code, _, err = run([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=stereo",
        "-t", str(PAUSE_BETWEEN_SENTENCES), silence,
    ])
    if code != 0:
        raise RuntimeError(f"生成停顿失败：{err.strip()[:200]}")

    parts = []
    timeline = []
    clock = 0.0
    for index, (text, wav, duration) in enumerate(segments):
        if index > 0:
            parts.append(silence)
            clock += PAUSE_BETWEEN_SENTENCES
        parts.append(wav)
        timeline.append((clock, clock + duration, text))
        clock += duration

    listing = os.path.join(work, "narration.txt")
    with open(listing, "w", encoding="utf-8") as handle:
        for part in parts:
            # concat demuxer 会把反斜杠当转义，Windows 路径必须换成正斜杠
            handle.write("file '" + part.replace("\\", "/").replace("'", "'\\''") + "'\n")

    narration = os.path.join(work, "narration.wav")
    code, _, err = run([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", listing,
        "-ar", str(SR), "-ac", "2", narration,
    ])
    if code != 0:
        raise RuntimeError(f"拼接旁白失败：{err.strip()[:300]}")

    return narration, timeline, probe_duration(ffmpeg, narration)


# ------------------------------------------------------------------ 画面部分 ---

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv", ".wmv"}


def normalize_visual(source, duration, width, height, out, ffmpeg, fps=FPS):
    """把一个图片/视频变成统一规格的片段（等比缩放 + 黑边填充）。"""
    scale = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=0x0d1117,"
        f"setsar=1,fps={fps}"
    )
    ext = os.path.splitext(source)[1].lower()
    if ext in IMAGE_EXT:
        cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
               "-loop", "1", "-t", f"{duration:.3f}", "-i", source]
    elif ext in VIDEO_EXT:
        cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
               "-stream_loop", "-1", "-t", f"{duration:.3f}", "-i", source]
    else:
        return False, f"不认识的素材类型：{source}"
    cmd += ["-an", "-vf", scale, "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "20", "-pix_fmt", "yuv420p", out]
    code, _, err = run(cmd)
    if code != 0:
        return False, err.strip()[:300]
    return True, ""


def build_gradient_background(width, height, duration, title, out, ffmpeg, font_file=""):
    """没有素材时：做一张渐变背景，标题可选。"""
    gradient = (
        f"gradients=s={width}x{height}:c0=0x123a6b:c1=0x0a0f16:"
        f"x0=0:y0=0:x1={width}:y1={height}:d={duration:.3f}:speed=0.01"
    )
    vf = f"setsar=1,fps={FPS}"
    if title and font_file and os.path.exists(font_file):
        safe = title.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’")
        font = font_file.replace("\\", "/").replace(":", "\\:")
        vf += (
            f",drawtext=fontfile='{font}':text='{safe}':"
            f"fontcolor=0xE8F0FF:fontsize={max(28, int(height * 0.055))}:"
            f"x=(w-text_w)/2:y=(h-text_h)/2-40:"
            f"alpha='if(lt(t,0.6),0,if(lt(t,1.4),(t-0.6)/0.8,1))'"
        )
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
           "-f", "lavfi", "-i", gradient, "-vf", vf,
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-pix_fmt", "yuv420p", "-t", f"{duration:.3f}", out]
    code, _, err = run(cmd)
    if code != 0:
        # 渐变滤镜失败就退回纯色，保证一定能出片
        fallback = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", f"color=c=0x0d1117:s={width}x{height}:d={duration:.3f}",
                    "-vf", f"setsar=1,fps={FPS}",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                    "-pix_fmt", "yuv420p", out]
        code2, _, err2 = run(fallback)
        if code2 != 0:
            return False, err.strip()[:200] + " | 纯色兜底也失败: " + err2.strip()[:200]
    return True, ""


def build_visuals(media, duration, width, height, work, ffmpeg, title="", font_file=""):
    """返回 (visuals_path, notes)。"""
    notes = []
    usable = [m for m in (media or []) if os.path.exists(m)]
    for missing in [m for m in (media or []) if not os.path.exists(m)]:
        notes.append(f"素材不存在，已跳过：{missing}")

    if not usable:
        out = os.path.join(work, "visuals.mp4")
        ok, err = build_gradient_background(width, height, duration, title, out, ffmpeg, font_file)
        if not ok:
            raise RuntimeError(f"生成背景失败：{err}")
        notes.append("没有可用素材，已用渐变背景 + 标题。")
        return out, notes

    share = duration / len(usable)
    pieces = []
    for index, source in enumerate(usable):
        piece_duration = share if index < len(usable) - 1 else duration - share * (len(usable) - 1)
        out = os.path.join(work, f"visual_{index:03d}.mp4")
        ok, err = normalize_visual(source, piece_duration, width, height, out, ffmpeg)
        if not ok:
            notes.append(f"素材处理失败已跳过：{os.path.basename(source)} → {err}")
            continue
        pieces.append(out)

    if not pieces:
        out = os.path.join(work, "visuals.mp4")
        ok, err = build_gradient_background(width, height, duration, title, out, ffmpeg, font_file)
        if not ok:
            raise RuntimeError(f"素材全部失败且兜底也失败：{err}")
        notes.append("素材都处理失败，已用渐变背景兜底。")
        return out, notes

    listing = os.path.join(work, "visuals.txt")
    with open(listing, "w", encoding="utf-8") as handle:
        for piece in pieces:
            handle.write("file '" + piece.replace("\\", "/").replace("'", "'\\''") + "'\n")
    out = os.path.join(work, "visuals.mp4")
    code, _, err = run([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", out,
    ])
    if code != 0:
        raise RuntimeError(f"拼接画面失败：{err.strip()[:300]}")
    return out, notes


# ------------------------------------------------------------------ 背景音乐 ---

def resolve_bgm(request, work, skill_root):
    """返回 (bgm_path, note)。支持本地文件与剪映云端曲库。"""
    local = str(request.get("bgm") or "").strip()
    if local:
        if os.path.exists(local):
            return local, ""
        return "", f"本地音乐不存在，已忽略：{local}"

    query = str(request.get("bgmQuery") or "").strip()
    if not query:
        return "", ""
    if not skill_root:
        return "", "指定了云端音乐但找不到剪映工具包，已忽略配乐"
    try:
        if skill_root not in sys.path:
            sys.path.insert(0, os.path.join(skill_root, "scripts"))
        from cloud_manager import CloudManager  # type: ignore

        path = CloudManager().download_asset(query)
        if path and os.path.exists(path):
            return path, f"云端音乐已下载：{os.path.basename(path)}"
        return "", f"云端音乐没找到：{query}"
    except Exception as exc:
        return "", f"云端音乐获取失败（{type(exc).__name__}: {exc}），已忽略配乐"


def prepare_bgm(bgm_path, duration, volume, work, ffmpeg):
    out = os.path.join(work, "bgm.wav")
    fade_start = max(0.0, duration - 3.0)
    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-stream_loop", "-1", "-i", bgm_path, "-t", f"{duration:.3f}",
        "-af", f"volume={volume},afade=t=out:st={fade_start:.3f}:d=3",
        "-ar", str(SR), "-ac", "2", out,
    ]
    code, _, err = run(cmd)
    if code != 0:
        return "", err.strip()[:300]
    return out, ""


# -------------------------------------------------------------------- 主流程 ---

def subtitle_style(font_size):
    return (
        "FontName=Microsoft YaHei,"
        f"FontSize={font_size},"
        "PrimaryColour=&H00FFFFFF,"
        "OutlineColour=&H00101010,"
        "BackColour=&H80000000,"
        "BorderStyle=1,Outline=2,Shadow=0,"
        "Alignment=2,MarginV=48"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", dest="json_path", default="")
    parser.add_argument("--out", dest="out_path", default="")
    args = parser.parse_args()

    def emit(payload):
        text = json.dumps(payload, ensure_ascii=False, indent=2)
        if args.out_path:
            with open(args.out_path, "w", encoding="utf-8") as handle:
                handle.write(text)
        _REAL_STDOUT.write(text + "\n")
        _REAL_STDOUT.flush()

    try:
        raw = open(args.json_path, encoding="utf-8").read() if args.json_path else sys.stdin.read()
        request = json.loads(raw or "{}")
    except Exception as exc:
        emit({"ok": False, "code": "bad-request", "reason": f"请求不是合法 JSON：{exc}", "data": {}})
        return 2

    script = str(request.get("script") or request.get("text") or "").strip()
    if not script:
        emit({"ok": False, "code": "no-script", "reason": "没有给文案（script 字段）", "data": {}})
        return 2

    voice = str(request.get("voice") or "zh-CN-XiaoxiaoNeural").strip()
    rate = str(request.get("rate") or "+0%").strip()
    orientation = str(request.get("orientation") or "landscape").strip().lower()
    width, height = (1080, 1920) if orientation == "portrait" else (1920, 1080)
    width = int(request.get("width") or width)
    height = int(request.get("height") or height)

    title = str(request.get("title") or "").strip()
    media = request.get("media") or []
    if isinstance(media, str):
        media = [media]
    try:
        bgm_volume = float(request.get("bgmVolume", 0.6))
    except (TypeError, ValueError):
        bgm_volume = 0.6
    bgm_volume = min(1.0, max(0.0, bgm_volume))
    font_size = int(request.get("subtitleFontSize") or max(16, int(height * 0.030)))
    burn = request.get("burnSubtitles", True) is not False

    skill_root = str(request.get("skillRoot") or "").strip()
    work = str(request.get("workDir") or "").strip()
    if not work:
        import tempfile

        work = tempfile.mkdtemp(prefix="autovideo-")
    os.makedirs(work, exist_ok=True)

    out_mp4 = str(request.get("outPath") or "").strip()
    if not out_mp4:
        out_dir = str(request.get("outDir") or "").strip() or os.path.join(work, "out")
        os.makedirs(out_dir, exist_ok=True)
        safe_title = re.sub(r'[\\/:*?"<>|]+', "_", title or "成片")[:60] or "成片"
        out_mp4 = os.path.join(out_dir, f"{safe_title}.mp4")

    notes = []
    try:
        ffmpeg = find_ffmpeg()
        say(f"[ffmpeg] {ffmpeg}")

        sentences = split_script(script)
        if not sentences:
            raise RuntimeError("文案切句后为空")
        say(f"[plan] 共 {len(sentences)} 句，目标 {width}x{height}")

        segments = synthesize_sentences(sentences, voice, rate, work, ffmpeg)
        narration, timeline, narration_duration = concat_narration(segments, work, ffmpeg)
        say(f"[audio] 旁白时长 {narration_duration:.2f}s")

        srt_text = build_srt(timeline)
        srt_path = os.path.join(work, "subtitle.srt")
        with open(srt_path, "w", encoding="utf-8") as handle:
            handle.write(srt_text)

        font_file = ""
        for candidate in (
            r"C:\Windows\Fonts\msyh.ttc",
            r"C:\Windows\Fonts\msyhbd.ttc",
            r"C:\Windows\Fonts\simhei.ttf",
        ):
            if os.path.exists(candidate):
                font_file = candidate
                break

        visuals, visual_notes = build_visuals(
            media, narration_duration, width, height, work, ffmpeg, title, font_file
        )
        notes.extend(visual_notes)

        bgm_path, bgm_note = resolve_bgm(request, work, skill_root)
        if bgm_note:
            notes.append(bgm_note)

        # ---- 最终合成 ----
        cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
               "-i", visuals, "-i", narration]
        filters = []
        if burn:
            filters.append(
                f"[0:v]subtitles=subtitle.srt:force_style='{subtitle_style(font_size)}'[v]"
            )
        else:
            filters.append("[0:v]null[v]")

        if bgm_path:
            bgm_wav, err = prepare_bgm(bgm_path, narration_duration, bgm_volume, work, ffmpeg)
            if not bgm_wav:
                notes.append(f"配乐处理失败，已忽略：{err}")
                cmd += ["-map", "[v]", "-map", "1:a"]
                filters.append("[1:a]volume=1.0[a]")
            else:
                cmd += ["-i", bgm_wav]
                filters.append("[1:a]volume=1.0[a1]")
                filters.append(f"[2:a]volume={bgm_volume}[a2]")
                filters.append("[a1][a2]amix=inputs=2:duration=first:normalize=0[a]")
        else:
            filters.append("[1:a]volume=1.0[a]")

        cmd += [
            "-filter_complex", ";".join(filters),
            "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-r", str(FPS),
            "-c:a", "aac", "-b:a", "192k", "-ar", str(SR), "-ac", "2",
            "-movflags", "+faststart",
            "-t", f"{narration_duration:.3f}",
            out_mp4,
        ]
        # subtitles 滤镜里的 srt 用相对路径，避免 Windows 盘符转义踩坑
        code, _, err = run(cmd, cwd=work)
        if code != 0:
            raise RuntimeError(f"最终合成失败：{err.strip()[:600]}")

        if not os.path.exists(out_mp4) or os.path.getsize(out_mp4) == 0:
            raise RuntimeError("最终合成没有产出文件")

        final_duration = probe_duration(ffmpeg, out_mp4)
        emit({
            "ok": True,
            "code": "ok",
            "reason": "",
            "data": {
                "output": out_mp4,
                "sizeBytes": os.path.getsize(out_mp4),
                "durationSeconds": round(final_duration, 2),
                "width": width,
                "height": height,
                "sentences": len(sentences),
                "voice": voice,
                "bgm": bool(bgm_path),
                "subtitlesBurned": bool(burn),
                "workDir": work,
                "srt": srt_path,
                "notes": notes,
            },
        })
        return 0
    except Exception as exc:
        traceback.print_exc()
        emit({"ok": False, "code": "failed", "reason": f"{type(exc).__name__}: {exc}",
              "data": {"workDir": work, "notes": notes}})
        return 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python
"""自动成片的运行环境自检。

打印机器可读的行，最后两行是结论：
    MISSING=<逗号列表 或 NONE>
    READY=yes|no
"""

import importlib
import os
import subprocess
import sys

REQUIRED = ["edge_tts", "imageio_ffmpeg"]

print("PYTHON=%s" % sys.version.split()[0])
print("PREFIX=%s" % sys.prefix)

missing = []
for name in REQUIRED:
    try:
        mod = importlib.import_module(name)
        print("PKG=%s=%s" % (name, getattr(mod, "__version__", "?")))
    except Exception as exc:
        print("PKG=%s=MISSING:%s" % (name, type(exc).__name__))
        missing.append(name)

# ffmpeg：优先用 imageio-ffmpeg 自带的完整二进制
ffmpeg = ""
try:
    import imageio_ffmpeg

    candidate = imageio_ffmpeg.get_ffmpeg_exe()
    if candidate and os.path.exists(candidate):
        ffmpeg = candidate
except Exception:
    pass
if not ffmpeg:
    import shutil

    ffmpeg = shutil.which("ffmpeg") or ""

if not ffmpeg:
    print("FFMPEG=MISSING")
    if "imageio_ffmpeg" not in missing:
        missing.append("ffmpeg")
else:
    print("FFMPEG=%s" % ffmpeg)
    try:
        out = subprocess.run(
            [ffmpeg, "-version"], capture_output=True, text=True, errors="ignore", timeout=30
        ).stdout
        version = out.splitlines()[0].split("version")[1].split()[0] if "version" in out else "?"
        print("FFMPEG_VERSION=%s" % version)
        encoders = subprocess.run(
            [ffmpeg, "-hide_banner", "-encoders"],
            capture_output=True, text=True, errors="ignore", timeout=60,
        ).stdout
        print("HAS_X264=%s" % ("yes" if "libx264" in encoders else "no"))
    except Exception as exc:
        print("FFMPEG_VERSION=ERR:%s" % type(exc).__name__)

print("MISSING=%s" % (",".join(missing) if missing else "NONE"))
print("READY=%s" % ("yes" if not missing else "no"))

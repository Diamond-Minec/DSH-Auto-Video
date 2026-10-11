#!/usr/bin/env python
"""给自动成片准备运行环境：建 venv 并装 edge-tts + imageio-ffmpeg。

必须用**基础解释器**启动（不是 venv 自己的 python）。进度实时 flush，方便设置页显示。

    python setup.py --venv <venvDir> [--mirror <pip镜像>]
"""

import argparse
import os
import subprocess
import sys

PACKAGES = ["edge-tts", "imageio-ffmpeg"]


def say(message: str) -> None:
    print(message, flush=True)


def run(cmd) -> int:
    say("$ " + " ".join(str(c) for c in cmd))
    try:
        return subprocess.call([str(c) for c in cmd])
    except OSError as exc:
        say("[ERROR] 启动失败: %s" % exc)
        return 127


def base_python() -> str:
    if sys.prefix != getattr(sys, "base_prefix", sys.prefix):
        candidate = getattr(sys, "_base_executable", "") or ""
        if candidate and os.path.exists(candidate):
            return candidate
    return sys.executable


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--venv", required=True)
    parser.add_argument("--mirror", default="")
    args = parser.parse_args()

    venv_dir = os.path.abspath(args.venv)
    say("基础 Python: %s (%s)" % (base_python(), sys.version.split()[0]))
    say("运行环境目录: %s" % venv_dir)

    venv_py = os.path.join(venv_dir, "Scripts", "python.exe")
    if os.path.exists(venv_py):
        say("[OK] 运行环境已存在，直接复用")
    else:
        say("创建运行环境…")
        code = run([base_python(), "-m", "venv", venv_dir])
        if code != 0 or not os.path.exists(venv_py):
            say("[ERROR] 创建运行环境失败（退出码 %s）" % code)
            return 1
        say("[OK] 运行环境已创建")

    say("升级 pip…")
    run([venv_py, "-m", "pip", "install", "--upgrade", "pip", "--quiet", "--retries", "5", "--timeout", "60"])

    say("安装依赖：%s" % " ".join(PACKAGES))
    code = run([venv_py, "-m", "pip", "install"] + PACKAGES + ["--retries", "5", "--timeout", "90"])
    if code != 0 and args.mirror:
        say("默认源失败，改用镜像源重试…")
        code = run([venv_py, "-m", "pip", "install"] + PACKAGES
                   + ["--retries", "5", "--timeout", "90", "--index-url", args.mirror])
    if code != 0:
        say("[ERROR] 依赖安装失败（退出码 %s）" % code)
        return 1
    say("[OK] 依赖安装完成")

    say("")
    say("全部完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

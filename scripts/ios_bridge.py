#!/usr/bin/env python3
"""iOS 通道：macOS iPhone 镜像 + phone-harness 后台驱动。

必须在 phone-harness 的 Python 里跑（它带 Quartz / Vision / phone_harness）：

    PY="$(uv tool dir)/phone-harness/bin/python"
    $PY scripts/ios_bridge.py state
    $PY scripts/ios_bridge.py text
    $PY scripts/ios_bridge.py tap 我的
    $PY scripts/ios_bridge.py longtap 一键登录 --duration 0.9
    $PY scripts/ios_bridge.py shot /tmp/a.png
    $PY scripts/ios_bridge.py home

与 android 通道的差别：这里没有 AX、没有 CDP，只有「截图 + Vision OCR + 坐标点击」。
"""
import json
import subprocess
import sys
import tempfile
import time

import Quartz
import Vision
from AppKit import NSRunningApplication
from Foundation import NSURL

BUNDLE_ID = "com.apple.ScreenContinuity"
LANGS = ["zh-Hans", "en-US"]

_LAST_WIN = None


def pid():
    apps = NSRunningApplication.runningApplicationsWithBundleIdentifier_(BUNDLE_ID)
    return apps[0].processIdentifier() if apps else None


def window(retries=6):
    """镜像窗口：同进程、layer 0、优先 name == owner name 的那个。"""
    global _LAST_WIN
    p = pid()
    if p is None:
        return None
    for _ in range(retries):
        wins = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID) or []
        cands = [w for w in wins if w.get("kCGWindowOwnerPID") == p and w.get("kCGWindowLayer", 1) == 0]
        named = [w for w in cands if w.get("kCGWindowName") == w.get("kCGWindowOwnerName")]
        pick = named or cands
        if pick:
            b = pick[0]["kCGWindowBounds"]
            # 优先名字里带「iPhone镜像」的窗口，避免选中「欢迎使用」浮窗
            for w in pick:
                if "镜像" in (w.get("kCGWindowName") or ""):
                    b = w["kCGWindowBounds"]
                    pick = [w]
                    break
            _LAST_WIN = {"id": int(pick[0]["kCGWindowNumber"]), "x": b["X"], "y": b["Y"], "w": b["Width"], "h": b["Height"]}
            return _LAST_WIN
        time.sleep(0.25)
    return _LAST_WIN


def _bg():
    from phone_harness import background

    return background


def capture(path=None):
    """按窗口 id 取图，窗口在别的 App 后面也行。"""
    path = path or tempfile.mktemp(prefix="ios-", suffix=".png")
    try:
        got, w = _bg().capture(path)
        return got, w
    except Exception:
        w = window()
        if w is None:
            raise RuntimeError("没有镜像窗口：先打开 iPhone 镜像并连上")
        subprocess.run(["screencapture", "-x", "-o", "-l", str(w["id"]), path], check=True)
        return path, w


def ocr(path, win, langs=None):
    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(path), None)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setRecognitionLanguages_(langs or LANGS)
    ok, err = handler.performRequests_error_([req], None)
    if not ok:
        raise RuntimeError(f"Vision OCR 失败：{err}")

    src = Quartz.CGImageSourceCreateWithURL(NSURL.fileURLWithPath_(path), None)
    props = Quartz.CGImageSourceCopyPropertiesAtIndex(src, 0, None)
    iw, ih = int(props["PixelWidth"]), int(props["PixelHeight"])
    sx, sy = win["w"] / iw, win["h"] / ih

    out = []
    for obs in req.results() or []:
        cand = obs.topCandidates_(1)
        if not cand:
            continue
        bb = obs.boundingBox()
        px = bb.origin.x * iw
        py = (1.0 - bb.origin.y - bb.size.height) * ih
        out.append(
            {
                "text": cand[0].string(),
                "conf": float(cand[0].confidence()),
                "x": win["x"] + (px + bb.size.width * iw / 2) * sx,
                "y": win["y"] + (py + bb.size.height * ih / 2) * sy,
            }
        )
    return out


def screen():
    path, win = capture()
    return ocr(path, win)


def _key_window():
    b = _bg()
    p, w = b._ctx()
    b._make_key(p, w["id"])
    time.sleep(0.15)


def tap(x, y, settle=0.4):
    _bg().tap(x, y)
    time.sleep(settle)


def long_press(x, y, duration=0.9):
    """小程序 / H5 里的控件必须按住；短点会被静默丢弃。"""
    _key_window()
    _bg().long_press(x, y, duration=duration)
    time.sleep(0.4)


def find(text, exact=False, elements=None):
    els = elements if elements is not None else screen()
    return [e for e in els if (e["text"].strip() == text if exact else text in e["text"])]


def cmd_state():
    w = window()
    if not w:
        return {"ok": False, "reason": "没有镜像窗口（iPhone 镜像.app 没开或没连上）"}
    els = screen()
    texts = [e["text"] for e in els]
    blocked = any(k in "".join(texts) for k in ("连接中断", "iPhone 使用中", "正在连接", "解锁 iPhone"))
    return {"ok": not blocked, "window": w, "blocked_hint": next((t for t in texts if t in ("连接中断", "iPhone 使用中", "正在连接", "解锁iPhone", "解锁 iPhone")), None), "texts": texts[:20]}


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    cmd = args[0]

    if cmd == "state":
        print(json.dumps(cmd_state(), ensure_ascii=False, indent=2))
    elif cmd == "text":
        print(json.dumps([e["text"] for e in screen()], ensure_ascii=False, indent=2))
    elif cmd == "shot":
        path = args[1] if len(args) > 1 else "/tmp/ios.png"
        p, w = capture(path)
        print(json.dumps({"path": p, "window": w}, ensure_ascii=False))
    elif cmd in ("tap", "longtap"):
        text = args[1]
        dur = 0.9
        if "--duration" in args:
            dur = float(args[args.index("--duration") + 1])
        hits = find(text)
        if not hits:
            print(json.dumps({"ok": False, "reason": f"屏幕上没有 {text!r}"}, ensure_ascii=False))
            return 1
        h = hits[0]
        if cmd == "longtap":
            long_press(h["x"], h["y"], duration=dur)
        else:
            _key_window()
            tap(h["x"], h["y"])
        print(json.dumps({"ok": True, "text": h["text"], "x": round(h["x"]), "y": round(h["y"])}, ensure_ascii=False))
    elif cmd == "home":
        _key_window()
        _bg().press("cmd+1")
        time.sleep(1.0)
        print(json.dumps({"ok": True}))
    elif cmd == "type":
        _key_window()
        _bg().type_text(args[1])
        time.sleep(0.8)
        print(json.dumps({"ok": True}))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

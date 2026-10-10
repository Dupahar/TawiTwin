"""Record one scene of the live site with headless Chrome (DevTools screencast) into an MP4.

A scene is a list of timed steps (seconds from start, JavaScript to run). A fake cursor glides to elements
before clicking and text is typed character by character, so the clip reads like a person using the app.
Viewport 1536x864 at device scale 1.25 -> 1920x1080 frames (UI text stays legible in the video).

Used by scripts/video/make_video.py. Requires Chrome and ffmpeg on PATH.
"""

import base64
import json
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
W, H, SCALE = 1536, 864, 1.25
PORT = 9341

HELPERS = r"""
window.__tt = {
  cursor() {
    let c = document.getElementById('__cur');
    if (!c) {
      c = document.createElement('div'); c.id = '__cur';
      c.style.cssText = 'position:fixed;z-index:99999;width:22px;height:22px;border-radius:50%;pointer-events:none;' +
        'background:rgba(255,255,255,.95);border:3px solid #3987e5;box-shadow:0 0 0 6px rgba(57,135,229,.25);' +
        'left:760px;top:430px;transition:left .7s ease,top .7s ease,transform .15s;transform:translate(-50%,-50%)';
      document.body.appendChild(c);
    }
    return c;
  },
  async moveTo(sel) {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) throw new Error('no element ' + sel);
    el.scrollIntoView({block: 'nearest'});
    const r = el.getBoundingClientRect(), c = this.cursor();
    c.style.left = (r.left + r.width / 2) + 'px'; c.style.top = (r.top + r.height / 2) + 'px';
    await new Promise(res => setTimeout(res, 750));
    return el;
  },
  async click(sel) {
    const el = await this.moveTo(sel), c = this.cursor();
    c.style.transform = 'translate(-50%,-50%) scale(.75)';
    await new Promise(res => setTimeout(res, 150));
    c.style.transform = 'translate(-50%,-50%)';
    el.click();
  },
  async type(sel, text, ms = 55) {
    const el = await this.moveTo(sel); el.focus(); el.value = '';
    for (const ch of text) { el.value += ch; await new Promise(res => setTimeout(res, ms)); }
  },
  hideCursor() { const c = document.getElementById('__cur'); if (c) c.style.opacity = 0; },
  overlay(html, css = '') {
    let o = document.getElementById('__ov');
    if (!o) { o = document.createElement('div'); o.id = '__ov'; document.body.appendChild(o); }
    o.style.cssText = 'position:fixed;z-index:99998;transition:opacity .5s;opacity:0;' + css;
    o.innerHTML = html; requestAnimationFrame(() => (o.style.opacity = 1));
  },
  hideOverlay() { const o = document.getElementById('__ov'); if (o) o.style.opacity = 0; },
};
"""


GPU_FLAGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"]   # hardware WebGL for smooth map video


class Chrome:
    def __init__(self, profile, flags=GPU_FLAGS):
        self.proc = subprocess.Popen(
            [CHROME, *flags, "--headless=new", f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
             f"--window-size={W},{H}", f"--user-data-dir={profile}", "--hide-scrollbars",
             "--autoplay-policy=no-user-gesture-required", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        url = None
        for _ in range(160):
            try:
                tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json").read())
                url = [t for t in tabs if t["type"] == "page"][0]["webSocketDebuggerUrl"]
                break
            except Exception:
                time.sleep(0.25)
        if not url:
            self.proc.kill()
            raise RuntimeError("Chrome did not expose a DevTools page within 40 s")
        self.ws = websocket.create_connection(url, timeout=120, suppress_origin=True)
        self.n = 0
        self.lock = threading.Lock()
        self.pending = {}
        self.frames = []
        self.logs = []
        self.running = True
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        while self.running:
            try:
                m = json.loads(self.ws.recv())
            except Exception:
                break
            if m.get("method") == "Page.screencastFrame":
                p = m["params"]
                self.frames.append((p["metadata"]["timestamp"], base64.b64decode(p["data"])))
                self.send("Page.screencastFrameAck", wait=False, sessionId=p["sessionId"])
            elif m.get("method") == "Runtime.exceptionThrown":
                self.logs.append(json.dumps(m["params"]["exceptionDetails"])[:300])
            elif "id" in m and m["id"] in self.pending:
                self.pending[m["id"]]["result"] = m
                self.pending[m["id"]]["event"].set()

    def send(self, method, wait=True, timeout=120, **params):
        with self.lock:
            self.n += 1
            i = self.n
            ev = threading.Event()
            self.pending[i] = {"event": ev}
            self.ws.send(json.dumps({"id": i, "method": method, "params": params}))
        if not wait:
            return None
        ev.wait(timeout)
        r = self.pending.pop(i).get("result", {})
        if "error" in r:
            raise RuntimeError(f"{method}: {r['error']}")
        return r.get("result", {})

    def js(self, expr, wait_promise=True):
        try:
            r = self.send("Runtime.evaluate", expression=expr, awaitPromise=wait_promise, returnByValue=True)
        except RuntimeError as e:          # e.g. the expression returned a map object that cannot be serialised
            if "reference chain" in str(e):
                return None
            raise
        if r.get("exceptionDetails"):
            self.logs.append(json.dumps(r["exceptionDetails"])[:300])
        return r.get("result", {}).get("value")

    def set_file(self, selector, path):
        doc = self.send("DOM.getDocument", depth=-1)
        node = self.send("DOM.querySelector", nodeId=doc["root"]["nodeId"], selector=selector)["nodeId"]
        self.send("DOM.setFileInputFiles", files=[str(Path(path).resolve())], nodeId=node)
        self.js(f"document.querySelector('{selector}').dispatchEvent(new Event('change', {{bubbles: true}}))")

    def close(self):
        self.running = False
        try:
            self.ws.close()
        finally:
            self.proc.kill()


def record(scene, out_mp4, profile, fps=30):
    """scene = {"url", "setup": js (before recording), "warmup": s, "duration": s, "steps": [(t, js | callable)]}"""
    c = Chrome(profile)
    try:
        for d in ("Page.enable", "Runtime.enable", "DOM.enable"):
            c.send(d)
        c.send("Emulation.setDeviceMetricsOverride", width=W, height=H, deviceScaleFactor=SCALE, mobile=False)
        c.send("Page.addScriptToEvaluateOnNewDocument", source=HELPERS)
        c.send("Page.navigate", url=scene["url"])
        time.sleep(scene.get("warmup", 8))
        if scene.get("setup"):
            c.js(scene["setup"])
            time.sleep(scene.get("settle", 2))
        c.send("Page.startScreencast", format="jpeg", quality=88, maxWidth=int(W * SCALE), maxHeight=int(H * SCALE),
               everyNthFrame=1)
        t0 = time.time()
        for t, step in scene["steps"]:
            while time.time() - t0 < t:
                time.sleep(0.02)
            if callable(step):
                step(c)
            else:
                c.js(f"(async () => {{ {step} }})()", wait_promise=False)
        while time.time() - t0 < scene["duration"]:
            time.sleep(0.05)
        c.send("Page.stopScreencast")
        time.sleep(0.3)
    finally:
        c.close()
    frames = sorted(c.frames, key=lambda f: f[0])
    if not frames:
        raise RuntimeError("no frames captured")
    tmp = Path(out_mp4).with_suffix("")
    tmp.mkdir(parents=True, exist_ok=True)
    start = frames[0][0]
    lines = ["ffconcat version 1.0"]
    for i, (ts, data) in enumerate(frames):
        f = tmp / f"f{i:05d}.jpg"
        f.write_bytes(data)
        nxt = frames[i + 1][0] if i + 1 < len(frames) else start + scene["duration"]
        lines += [f"file '{f.name}'", f"duration {max(nxt - ts, 1 / fps):.4f}"]
    lines.append(f"file 'f{len(frames) - 1:05d}.jpg'")   # concat demuxer needs the last file repeated
    (tmp / "list.ffconcat").write_text("\n".join(lines))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(tmp / "list.ffconcat"),
                    "-vf", f"fps={fps},scale=1920:1080:flags=lanczos,format=yuv420p", "-t", f"{scene['duration']:.2f}",
                    "-c:v", "libx264", "-preset", "medium", "-crf", "18", str(out_mp4)], check=True)
    return {"frames": len(frames), "logs": c.logs}

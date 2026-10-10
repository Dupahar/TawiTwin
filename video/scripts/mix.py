"""Music bed + guide VO for the launch film, timed from src/timeline.json.

Outputs to video/out/: music_bed.wav (ducked under narration windows), vo_guide.wav (the voiceover:
public/audio/vo_el/s{n}.wav from vo_fit.py if present, else the Amazon Polly scratch),
mix_guide.wav (both). Music: Mixkit (free licence) - Silent Descent #871, Sci-Fi Score #726, Tapis #759.
"""
import json, subprocess
from pathlib import Path
import numpy as np

V = Path(__file__).resolve().parents[1]
SR = 48000
tl = json.load(open(V / "src/timeline.json"))
END = tl["end"]
N = int(END * SR)

def load(p):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).copy()

def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9)

def place(buf, clip, at, src_from=0.0, length=None):
    a = int(src_from * SR); clip = clip[a:] if length is None else clip[a:a + int(length * SR)]
    s = int(at * SR)
    if s < 0: clip, s = clip[-s:], 0
    e = min(N, s + len(clip)); buf[s:e] += clip[: e - s]

def env(points):
    """piecewise-linear gain (dB) over the timeline"""
    t = np.arange(N) / SR
    xs, ys = zip(*points)
    return 10 ** (np.interp(t, xs, ys) / 20)

def word(n, w, nth=0):
    hits = [x for x in tl["scenes"][n - 1]["words"] if "".join(c for c in x[2].lower() if c.isalnum()) == w]
    return hits[nth][0]

drop = word(2, "tavi")
a = load(V / "public/audio/mixkit_silent_descent_871.mp3")
b = load(V / "public/audio/mixkit_sci_fi_score_726.mp3")
c = load(V / "public/audio/mixkit_tapis_759.mp3")
# loudness-match the three tracks on their body
for x, sl in ((a, slice(SR * 40, SR * 80)), (b, slice(SR * 20, SR * 80)), (c, slice(SR * 10, SR * 90))):
    x *= 10 ** ((-16 - rms_db(x[sl])) / 20)

B_DROP = 14.5          # the drop inside Sci-Fi Score
b_at = drop - B_DROP   # so it lands on "Tawi Twin"
c_at = tl["scenes"][5]["start"] - 1.0  # Tapis takes over at the control room

m = np.zeros((N, 2), np.float32)
ta = np.zeros((N, 2), np.float32); place(ta, a, 0)
tb = np.zeros((N, 2), np.float32); place(tb, b, b_at)
tc = np.zeros((N, 2), np.float32); place(tc, c, c_at, src_from=2.6)
m += ta[:, :] * env([(0, -6), (b_at, -6), (drop - 0.4, -14), (drop, -60), (END, -60)])[:, None]
m += tb * env([(0, -60), (b_at, -60), (b_at + 0.5, -10), (drop - 0.05, -6), (drop, 0), (c_at, 0), (c_at + 3, -60), (END, -60)])[:, None]
m += tc * env([(0, -60), (c_at, -60), (c_at + 3, 0), (END - 4, 0), (END, -60)])[:, None]

# duck under narration (each spoken sentence window), ramp 0.25 s
pts = [(0, 0.0)]
for s in tl["scenes"]:
    w0, w1 = s["words"][0][0], s["words"][-1][1]
    pts += [(w0 - 0.3, 0.0), (w0, -11.0), (w1, -11.0), (w1 + 0.35, 0.0)]
pts.append((END, 0.0))
m *= env(sorted(pts))[:, None]
m *= 10 ** ((-1.0 - 20 * np.log10(np.abs(m).max() + 1e-9)) / 20)  # peak -1 dBFS

vo = np.zeros((N, 2), np.float32)
for s in tl["scenes"]:
    el = V / f"public/audio/vo_el/s{s['n']}.wav"
    place(vo, load(el if el.exists() else V.parent / f"docs/video/build/audio/s{s['n']}.mp3"), s["start"])
vo *= 10 ** ((-3.0 - 20 * np.log10(np.abs(vo).max() + 1e-9)) / 20)

def save(x, name):
    out = V / "out" / name
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", "2", "-ar", str(SR), "-i", "-", "-c:a", "pcm_s16le", str(out)], input=np.clip(x, -1, 1).astype(np.float32).tobytes(), check=True)
    print("wrote", out.name, f"{len(x)/SR:.2f}s")

save(m, "music_bed.wav")
save(vo, "vo_guide.wav")
mix = m * 0.55 + vo
save(mix * (0.98 / max(1e-9, np.abs(mix).max())), "mix_guide.wav")
print("drop at", drop, "sci-fi starts", round(b_at, 2), "tapis starts", round(c_at, 2))

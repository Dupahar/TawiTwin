"""Fit a recorded voiceover (9 blocks) to the launch film and re-time the picture to it.

1. Each block video/public/audio/vo_el/k{n}.mp3: trim head/tail silence, cap inner pauses at PAUSE s, speed up by TEMPO.
   -> video/public/audio/vo_el/s{n}.wav
2. faster-whisper word times on each fitted block, aligned onto the existing timeline words (the film's cue() names
   stay valid even where whisper spells a word differently this time).
3. New src/timeline.json: same lead-in, gaps between blocks and tail as before. Old one kept as timeline_polly.json.

Run with .scratch/wvenv/Scripts/python -I video/scripts/vo_fit.py
"""
import difflib, json, re, shutil, subprocess
from pathlib import Path
import numpy as np

V = Path(__file__).resolve().parents[1]
VO = V / "public/audio/vo_el"
SR = 48000
PAUSE, TEMPO, FLOOR_DB, MIN_GAP = 0.35, 1.05, -40, 0.12

def load(p):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()

def save(x, p, tempo=1.0):
    af = ["-af", f"atempo={tempo}"] if tempo != 1.0 else []
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", "1", "-ar", str(SR), "-i", "-", *af, "-c:a", "pcm_s16le", str(p)],
                   input=x.astype(np.float32).tobytes(), check=True)

def fit(x):
    """trim + cap pauses; returns tightened mono signal"""
    hop = int(0.01 * SR)
    db = 20 * np.log10(np.sqrt(np.convolve(x ** 2, np.ones(hop) / hop, "same"))[::hop] + 1e-9)
    loud = db > FLOOR_DB
    idx = np.flatnonzero(loud)
    a, b = idx[0], idx[-1] + 1
    out, i, fade = [], a, int(0.01 * SR)
    while i < b:                                  # walk runs of loud / quiet frames
        j = i
        while j < b and loud[j] == loud[i]: j += 1
        seg = x[i * hop:j * hop]
        if not loud[i] and (j - i) * 0.01 > PAUSE:  # long pause: keep its edges, drop the middle
            k = int(PAUSE / 2 * SR)
            seg = np.concatenate([seg[:k], seg[-k:]])
            seg[k - fade:k] *= np.linspace(1, 0, fade); seg[k:k + fade] *= np.linspace(0, 1, fade)
        out.append(seg); i = j
    y = np.concatenate(out)
    pad = np.zeros(int(0.05 * SR), np.float32)    # 50 ms breath at each end
    return np.concatenate([pad, y, pad])

norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())

def align(old, new):
    """old: [[t0,t1,word],...] from the guide read; new: [(t0,t1,word),...] from this read.
    Returns old words with new times; unmatched words interpolated by position."""
    sm = difflib.SequenceMatcher(None, [norm(w[2]) for w in old], [norm(w[2]) for w in new], autojunk=False)
    t = [None] * len(old)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op != "equal": print(f"   {op}: {[w[2] for w in old[i1:i2]]} <- {[w[2] for w in new[j1:j2]]}")
        if op == "equal" or (op == "replace" and i2 - i1 == j2 - j1):
            for k in range(i2 - i1): t[i1 + k] = (new[j1 + k][0], new[j1 + k][1])
        elif op == "replace":                     # n old words <- m new words: spread the span evenly
            s, e = new[j1][0], new[j2 - 1][1]
            for k in range(i2 - i1):
                t[i1 + k] = (s + (e - s) * k / (i2 - i1), s + (e - s) * (k + 1) / (i2 - i1))
    known = [k for k in range(len(old)) if t[k]]
    for k in range(len(old)):
        if t[k] is None:
            p = max([q for q in known if q < k], default=None); n = min([q for q in known if q > k], default=None)
            s = t[p][1] if p is not None else new[0][0]
            e = t[n][0] if n is not None else new[-1][1]
            t[k] = (s, max(s, e))
    matched = sum(1 for op in sm.get_opcodes() if op[0] == "equal" for _ in range(op[2] - op[1]))
    return [[round(a, 2), round(b, 2), w[2]] for (a, b), w in zip(t, old)], matched

if __name__ == "__main__":
    from faster_whisper import WhisperModel
    model = WhisperModel("small.en", device="cpu", compute_type="int8")
    tl_path = V / "src/timeline.json"
    backup = V / "src/timeline_polly.json"
    if not backup.exists(): shutil.copy(tl_path, backup)
    old = json.load(open(backup))
    sc = old["scenes"]
    gaps = [sc[i + 1]["start"] - (sc[i]["start"] + sc[i]["dur"]) for i in range(len(sc) - 1)]
    tail = old["end"] - (sc[-1]["start"] + sc[-1]["dur"])
    t, scenes = sc[0]["start"], []
    for i, s in enumerate(sc):
        n = s["n"]
        raw = load(VO / f"k{n}.mp3")
        out = VO / f"s{n}.wav"
        save(fit(raw), out, TEMPO)
        dur = len(load(out)) / SR
        a16 = np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-i", str(out), "-f", "f32le", "-ac", "1", "-ar", "16000", "-"], capture_output=True, check=True).stdout, np.float32)
        segs, _ = model.transcribe(a16, word_timestamps=True, language="en", beam_size=5)
        new = [(w.start, w.end, w.word.strip()) for sg in segs for w in sg.words]
        rel = [[w[0] - s["start"], w[1] - s["start"], w[2]] for w in s["words"]]
        words, hit = align(rel, new)
        words = [[round(a + t, 2), round(b + t, 2), w] for a, b, w in words]
        scenes.append({"dur": round(dur, 2), "n": n, "start": round(t, 2), "words": words})
        print(f"block {n}: raw {len(raw)/SR:5.1f}s -> {dur:5.1f}s  slot {s['dur']:5.1f}s  matched {hit}/{len(rel)} words")
        t += dur + (gaps[i] if i < len(gaps) else 0)
    end = round(scenes[-1]["start"] + scenes[-1]["dur"] + tail, 2)
    json.dump({"end": end, "scenes": scenes}, open(tl_path, "w"), indent=1)
    print(f"film {old['end']:.2f}s -> {end:.2f}s")

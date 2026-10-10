"""Beat sheet (markdown) + SRT for recording the voiceover to the finished picture."""
import json, re
from pathlib import Path

V = Path(__file__).resolve().parents[1]
tl = json.load(open(V / "src/timeline.json"))
text = json.load(open(V.parent / "docs/video/build/audio/durations.json"))
ts = lambda s: f"{int(s // 60)}:{s % 60:05.2f}"
srt_t = lambda s: f"{int(s // 3600):02d}:{int(s % 3600 // 60):02d}:{int(s % 60):02d},{int(round(s % 1 * 1000)) % 1000:03d}"
picture = {
    1: "Rain → 26 Aug 2025 → 296 mm counter + 24 h gauge → RED 'RECORD.' slam → river cross-section past highest flood level → real riverbed, bridge snaps → 5,000+",
    2: "Paper: lock screen 'No notifications' → 'No list.' (pumps / drains / schools = ???) → collapses to a dot → DROP: dark map, 188k buildings light up from the river, 'Tawi Twin'",
    3: "Date rewinds to 25.08.2025 23:00 → red replay hexes → phone types the Hinglish question → 3 tool calls → camera dives to Bhagwati Nagar → HIGH · 184.7 mm → 3 evidence cards + radar water → hospital/school pins",
    4: "Cursor taps Share → WhatsApp world, alert bubble, forwarded into 12 chats → Hindi / Hinglish / English swap → voice waveform",
    5: "Full city, 188,180 counter → rings around the Tawi (01) → drain-height diagram (02) → radar sweep (03) → 8 news pins → 24.6% vs 36.4% bars → 1.5×",
    6: "Control-room panel slides in: 39 / 12,113 → pumps on map → drains draw in rank order → schools to check",
    7: "Paper: camera phone, shutter, Bedrock vision scan + severity 4/5 → inbox → cursor clicks Assign → Assigned ✓",
    8: "'Runs on AWS.' → architecture builds node by node on each service name → hourly loop on EventBridge → everything collapses into template.yaml",
    9: "Live map, green: 'It's dry today.' → 'every street in Jammu will know before the water does.' → end card",
}
md = ["# Tawi Twin launch film · voiceover beat sheet", "",
      f"Picture length **{ts(tl['end'])}** at 60 fps. Every visual hit is cued to these word times (from the voiceover, via vo_fit.py).",
      "Record each block so it **starts at the IN time**; aim to finish by OUT. Small drift (±0.3 s) is fine; the picture holds a beat at each block end.",
      "Key sync points are in **bold** — land these words on time.", ""]
srt, k = [], 1
KEY = {1: ["296", "record.", "Bridge", "5"], 2: ["street.", "Twin"], 3: ["replay", "Bhagwati", "High", "185", "satellites", "hospital,"], 4: ["tap", "Hindi,", "voice."],
       5: ["188", "river,", "radar", "times"], 6: ["39", "12", "pumps?", "first?"], 7: ["photo.", "Bedrock", "assign."], 8: ["AWS.", "Bedrock.", "Graviton,", "CloudFront.", "SAM"], 9: ["dry", "before", "Twin"]}
for s in tl["scenes"]:
    n, words = s["n"], s["words"]
    md += [f"## {n} · IN {ts(s['start'])} → OUT {ts(words[-1][1])}  ({words[-1][1] - s['start']:.1f} s)", "",
           f"**Picture:** {picture[n]}", "", f"> {text[str(n)]['text']}", ""]
    keys = [f"`{ts(w[0])}` **{w[2]}**" for w in words if w[2] in KEY[n]]
    md += ["Sync: " + " · ".join(keys), ""]
    # captions: sentence chunks
    chunk, start = [], None
    for w in words:
        start = w[0] if start is None else start
        chunk.append(w)
        if re.search(r"[.?!]$", w[2]) or len(chunk) >= 11:
            srt += [str(k), f"{srt_t(start)} --> {srt_t(chunk[-1][1] + 0.15)}", " ".join(x[2] for x in chunk).replace(" ,", ","), ""]
            k += 1; chunk, start = [], None
    if chunk:
        srt += [str(k), f"{srt_t(start)} --> {srt_t(chunk[-1][1] + 0.15)}", " ".join(x[2] for x in chunk), ""]; k += 1
md += ["---", "Captions: `video/out/captions.srt` (timed to the guide read; re-time if your read drifts)."]
(V.parent / "docs/video/launch_beats.md").write_text("\n".join(md), encoding="utf-8")
# Whisper mishearings in the guide transcription
FIX = [("Tavi", "Tawi"), ("trains", "drains"), ("Bridge Gateway,", "Bridge gave way,"), ("in English, will", "in Hinglish: will"),
       ("Hindi, English or Hindi", "Hindi, Hinglish or English"), ("nearest stream,", "nearest drain,"), ("locality's", "localities"),
       ("reads the severity", "rates the severity"), (" -", "-"), (" ,000", ",000"), ("strands agents", "Strands Agents"),
       ("open data", "Open Data"), ("today,", "today?"), ("Tawi twin", "Tawi Twin")]
out = "\n".join(srt)
for a, b in FIX:
    out = out.replace(a, b)
(V / "out/captions.srt").write_text(out, encoding="utf-8")
print("ok", k - 1, "captions")

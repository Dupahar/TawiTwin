"""Make the 3-minute demo video from the live site.

1. narration: docs/video/build/audio/s{n}.mp3 (Amazon Polly, see docs/video/script.md)
2. record each scene from the live site (scripts/video/record.py)
3. captions from the narration, timed per sentence, burned in
4. assemble with ffmpeg -> docs/video/build/tawi_twin_demo.mp4

Usage: .venv/Scripts/python -I scripts/video/make_video.py [scene numbers...]   (no args = all scenes + assemble)
"""

import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from record import record  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "docs" / "video" / "build"
AUDIO = BUILD / "audio"
SITE = "https://d2r8k00l2fxqnu.cloudfront.net/"
PHOTO = Path(r"C:\Users\mahaj\Downloads\tt_untrusted\photos\chennai02.jpg")
PHOTO_CREDIT = "Sample photo: McKay Savage, CC BY 2.0 (Chennai)"
LEAD = 0.6          # seconds of picture before the narration starts in each scene
TAIL = 0.8          # seconds after it ends

DUR = {k: v["seconds"] for k, v in json.loads((AUDIO / "durations.json").read_text(encoding="utf-8")).items()}

HIDE_INTRO = "localStorage.setItem('tt_intro_seen','1'); document.querySelector('#intro').hidden = true;"
WAIT_ANSWER = ("for (let i = 0; i < 80; i++) { await new Promise(r => setTimeout(r, 250)); "
               "if (!document.querySelector('.typing')) break; }")


def scene_len(n, extra=0.0):
    return round(LEAD + DUR[str(n)] + TAIL + extra, 2)


def set_photo(c):
    c.set_file("#photo", PHOTO)


SCENES = {
    1: {"url": SITE + "?v=vid1", "warmup": 9, "duration": scene_len(1),
        "setup": "const s = document.createElement('style'); s.textContent = '.intro-card{animation:zz 20s linear forwards}"
                 "@keyframes zz{from{transform:scale(1)}to{transform:scale(1.07)}}'; document.head.appendChild(s);",
        "steps": []},
    2: {"url": SITE + "?v=vid2", "warmup": 9, "duration": scene_len(2),
        "setup": HIDE_INTRO + " state.map.jumpTo({center:[74.862,32.712], zoom:12.2, pitch:0, bearing:0});",
        "steps": [(1.0, "state.map.easeTo({zoom: 12.6, duration: 5000});"),
                  (6.0, "await __tt.click('.layers [data-view=buildings]'); "
                        "state.map.flyTo({center:[74.851,32.717], zoom:14.9, pitch:55, bearing:-25, duration:4500});"),
                  (12.0, "await __tt.click('.tabs [data-tab=ask]');")]},
    3: {"url": SITE + "?v=vid3", "warmup": 9, "duration": scene_len(3, 1.0),
        "setup": HIDE_INTRO,
        "steps": [(0.4, "await __tt.click('.mode [data-mode=replay]');"),
                  (2.6, "await __tt.type('#q', 'Kal Bhagwati Nagar mein paani bharega?');"),
                  (6.2, "await __tt.click('#ask button[type=submit]'); __tt.hideCursor();"),
                  (14.0, WAIT_ANSWER),
                  (21.0, "document.querySelector('#tab-ask').scrollBy({top: 260, behavior: 'smooth'});")]},
    4: {"url": SITE + "?area=JMU-131&mode=replay&v=vid4", "warmup": 10, "duration": scene_len(4, 5.0),
        "setup": HIDE_INTRO,
        "steps": [(0.3, "await __tt.moveTo('.wa');"),
                  (1.2, "const t = decodeURIComponent(document.querySelector('.wa').href.split('text=')[1]).replace(/\\n/g,'<br>');"
                        "__tt.overlay(`<div style=\"font:600 13px system-ui;color:#c3c2b7;margin-bottom:8px\">Share preview · WhatsApp</div>"
                        "<div style=\"background:#005c4b;color:#fff;border-radius:12px 0 12px 12px;padding:12px 14px;font:15px/1.45 system-ui\">${t}</div>`,"
                        "'right:430px;top:200px;width:430px;background:#0b141a;border-radius:18px;padding:18px;box-shadow:0 20px 60px #000c');"),
                  (4.4, "__tt.hideOverlay(); await __tt.type('#q', 'गांधी नगर में गर्मी कितनी है?', 50);"),
                  (6.9, "await __tt.click('#ask button[type=submit]'); __tt.hideCursor();")]},
    5: {"url": SITE + "?mode=replay&v=vid5", "warmup": 10, "duration": scene_len(5, 1.0),
        "setup": HIDE_INTRO + " setView('buildings'); state.map.setTerrain({source:'terrain', exaggeration:1.4}); "
                 "state.map.jumpTo({center:[74.846,32.716], zoom:15.0, pitch:60, bearing:-35});",
        "settle": 5,
        "steps": [(0.3, "state.map.easeTo({center:[74.866,32.722], bearing:15, duration:11000});"),
                  (11.5, "await __tt.click('.layers [data-view=flood]'); state.map.setTerrain(null); "
                         "state.map.flyTo({center:[74.86,32.722], zoom:13.3, pitch:0, bearing:0, duration:2500});"),
                  (15.5, "__tt.moveTo('#legend');")]},
    6: {"url": SITE + "?mode=replay&v=vid6", "warmup": 10, "duration": scene_len(6, 1.0),
        "setup": HIDE_INTRO,
        "steps": [(0.3, "await __tt.click('.tabs [data-tab=command]');"),
                  (2.0, "fitAreas(state.highlighted.length ? state.highlighted : []);"),
                  (9.5, "await __tt.click('.layers [data-view=drains]'); "
                        "state.map.flyTo({center:[74.858,32.692], zoom:14.6, pitch:45, duration:2500});"),
                  (13.5, "document.querySelector('#tab-command').scrollBy({top: 330, behavior: 'smooth'});")]},
    7: {"url": SITE + "?v=vid7", "warmup": 10, "duration": scene_len(7, 5.0),
        "setup": HIDE_INTRO + " state.map.jumpTo({center:[74.8477,32.7187], zoom:15.2, pitch:40});",
        "steps": [(0.2, f"__tt.overlay('{PHOTO_CREDIT}', 'left:16px;bottom:58px;background:#000b;color:#fff;"
                        "font:13px system-ui;padding:6px 10px;border-radius:8px');"),
                  (0.4, "await __tt.click('.tabs [data-tab=report]');"),
                  (1.6, set_photo),
                  (2.4, "await __tt.moveTo('#report-loc'); setReportLoc(32.7187, 74.8477, 'GPS');"),
                  (3.6, "await __tt.type('#report-note', 'Demo report with a sample photo: road waterlogged, bikes stuck', 35);"),
                  (7.0, "await __tt.click('#report-send'); __tt.hideCursor();"),
                  (13.0, "await __tt.click('.tabs [data-tab=command]');"),
                  (14.5, "document.querySelector('#reports').scrollIntoView({block:'start', behavior:'smooth'});")]},
    8: {"url": (Path(__file__).parent / "architecture.html").resolve().as_uri(), "warmup": 2,
        "duration": scene_len(8), "setup": "",
        # one in-page timer schedules every reveal (per-step DevTools calls drift while the screencast runs)
        "steps": [(0.0, "const ts = [0.3, 0.6, 14.5, 15, 1.0, 1.5, 3.0, 6.0, 8.5, 10.5, 16.5, 18.5, 19.5];"
                        f"document.querySelectorAll('.box').forEach((b, i) => setTimeout(() => b.classList.add('show'), ({LEAD} + ts[i] - 0.8) * 1000));")]},
    9: {"url": SITE + "?v=vid9", "warmup": 9, "duration": scene_len(9, 3.0),
        "setup": HIDE_INTRO + " state.map.jumpTo({center:[74.862,32.712], zoom:12.4});",
        "steps": [(0.4, "await __tt.moveTo('#banner');"),
                  (6.0, "__tt.hideCursor(); __tt.overlay(`<div style=\"font:800 64px system-ui;color:#fff\">Tawi Twin</div>"
                        "<div style=\"font:22px system-ui;color:#c3c2b7;margin:8px 0 26px\">Monsoon &amp; heat command for Jammu · built on AWS</div>"
                        "<div style=\"font:600 24px system-ui;color:#86b6ef\">d2r8k00l2fxqnu.cloudfront.net</div>"
                        "<div style=\"font:15px system-ui;color:#8f8e86;margin-top:30px;line-height:1.6\">Dupahar · Built on AWS<br>"
                        "Data: Copernicus Sentinel &amp; DEM (ESA), USGS Landsat, © OpenStreetMap, Overture Maps, Open-Meteo · Map © Mapbox<br>"
                        "Voice: Amazon Polly · Not an official warning · Emergency 112</div>`,"
                        "'inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;"
                        "background:radial-gradient(ellipse at 50% 40%, #0d366bee, #000000f2);text-align:center');")]},
}


def srt_time(t):
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}".replace(".", ",")


def captions(starts):
    """One cue per sentence (long sentences split at commas), timed by character share of the scene's audio."""
    meta = json.loads((AUDIO / "durations.json").read_text(encoding="utf-8"))
    cues, i = [], 1
    for n in sorted(SCENES):
        text, dur = meta[str(n)]["text"], meta[str(n)]["seconds"]
        parts = []
        for sent in re.split(r"(?<=[.?!:])\s+", text):
            if len(sent) > 90:
                chunks = re.split(r"(?<=,)\s+", sent)
                buf = ""
                for ch in chunks:
                    if len(buf) + len(ch) > 80 and buf:
                        parts.append(buf.strip())
                        buf = ""
                    buf += ch + " "
                if buf.strip():
                    parts.append(buf.strip())
            else:
                parts.append(sent)
        total = sum(len(p) for p in parts)
        t = starts[n] + LEAD
        for p in parts:
            d = dur * len(p) / total
            cues.append(f"{i}\n{srt_time(t)} --> {srt_time(t + d - 0.05)}\n{p}\n")
            i += 1
            t += d
    return "\n".join(cues)


def assemble():
    clips = [BUILD / f"scene{n}.mp4" for n in sorted(SCENES)]
    starts, t = {}, 0.0
    for n in sorted(SCENES):
        starts[n] = t
        t += SCENES[n]["duration"]
    total = t
    (BUILD / "captions.srt").write_text(captions(starts), encoding="utf-8")
    (BUILD / "concat.txt").write_text("".join(f"file '{c.name}'\n" for c in clips))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(BUILD / "concat.txt"),
                    "-c", "copy", str(BUILD / "video_only.mp4")], check=True)
    # narration: each scene's clip delayed to its scene start + LEAD
    inputs, filters = [], []
    for k, n in enumerate(sorted(SCENES)):
        inputs += ["-i", str(AUDIO / f"s{n}.mp3")]
        ms = int((starts[n] + LEAD) * 1000)
        filters.append(f"[{k + 1}:a]adelay={ms}|{ms},aresample=48000[a{k}]")
    mix = "".join(f"[a{k}]" for k in range(len(SCENES))) + f"amix=inputs={len(SCENES)}:normalize=0,loudnorm=I=-16:TP=-1.5[a]"
    style = ("FontName=Segoe UI,FontSize=19,PrimaryColour=&H00FFFFFF,BackColour=&H99000000,BorderStyle=4,"
             "Outline=0,Shadow=0,MarginV=36,Alignment=2")
    srt = str(BUILD / "captions.srt").replace("\\", "/").replace(":", "\\:")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(BUILD / "video_only.mp4"), *inputs,
                    "-filter_complex", ";".join(filters) + ";" + mix + f";[0:v]subtitles='{srt}':force_style='{style}'[v]",
                    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-c:a", "aac",
                    "-b:a", "160k", "-t", f"{total:.2f}", "-movflags", "+faststart",
                    str(BUILD / "tawi_twin_demo.mp4")], check=True)
    print(f"video: {total:.1f} s -> {BUILD / 'tawi_twin_demo.mp4'}")


def main(which):
    BUILD.mkdir(parents=True, exist_ok=True)
    for n in which:
        s = SCENES[n]
        r = record(s, BUILD / f"scene{n}.mp4", profile=str(BUILD / f"chrome{n}"))
        print(f"scene {n}: {s['duration']} s, {r['frames']} frames{' | JS errors: ' + '; '.join(r['logs']) if r['logs'] else ''}")
    if len(which) == len(SCENES):
        assemble()


if __name__ == "__main__":
    args = [int(a) for a in sys.argv[1:] if a.isdigit()]
    if "assemble" in sys.argv:
        assemble()
    else:
        main(args or sorted(SCENES))

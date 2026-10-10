# "Kal paani bharega?" Teaching a city to answer the only flood question that matters

*How I built Tawi Twin, a monsoon and heat command tool for Jammu, in four days on AWS, and what fought back.*

> **Live:** https://d2r8k00l2fxqnu.cloudfront.net · **Code:** https://github.com/Dupahar/TawiTwin

---

## A river with a temper

On the 26th of August 2025, the sky over Jammu opened and simply forgot to close.

**296 mm of rain in 24 hours.** The previous record, 272.6 mm, had stood since 1973. The Tawi, a river Jammu usually treats like a calm old neighbour, rose past its highest flood level. Part of the 4th Tawi Bridge at Bhagwati Nagar gave way. More than 5,000 people were evacuated from places like Peerkho, Nikki Tawi, Gujjar Nagar and Beli Charan.

When I read the reports, what stuck with me wasn't the rain total. It was two quieter facts:

1. **Residents found out from their neighbours.** Nobody had told them "*your* street, *tonight*."
2. **The city had no ranked list.** No list of where to park the dewatering pumps, which drains to clear first, or which low-lying schools to check.

And for the rest of the year Jammu flips to the other extreme. In June the ground in the hottest neighbourhoods goes past **45 °C**. The same city gets too much water in August and too much heat in June, and no single tool covers both.

So the question I wanted to answer wasn't "can we map a flood from space?" It was much smaller:

> **Can a resident ask "*Kal Bhagwati Nagar mein paani bharega?*" and get a real answer?**

(That's Hinglish for "Will Bhagwati Nagar flood tomorrow?" It's how people actually talk, and it ended up being the hardest part of the project. More on that below.)

---

## Meet Tawi Twin

![Ask Tawi Twin, replaying the night before the 26 Aug 2025 flood](screenshots/ask_replay.png)

Tawi Twin is a digital twin of Jammu that has one job: **know about the water before the water arrives.** It has two kinds of users.

**🏠 For a resident:**
You type, or say, your question in Hindi, Hinglish or English. An AI agent finds your colony, pulls the evidence and checks the next 48 hours of forecast. Then it tells you:
- your risk level for waterlogging and for heat,
- **why** (satellites saw water here last year, your ground sits low, news reports named your area),
- **what to do**,
- the nearest hospital, and a school on higher ground.

One tap shares it on WhatsApp, because that's where Jammu actually talks. If your lane is already underwater, you snap a photo and report it.

**🏛️ For the city's control room (JMC / Smart City ICCC):**
The same data turns into a plan before the rain starts. How many areas are on high alert, how many buildings sit inside them, where to pre-position pumps, which drains to clear first, which schools and hospitals to check. Citizen photo reports land in an inbox **already triaged by AI**: is this actually waterlogging, how deep, is a drain blocked, severity 1 to 5.

![Command board with 188,180 buildings in 3D](screenshots/command_buildings.png)

### The party trick: replaying the flood

There's a button called **Replay the flood**. It runs the exact same rules on the archived forecasts from the night before 26 August 2025. Ask about Bhagwati Nagar in replay mode and Tawi Twin says **HIGH**, with about 185 mm of rain expected. **39 areas** light up high and 245 medium.

That was the moment the project stopped feeling like a demo to me. It is a little eerie to watch a tool warn about a night that has already happened.

---

## How it works (the nerdy bit)

### 1. Looking through clouds with radar

A monsoon flood happens under monsoon clouds, so optical satellites see nothing but cotton wool. **Sentinel-1 radar** sees through cloud. Calm water is a mirror to radar: it bounces the signal away, so flooded land shows up dark.

I took a pre-flood pass (15 Aug 2025) and a post-flood pass (27 Aug 2025, 18:34 IST) and mapped the new water with Python and **OpenCV**. I then added terrain from the Copernicus 30 m elevation model (**height above the nearest drain**: water is lazy and always goes downhill) and a heat layer from Landsat.

### 2. Every. Single. Building.

Jammu got split into **284 hexagons** of about 0.74 km² each. Then I went further: **188,180 buildings** from Overture Maps, which I queried in place from **AWS Open Data** with DuckDB, without downloading the whole planet. Each building is scored on:
- did radar see water beside it on 27 Aug 2025?
- how high is it above the nearest drain?
- is it inside the Tawi's flood-prone belt?
- how hot does it get?

All of that is cut into **1,315 vector tiles** and served in 3D. Panning along the Tawi with every rooftop coloured by risk is honestly the most satisfying thing I've ever made.

### 3. An agent that speaks Jammu

The chat runs on **Strands Agents**, AWS's open-source agent SDK, with **Amazon Nova Pro on Bedrock** as the brain. It has 7 tools: find a place, get the area's evidence, get the forecast, find safe places, and so on. It doesn't only reply in text. It also **drives the map**: it flies to your colony, drops a pin and opens the area's card.

### 4. The AWS plumbing

Everything lives in **one AWS SAM template** in ap-south-1 (Mumbai):

| What | AWS service |
|---|---|
| The agent and photo triage | **Amazon Bedrock** (Nova Pro) + **Strands Agents** |
| Finding colonies OpenStreetMap doesn't know | **Amazon Location Service** |
| API, agent, reports, forecast | **AWS Lambda** on Graviton (arm64) behind **API Gateway** |
| Hourly forecast refresh | **EventBridge Scheduler** → Lambda → Open-Meteo |
| Forecasts, alerts, reports, rate limits | **DynamoDB** (with TTL) |
| Site, map tiles, report photos | **S3 + CloudFront** (photos private, via presigned URLs) |
| Buildings and terrain | **AWS Open Data** (Overture, Terrain Tiles) |

The heavy raster work runs offline on my laptop and only the finished layers get uploaded, so the stack costs close to nothing while idle. Bedrock is the only metered piece, so the chat is rate-limited per IP.

---

## What fought back 🥊

Every project has a villain. Tawi Twin had several.

**Villain #1: Hinglish.**
"Kal paani bharega kya" is Hindi written in English letters. Ask a model that and it will happily reply in formal English, or in Devanagari, or in a confused mix of both. Telling it nicely in the prompt didn't work. In the end I stopped trusting the model to *notice* the language and **detected it in code**: Devanagari characters mean Hindi; if a quarter or more of the words are things like *kya, hai, mein, paani, kal*, it's Hinglish. Then I tell the agent exactly which language to use and give it a style example. Lesson: if something has to work every single time, don't leave it to the model.

**Villain #2: the agent thinking out loud.**
Nova sometimes wraps its reasoning in `<thinking>` tags, which means a resident asking about their street could have been shown the agent's internal monologue about which tool to call. Now a small function strips those tags out, including a half-finished one that never closes, before any user sees the reply.

**Villain #3: the colony that didn't exist.**
Bhagwati Nagar, home of the broken bridge and the most important place in the whole story, **isn't in OpenStreetMap as a searchable place.** Neither is Gujjar Nagar. **Amazon Location Service** knew both, so it became the fallback geocoder. A flood tool that can't find the flood would have been a bit embarrassing.

**Villain #4: blank popups.**
I moved the map to Mapbox, and every popup came up as an empty white box. The cause was a CSS specificity fight between my styles and Mapbox's. While I was in there, the night lighting was also quietly washing out my risk colours, so they became emissive (self-lit). Small bugs, but a demo can't survive them.

**Villain #5: photo uploads failing only in the browser.**
Presigned S3 uploads worked from scripts and failed in the browser. The fix was to sign against the **regional** S3 endpoint. I'm going to remember that one for a long time.

---

## Okay, but is it right?

This is the part I care about most, so I'll be careful.

I took the localities that news reports and the Sphere India situation report **named as flooded** on 26–27 Aug 2025. Eight of them fall inside my map. For buildings within 500 m of those places:

| | Near reported localities | Whole city |
|---|---|---|
| High or very high flood exposure | **36.4%** | 24.6% |
| Very high | **2.9%** | 0.8% |

So buildings near the places that actually flooded are **about 1.5× more likely** to be rated high risk than the city average. Nikki Tawi, Beli Charan and Bhagwati Nagar are clear hits (64–67% high or very high).

And the misses, because they matter too: **Gurkha Nagar, Qasim Nagar, Rajiv Nagar and Peerkho came out at only 8–14%.** My best guesses are that the 30 m elevation model counts rooftops as ground, and that the radar passed **a day after the peak**, when some of the water had already drained away. Eight places is a sanity check, not an accuracy score, and I didn't tune the model on them.

### Things Tawi Twin is not (yet)

- Radar misses water between tall buildings, so the 2025 flood map is a **lower bound** in dense areas.
- The Tawi flood-prone belt is my proxy (riverbed + 200 m); the official line isn't public.
- OpenStreetMap only knows **56** drains and canals in the area, so drain priorities only cover those.
- Every building is assumed to be 6 m tall, because the source data has no heights.
- **It is not an official warning.** Follow JMC, SDMA and IMD. In an emergency, dial 112.

I'd rather show you the misses than hide them. A flood tool that oversells itself is worse than having no tool.

---

## What I learned

- **Start from the sentence a person would actually say.** "Kal paani bharega?" shaped every design decision, from the language detector down to the WhatsApp button.
- **Serverless fits spiky problems really well.** Jammu needs this tool hard for a few weeks a year. Lambda + DynamoDB + EventBridge means it costs almost nothing in March and scales up in August.
- **Open data is underrated.** Sentinel-1, Copernicus DEM, Overture on AWS Open Data and OpenStreetMap: a solo student can build a city-scale flood twin in a weekend with free data. That still amazes me.
- **The honest limits section is a feature.** Writing it made the project better.

## What's next

With JMC's real drain network, ward boundaries and building heights, the scores could go from "indicative" to "calibrated." Officer login moves to **Amazon Cognito**. And before the next monsoon I'd love to hand this to the people in Peerkho and Nikki Tawi, the ones who had to find out from their neighbours last time.

When the next monsoon comes, I want every street in Jammu to know before the water does.

**Try it:** https://d2r8k00l2fxqnu.cloudfront.net. Hit **Replay the flood** and ask *"Kal Bhagwati Nagar mein paani bharega?"*

---

*Built solo by Adil Mahajan (Dupahar). The deployed agent runs on Amazon Nova Pro via Bedrock. The land-change and heat layers were ported from my earlier LandGuard prototype. Data: Copernicus Sentinel-1/-2 and DEM (ESA), USGS Landsat, © OpenStreetMap contributors, Overture Maps Foundation, Open-Meteo (CC BY 4.0), Amazon Location Service. Basemap © Mapbox.*

// Tawi Twin front end. config.json ({apiUrl, mapboxToken?}) is written at deploy time by scripts/deploy.ps1.
// Map engine: Mapbox GL JS v3 when a token is configured, otherwise MapLibre + OpenFreeMap (same API surface).

const JAMMU = [74.86, 32.71];
const STATUS = { low: "#0ca30c", medium: "#fab219", high: "#d03b3b" };
const STATUS_LABEL = { low: "Low", medium: "Medium", high: "High" };
const STATUS_ICON = { low: "✓", medium: "!", high: "▲" };
const FLOOD_CLASS = [["#5a5a55", "Lower risk · higher ground"], ["#fab219", "Moderate · within 8 m of drain level"],
  ["#ec835a", "High · near the Tawi or within 3 m of drain level"], ["#d03b3b", "Very high · water seen in 2025, or low ground beside the Tawi"]];
const CAT = { built_gain: "#d95926", veg_loss: "#199e70", water_change: "#3987e5" };
const SEV = (s) => (s >= 4 ? STATUS.high : s === 3 ? STATUS.medium : STATUS.low);

const state = { api: null, mapbox: false, gl: null, map: null, mode: "live", view: "risk", alerts: null, areas: null,
  selected: null, history: [], location: null, markers: [], pumpMarkers: [], highlighted: [], ranked: null,
  busy: false, satellite: false, threeD: false, reports: [], reportLoc: null };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "–" : Number(v).toFixed(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadAsset(tag, attrs) {
  return new Promise((res, rej) => {
    const el = document.createElement(tag);
    Object.assign(el, attrs);
    el.onload = res; el.onerror = rej;
    document.head.appendChild(el);
  });
}

// ---------------- boot ----------------
(async function boot() {
  let cfg = {};
  try { cfg = await (await fetch("config.json", { cache: "no-store" })).json(); } catch { /* local fallback */ }
  state.api = cfg.apiUrl;
  state.mapbox = Boolean(cfg.mapboxToken);
  if (state.mapbox) {
    await Promise.all([
      loadAsset("link", { rel: "stylesheet", href: "https://api.mapbox.com/mapbox-gl-js/v3.15.0/mapbox-gl.css" }),
      loadAsset("script", { src: "https://api.mapbox.com/mapbox-gl-js/v3.15.0/mapbox-gl.js" })]);
    state.gl = window.mapboxgl;
    state.gl.accessToken = cfg.mapboxToken;
  } else {
    await Promise.all([
      loadAsset("link", { rel: "stylesheet", href: "https://unpkg.com/maplibre-gl@5.6.0/dist/maplibre-gl.css" }),
      loadAsset("script", { src: "https://unpkg.com/maplibre-gl@5.6.0/dist/maplibre-gl.js" })]);
    state.gl = window.maplibregl;
  }
  const map = new state.gl.Map({ container: "map", style: styleUrl(), center: JAMMU, zoom: 12.3, maxPitch: 75,
    attributionControl: state.mapbox ? true : { compact: true } });
  state.map = map;
  map.addControl(new state.gl.NavigationControl({ visualizePitch: true }), "top-right");
  map.on("style.load", onStyleLoad);
  bindUi();
  state.areas = await (await fetch("layers/areas.geojson")).json();
  await init();
})();

function styleUrl() {
  if (state.mapbox) return state.satellite ? "mapbox://styles/mapbox/standard-satellite" : "mapbox://styles/mapbox/standard";
  return "https://tiles.openfreemap.org/styles/dark";
}

// ---------------- overlays (re-added after every style change) ----------------
// Mapbox Standard lights the scene (night preset); emissive strength keeps our data colours true.
const EMISSIVE = { fill: "fill-emissive-strength", "fill-extrusion": "fill-extrusion-emissive-strength",
  line: "line-emissive-strength", circle: "circle-emissive-strength" };

function addLayer(layer, slot = "middle") {
  const map = state.map;
  if (map.getLayer(layer.id)) return;
  if (state.mapbox && EMISSIVE[layer.type]) layer = { ...layer, paint: { ...layer.paint, [EMISSIVE[layer.type]]: 1 } };
  if (state.mapbox) map.addLayer({ ...layer, slot });
  else map.addLayer(layer, slot === "top" ? undefined : map.getStyle().layers.find((l) => l.type === "symbol")?.id);
}

function onStyleLoad() {
  const map = state.map;
  if (state.mapbox) {
    try {
      map.setConfigProperty("basemap", "lightPreset", state.satellite ? "day" : "night");
      map.setConfigProperty("basemap", "show3dObjects", false);   // our own risk-coloured buildings replace them
    } catch { /* satellite style may not expose every property */ }
  }
  const origin = location.origin;
  map.addSource("terrain", { type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 14,
    tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
    attribution: "Terrain: AWS Open Data Terrain Tiles" });
  if (!state.mapbox) addLayer({ id: "hillshade", type: "hillshade", source: "terrain",
    paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "#000" } }, "bottom");
  map.addSource("areas", { type: "geojson", data: "layers/areas.geojson", promoteId: "area_id" });
  map.addSource("flood", { type: "geojson", data: "layers/flood_2025_08_27.geojson" });
  map.addSource("flags", { type: "geojson", data: "layers/change_flags.geojson" });
  map.addSource("floodplain", { type: "geojson", data: "layers/floodplain_proxy.geojson" });
  map.addSource("drains", { type: "geojson", data: "layers/drains_priority.geojson" });
  map.addSource("reports", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("reported", { type: "geojson", data: "layers/reported_2025.geojson" });
  map.addSource("bld", { type: "vector", tiles: [`${origin}/tiles/buildings/{z}/{x}/{y}.pbf`], minzoom: 13, maxzoom: 16 });

  addLayer({ id: "risk-fill", type: "fill", source: "areas", paint: {
    "fill-color": ["match", ["coalesce", ["feature-state", "w"], "none"],
      "high", STATUS.high, "medium", STATUS.medium, "low", STATUS.low, "#555"],
    "fill-opacity": ["interpolate", ["linear"], ["zoom"], 12, ["match", ["coalesce", ["feature-state", "w"], "none"], "high", 0.55, "medium", 0.4, 0.14],
      15, ["match", ["coalesce", ["feature-state", "w"], "none"], "high", 0.22, "medium", 0.16, 0.05]] } });
  addLayer({ id: "heat-fill", type: "fill", source: "areas", layout: { visibility: "none" }, paint: {
    "fill-color": ["interpolate", ["linear"], ["get", "lst_anom_c"], -4, "#3987e5", -1.5, "#86b6ef", 0, "#383835", 1.5, "#ec835a", 3.5, "#e66767"],
    "fill-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 15, 0.2] } });
  addLayer({ id: "areas-line", type: "line", source: "areas", paint: { "line-color": "#ffffff", "line-opacity": 0.14, "line-width": 0.6 } });
  addLayer({ id: "flood-water", type: "fill", source: "flood", layout: { visibility: "none" }, paint: {
    "fill-color": ["match", ["get", "kind"], "new_water", "#6da7ec", "#256abf"], "fill-opacity": 0.9 } });
  addLayer({ id: "floodplain-line", type: "line", source: "floodplain", layout: { visibility: "none" },
    paint: { "line-color": "#86b6ef", "line-width": 1.5, "line-dasharray": [2, 2] } });
  addLayer({ id: "flags-fill", type: "fill", source: "flags", layout: { visibility: "none" },
    filter: ["==", ["get", "flood_prone"], true], paint: {
      "fill-color": ["match", ["get", "category"], "built_gain", CAT.built_gain, "veg_loss", CAT.veg_loss, CAT.water_change],
      "fill-opacity": 0.9 } });
  addLayer({ id: "bld", type: "fill-extrusion", source: "bld", "source-layer": "buildings", minzoom: 13.5, paint: {
    "fill-extrusion-color": bldColor(), "fill-extrusion-height": ["coalesce", ["get", "height_m"], 6],
    "fill-extrusion-opacity": 0.92 } });
  addLayer({ id: "drains-line", type: "line", source: "drains", layout: { visibility: "none", "line-cap": "round" }, paint: {
    "line-color": ["case", ["<=", ["get", "rank"], 10], "#d03b3b", "#fab219"],
    "line-width": ["interpolate", ["linear"], ["zoom"], 12, ["case", ["<=", ["get", "rank"], 10], 4, 2.5], 16, ["case", ["<=", ["get", "rank"], 10], 9, 5]] } }, "top");
  addLayer({ id: "reports-pt", type: "circle", source: "reports", paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 5, 16, 10],
    "circle-color": ["match", ["get", "sev"], 5, STATUS.high, 4, STATUS.high, 3, STATUS.medium, STATUS.low],
    "circle-stroke-color": "#fff", "circle-stroke-width": 2 } }, "top");
  addLayer({ id: "reported-pt", type: "circle", source: "reported", layout: { visibility: "none" }, paint: {
    "circle-radius": 9, "circle-color": "#ffffff", "circle-stroke-color": "#d03b3b", "circle-stroke-width": 4 } }, "top");
  addLayer({ id: "areas-hl", type: "line", source: "areas", paint: {
    "line-color": "#fab219", "line-width": ["case", ["boolean", ["feature-state", "hl"], false], 2.5, 0] } }, "top");
  addLayer({ id: "areas-sel", type: "line", source: "areas", paint: {
    "line-color": "#ffffff", "line-width": ["case", ["boolean", ["feature-state", "sel"], false], 3.5, 0] } }, "top");

  if (state.threeD) map.setTerrain({ source: "terrain", exaggeration: 1.5 });
  bindMapEvents();
  setView(state.view);
  applyAlertStates();
  renderReportsLayer();
  if (state.selected) setFeature(state.selected, "sel", true);
  state.highlighted.forEach((id) => setFeature(id, "hl", true));
}

let mapEventsBound = false;
function bindMapEvents() {
  if (mapEventsBound) return;
  mapEventsBound = true;
  const map = state.map;
  map.on("click", (e) => {
    if (!$("#tab-report").hidden) { setReportLoc(e.lngLat.lat, e.lngLat.lng, "map"); return; }
    const hit = map.queryRenderedFeatures(e.point, { layers: ["reported-pt", "reports-pt", "drains-line", "flags-fill", "bld", "risk-fill", "heat-fill"].filter((l) => map.getLayer(l)) })[0];
    if (!hit) return;
    const p = hit.properties;
    if (hit.layer.id === "reports-pt") return openReport(p.id);
    if (hit.layer.id === "reported-pt") return popup(e.lngLat, `<b>${esc(p.name)}</b>: ${esc(p.reported)} on 26–27 Aug 2025` +
      `<br><span class="m">Matched as “${esc(p.matched)}”</span><br><a href="${esc(p.source)}" target="_blank" rel="noopener" style="color:#86b6ef">Source</a>`);
    if (hit.layer.id === "drains-line") return popup(e.lngLat, `<b>Drain clearing priority #${p.rank}</b><br>${esc(p.kind)}${p.name ? " · " + esc(p.name) : ""}<br>${p.exposed_buildings} low-lying buildings within 100 m<br><span class="m">${esc(p.area_name || "")}</span>`);
    if (hit.layer.id === "flags-fill") return popup(e.lngLat, `<b>${esc(p.category.replace("_", " "))}</b> · ${fmt(p.area_m2 / 1e4, 2)} ha<br><span class="m">${esc(p.label)}</span>`);
    if (hit.layer.id === "bld") {
      popup(e.lngLat, `<b>Building flood class: ${FLOOD_CLASS[p.flood_class]?.[1] || "–"}</b><br>` +
        `${fmt(p.hand_m)} m above nearest drain · summer surface ${fmt(p.lst_c)} °C` +
        `${p.in_floodzone ? "<br>Inside Tawi flood-prone zone (proxy)" : ""}${p.water_2025 ? "<br>Radar saw water within 10 m on 27 Aug 2025" : ""}`);
      if (p.area_id) selectArea(p.area_id, { fly: false });
      return;
    }
    selectArea(p.area_id, { fly: false });
  });
  map.on("mousemove", (e) => {
    const layers = ["reports-pt", "drains-line", "bld", "risk-fill", "heat-fill"].filter((l) => map.getLayer(l));
    map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers }).length ? "pointer" : "";
  });
}

function popup(lngLat, html) {
  new state.gl.Popup({ maxWidth: "280px" }).setLngLat(lngLat).setHTML(html).addTo(state.map);
}

// ---------------- views & legend ----------------
function bldColor() {
  if (state.view === "heat") return ["interpolate", ["linear"], ["coalesce", ["get", "lst_c"], 41], 36, "#3987e5", 39, "#86b6ef", 41.4, "#5a5a55", 43, "#ec835a", 45, "#e66767"];
  return ["match", ["get", "flood_class"], 3, FLOOD_CLASS[3][0], 2, FLOOD_CLASS[2][0], 1, FLOOD_CLASS[1][0], FLOOD_CLASS[0][0]];
}

const VIEWS = {
  risk: { layers: ["risk-fill", "bld"], legend: () => `<h4>${state.mode === "replay" ? "Waterlogging alert · 26 Aug 2025 replay" : "Waterlogging alert · next 48 h"}</h4>` +
      ["high", "medium", "low"].map((k) => `<div class="row"><span class="sw" style="background:${STATUS[k]}"></span>${STATUS_ICON[k]} ${STATUS_LABEL[k]}</div>`).join("") +
      `<div class="m" style="margin-top:6px">Zoom in to see every building.</div>` },
  buildings: { layers: ["bld", "floodplain-line"], legend: () => `<h4>Building flood exposure</h4>` +
      [3, 2, 1, 0].map((k) => `<div class="row"><span class="sw" style="background:${FLOOD_CLASS[k][0]}"></span>${FLOOD_CLASS[k][1]}</div>`).join("") +
      `<div class="m" style="margin-top:6px">188,180 buildings · heights uniform 6 m (not in source data)</div>` },
  flood: { layers: ["flood-water", "floodplain-line", "reported-pt"], legend: () => `<h4>What satellites saw · 27 Aug 2025, 18:34 IST</h4>
      <div class="row"><span class="sw" style="background:#6da7ec"></span>Newly flooded (vs 15 Aug)</div>
      <div class="row"><span class="sw" style="background:#256abf"></span>Water on both dates</div>
      <div class="row"><span class="sw" style="border:1.5px dashed #86b6ef"></span>Tawi flood-prone zone (proxy)</div>
      <div class="row"><span class="sw" style="background:#fff;border:3px solid #d03b3b;border-radius:50%"></span>Named as flooded in news reports</div>
      <div class="m" style="margin-top:6px">Radar passed a day after the peak and misses water between buildings.</div>` },
  heat: { layers: ["heat-fill", "bld"], legend: () => `<h4>Summer surface temperature</h4>
      <div class="ramp" style="background:linear-gradient(90deg,#3987e5,#86b6ef,#5a5a55,#ec835a,#e66767)"></div>
      <div class="ends"><span>cooler</span><span>city median 41.4 °C</span><span>hotter</span></div>` },
  drains: { layers: ["drains-line", "risk-fill"], legend: () => `<h4>Drains to clear first (OSM-mapped)</h4>
      <div class="row"><span class="sw" style="background:#d03b3b"></span>Top 10 segments</div>
      <div class="row"><span class="sw" style="background:#fab219"></span>Ranks 11–60</div>
      <div class="m" style="margin-top:6px">Ranked by low-lying buildings within 100 m × area flood score</div>` },
  change: { layers: ["flags-fill", "floodplain-line"], legend: () => `<h4>Detected land-cover change 2019→2026<br>in the flood-prone zone</h4>
      <div class="row"><span class="sw" style="background:${CAT.built_gain}"></span>Built-up gain</div>
      <div class="row"><span class="sw" style="background:${CAT.veg_loss}"></span>Vegetation loss</div>
      <div class="row"><span class="sw" style="background:${CAT.water_change}"></span>Water change</div>` },
};
const ALL_VIEW_LAYERS = [...new Set(Object.values(VIEWS).flatMap((v) => v.layers))];

function setView(view) {
  state.view = view;
  const map = state.map;
  if (!map || !map.getLayer("bld")) return;
  for (const id of ALL_VIEW_LAYERS) map.setLayoutProperty(id, "visibility", VIEWS[view].layers.includes(id) ? "visible" : "none");
  map.setPaintProperty("bld", "fill-extrusion-color", bldColor());
  document.querySelectorAll(".layers [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $("#legend").innerHTML = VIEWS[view].legend();
  if ((view === "buildings" || view === "heat") && map.getZoom() < 14) map.easeTo({ zoom: 14.5, pitch: state.threeD ? 60 : 45, duration: 1200 });
}

// ---------------- API ----------------
async function api(path, opts) {
  const res = await fetch(state.api + path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.message || `HTTP ${res.status}`);
  return body;
}

async function init() {
  try { const h = await api("/health"); $("#api-status").textContent = `API ${h.status}, v${h.version}.`; }
  catch { $("#banner").textContent = "API unreachable. Map layers still work."; }
  renderRanking("flood_priority_score");
  await setMode(new URLSearchParams(location.search).get("mode") === "replay" ? "replay" : state.mode);
  loadReports();
  const qs = new URLSearchParams(location.search);
  if (/^JMU-\d{3}$/.test(qs.get("area") || "")) { localStorage.setItem("tt_intro_seen", "1"); selectArea(qs.get("area")); }
  else if (!localStorage.getItem("tt_intro_seen")) $("#intro").hidden = false;
}

// ---------------- mode & alerts ----------------
function setFeature(id, key, val) { if (id && state.map?.getSource("areas")) state.map.setFeatureState({ source: "areas", id }, { [key]: val }); }

function applyAlertStates() {
  if (!state.alerts || !state.map?.getSource("areas")) return;
  for (const [id, v] of Object.entries(state.alerts.areas)) state.map.setFeatureState({ source: "areas", id }, { w: v.w, h: v.h });
}

async function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode button").forEach((b) => b.setAttribute("aria-selected", b.dataset.mode === mode));
  const banner = $("#banner");
  banner.className = "banner";
  try {
    const a = await api(`/alerts${mode === "replay" ? "?mode=replay" : ""}`);
    state.alerts = a;
    applyAlertStates();
    const c = a.counts.waterlogging, city = a.city;
    const rain = Math.max(city.rain_0_24h_mm, city.rain_24_48h_mm);
    if (mode === "replay") {
      banner.classList.add("crit");
      banner.innerHTML = `<b>Replay · 26 Aug 2025.</b> Forecast models showed <b>${fmt(rain, 0)} mm</b> in 24 h (${esc(city.rain_category)}; ` +
        `the IMD gauge measured 296 mm). <b>${c.high} areas high</b>, ${c.medium} medium waterlogging alert.`;
    } else {
      if (c.high) banner.classList.add("crit"); else if (c.medium) banner.classList.add("warn");
      banner.innerHTML = c.high || c.medium
        ? `<b>${c.high} areas at high, ${c.medium} at medium</b> waterlogging alert in the next 48 h · ${fmt(rain)} mm (${esc(city.rain_category)})`
        : `<b>No waterlogging alert</b> for the next 48 h · ${fmt(rain)} mm rain expected · max ${fmt(city.tmax_c)} °C · all ${c.low} areas low`;
    }
  } catch (e) { banner.textContent = `Forecast unavailable: ${e.message}`; }
  if (state.map?.getLayer("bld")) setView(state.view);
  if (state.selected) selectArea(state.selected, { fly: false });
  if (!$("#tab-command").hidden) loadSituation();
}

// ---------------- area card ----------------
async function selectArea(id, { fly = true, asked = null } = {}) {
  if (state.selected && state.selected !== id) setFeature(state.selected, "sel", false);
  state.selected = id;
  setFeature(id, "sel", true);
  showTab("ask");
  const card = $("#area-card");
  card.hidden = false;
  card.innerHTML = `<div class="muted">Loading ${esc(id)}…</div>`;
  try {
    const r = await api(`/areas/${id}${state.mode === "replay" ? "?mode=replay" : ""}`);
    if (fly) state.map.flyTo({ center: [r.lon, r.lat], zoom: 14.6, pitch: state.threeD ? 60 : 40, speed: 1.2,
      padding: isPhone() ? { top: 150, bottom: 0, left: 0, right: 0 } : 0 });
    const f = r.forecast_48h || {};
    const badge = (label, lvl) => `<span class="badge"><i style="background:${STATUS[lvl] || "#555"}"></i>${label}: ${STATUS_ICON[lvl] || ""} ${STATUS_LABEL[lvl] || "–"}</span>`;
    const hosp = r.nearest_hospitals?.[0], refuge = r.high_ground_refuges?.[0];
    card.innerHTML = `
      <button class="close" aria-label="Close">✕</button>
      <h3>${asked ? esc(asked) : esc(r.name)}</h3>
      <div class="id">${asked ? `area ${esc(r.name)} · ` : ""}${esc(r.area_id)} · ${r.buildings.toLocaleString()} buildings${state.mode === "replay" ? " · replay 26 Aug 2025" : ""}</div>
      <div class="badges">${badge("Waterlogging", f.waterlogging)}${badge("Heat", f.heat)}
        <span class="badge">🌧 ${fmt(Math.max(f.rain_0_24h_mm ?? 0, f.rain_24_48h_mm ?? 0))} mm / 24 h</span></div>
      <div class="tiles">
        <div class="tile"><div class="v">${fmt(r.flood_evidence.pct_of_area_radar_saw_water)}%</div><div class="k">of this area was under water on 27 Aug 2025 (satellite)</div></div>
        <div class="tile"><div class="v">${fmt(r.terrain.median_height_above_nearest_drain_m)} m</div><div class="k">ground height above the nearest drain or river (lower floods sooner)</div></div>
        <div class="tile"><div class="v">${fmt(r.terrain.pct_of_area_in_tawi_flood_prone_zone, 0)}%</div><div class="k">of this area is in the Tawi's flood-prone belt</div></div>
        <div class="tile"><div class="v">${fmt(r.heat.summer_surface_temp_c)} °C</div><div class="k">ground temperature on summer afternoons (${r.heat.vs_city_median_c >= 0 ? "+" : ""}${fmt(r.heat.vs_city_median_c)} vs city)</div></div>
      </div>
      ${(r.reported_in_news_aug_2025 || []).length ? `<p class="news">📰 Named in Aug 2025 flood reports: ${r.reported_in_news_aug_2025.map((n) =>
        `<a href="${esc(n.source)}" target="_blank" rel="noopener">${esc(n.locality)}</a> (${esc(n.reported)}, ${fmt(n.distance_m / 1000)} km)`).join(", ")}</p>` : ""}
      <p class="muted" style="margin:10px 0 0">${hosp ? `🏥 ${esc(hosp.name)} · ${fmt(hosp.distance_m / 1000)} km` : ""}${refuge ? `<br>⛰ High ground: ${esc(refuge.name)} · ${fmt(refuge.distance_m / 1000)} km` : ""}</p>
      <div class="card-actions">
        <a class="wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(shareText(r, f, asked))}">Share on WhatsApp</a>
        <button class="secondary" id="ask-area">Ask about this area</button>
      </div>`;
    card.querySelector("#ask-area").addEventListener("click", () => ask(`Tell me about ${asked || r.name} (${r.area_id})`));
    card.querySelector(".close").addEventListener("click", () => { card.hidden = true; setFeature(state.selected, "sel", false); state.selected = null; });
  } catch (e) { card.innerHTML = `<div class="muted">Could not load area: ${esc(e.message)}</div>`; }
}

function shareText(r, f, asked) {
  const lvl = (x) => (STATUS_LABEL[x] || "–").toUpperCase();
  const when = state.mode === "replay" ? "Replay of 26 Aug 2025" : "Next 48 h";
  const rain = fmt(Math.max(f.rain_0_24h_mm ?? 0, f.rain_24_48h_mm ?? 0));
  const url = `${location.origin}/?area=${r.area_id}${state.mode === "replay" ? "&mode=replay" : ""}`;
  return `Tawi Twin · ${asked || r.name}\n${when}: waterlogging ${lvl(f.waterlogging)}, heat ${lvl(f.heat)}, rain ${rain} mm.\n` +
    `Check your own colony: ${url}\n(Indicative, not an official warning. Emergency: 112)`;
}

// ---------------- chat ----------------
function renderMarkdown(text) {
  const lines = esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").split(/\n/);
  let html = "", list = null;
  for (const raw of lines) {
    const line = raw.trim().replace(/^#{1,4}\s+/, "");
    const m = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (m) { if (!list) { list = /^\d/.test(line) ? "ol" : "ul"; html += `<${list}>`; } html += `<li>${m[1]}</li>`; continue; }
    if (list) { html += `</${list}>`; list = null; }
    if (line) html += `<p>${line}</p>`;
  }
  if (list) html += `</${list}>`;
  return html;
}

function addMsg(role, html, cls = "") {
  const div = document.createElement("div");
  div.className = `msg ${role} ${cls}`;
  div.innerHTML = html;
  $("#chat").appendChild(div);
  $("#chat").scrollTop = $("#chat").scrollHeight;
  div.scrollIntoView({ block: role === "bot" ? "start" : "end", behavior: "smooth" });
  return div;
}

function clearMarkers() { state.markers.forEach((m) => m.remove()); state.markers = []; }
function highlight(ids) {
  state.highlighted.forEach((id) => setFeature(id, "hl", false));
  state.highlighted = ids; ids.forEach((id) => setFeature(id, "hl", true));
}
function fitAreas(ids) {
  const b = new state.gl.LngLatBounds();
  state.areas.features.filter((f) => ids.includes(f.properties.area_id)).forEach((f) => f.geometry.coordinates[0].forEach((c) => b.extend(c)));
  if (!b.isEmpty()) state.map.fitBounds(b, { padding: 80, maxZoom: 14 });
}

function pin(lon, lat, label, cls = "") {
  const el = document.createElement("div");
  el.className = `pin ${cls}`;
  el.textContent = label;
  return new state.gl.Marker({ element: el, anchor: "bottom" }).setLngLat([lon, lat]).addTo(state.map);
}

function applyActions(actions) {
  clearMarkers();
  let focused = false, asked = null;
  for (const a of actions || []) {
    if (a.type === "marker") {
      const icon = a.kind === "hospital" ? "🏥 " : a.kind ? "🏫 " : "📍 ";
      state.markers.push(pin(a.lon, a.lat, icon + a.label.split(",")[0], a.kind ? "facility" : ""));
      if (!a.kind && !asked) asked = a.label.split(",")[0];
    } else if (a.type === "focus_area" && !focused) {
      focused = true; selectArea(a.area_id, { asked });
    } else if (a.type === "highlight_areas") {
      highlight(a.area_ids); fitAreas(a.area_ids);
    } else if (a.type === "show_layer" && a.layer === "drains") {
      setView("drains");
    }
  }
}

async function ask(text) {
  text = text.trim();
  if (!text || state.busy) return;
  state.busy = true;
  showTab("ask");
  addMsg("user", esc(text));
  const typing = addMsg("bot", "Checking radar history, terrain and the forecast…", "typing");
  try {
    const body = { message: text, history: state.history, mode: state.mode, area_id: state.selected || undefined };
    if (state.location) body.location = state.location;
    const t0 = performance.now();
    const r = await api("/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    typing.remove();
    const msg = addMsg("bot", renderMarkdown(r.answer) + `<div class="meta">${((performance.now() - t0) / 1000).toFixed(1)} s · ${esc(r.model.split(".").slice(-1)[0].split(":")[0])} on Amazon Bedrock</div>`);
    state.history.push({ role: "user", text }, { role: "assistant", text: r.answer });
    state.history = state.history.slice(-8);
    applyActions(r.actions);
    if (isPhone()) document.body.classList.add("sheet-open");
    setTimeout(() => msg.scrollIntoView({ block: "start", behavior: "smooth" }), 1200);   // after the area card renders
  } catch (e) {
    typing.remove();
    addMsg("bot", `Sorry, I couldn't answer that: ${esc(e.message)}`);
  } finally { state.busy = false; }
}

function locateThen(fn, onFail) {
  if (!navigator.geolocation) return (onFail || (() => addMsg("bot", "Location is not available. Type your colony name instead.")))();
  navigator.geolocation.getCurrentPosition(
    (pos) => { state.location = { lat: pos.coords.latitude, lon: pos.coords.longitude }; fn(state.location); },
    () => (onFail || (() => addMsg("bot", "Location permission was denied. Type your colony name instead, e.g. “Gandhi Nagar”.")))(),
    { enableHighAccuracy: true, timeout: 10000 });
}

// ---------------- citizen reports ----------------
function setReportLoc(lat, lon, how) {
  state.reportLoc = { lat, lon };
  $("#report-loc-text").textContent = `Location: ${lat.toFixed(5)}, ${lon.toFixed(5)} (${how})`;
  state.markers.forEach((m) => m.remove()); state.markers = [pin(lon, lat, "📍 Report here")];
}

async function downscale(file, maxSide = 1600) {
  const img = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
}

async function submitReport(e) {
  e.preventDefault();
  const file = $("#photo").files[0];
  const out = $("#report-result");
  if (!file) return (out.innerHTML = `<p class="muted">Please add a photo.</p>`);
  if (!state.reportLoc) return (out.innerHTML = `<p class="muted">Please set the location (button or tap the map).</p>`);
  $("#report-send").disabled = true;
  out.innerHTML = `<div class="triage">Uploading and checking the photo with AI…</div>`;
  try {
    const blob = await downscale(file);
    const up = await api("/reports/upload", { method: "POST" });
    const fd = new FormData();
    Object.entries(up.fields).forEach(([k, v]) => fd.append(k, v));
    fd.append("Content-Type", "image/jpeg");
    fd.append("file", blob, "photo.jpg");
    const s3 = await fetch(up.url, { method: "POST", body: fd });
    if (!s3.ok) throw new Error(`upload failed (${s3.status})`);
    const r = await api("/reports", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ photo_key: up.key, ...state.reportLoc, note: $("#report-note").value }) });
    const ai = r.ai || {};
    out.innerHTML = `<div class="triage"><div class="sev"><i style="background:${SEV(ai.severity)}"></i>Severity ${ai.severity ?? "?"} / 5</div>
      <p>${esc(ai.summary || "")}</p>
      <p class="muted">${ai.waterlogging ? `Waterlogging · depth: ${esc(ai.depth)}` : "No waterlogging detected"}${ai.blocked_drain ? " · blocked drain" : ""}${ai.garbage_or_debris ? " · garbage/debris" : ""}
      <br>Sent to the control room · ${esc(r.area_name || r.area_id || "")}. Thank you!</p></div>`;
    $("#report-form").reset(); $("#photo-preview").hidden = true; $("#photo-label").hidden = false;
    loadReports();
  } catch (err) { out.innerHTML = `<div class="triage">Could not send: ${esc(err.message)}</div>`; }
  finally { $("#report-send").disabled = false; }
}

async function loadReports() {
  try { state.reports = (await api("/reports")).reports; } catch { state.reports = []; }
  renderReportsLayer();
  renderReportsList();
}

function renderReportsLayer() {
  const src = state.map?.getSource("reports");
  if (!src) return;
  src.setData({ type: "FeatureCollection", features: state.reports.filter((r) => r.status !== "rejected").map((r) => ({
    type: "Feature", geometry: { type: "Point", coordinates: [r.lon, r.lat] },
    properties: { id: r.id, sev: r.ai?.severity ?? 1 } })) });
}

function renderReportsList() {
  const el = $("#reports");
  if (!state.reports.length) { el.innerHTML = `<p class="muted">No reports yet. Residents can send one from the Report tab.</p>`; return; }
  el.innerHTML = state.reports.slice(0, 20).map((r) => `
    <div class="report" data-id="${esc(r.id)}">
      <img src="${esc(r.photo_url)}" alt="report photo" loading="lazy">
      <div><div class="t"><span class="sev"><i style="background:${SEV(r.ai?.severity)}"></i>${r.ai?.severity ?? "?"}/5</span> ${esc(r.ai?.summary || r.note || "")}</div>
        <div class="m">${esc(r.area_name || r.area_id || "")} · ${new Date(r.created).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}</div>
        <div class="acts">${["new", "assigned", "resolved", "rejected"].map((s) => `<button data-status="${s}" class="${r.status === s ? "on" : ""}">${s}</button>`).join("")}</div>
      </div></div>`).join("");
  el.querySelectorAll(".report").forEach((div) => {
    div.addEventListener("click", (e) => {
      const st = e.target.dataset?.status;
      if (st) { e.stopPropagation(); return setStatus(div.dataset.id, st); }
      openReport(div.dataset.id);
    });
  });
}

function openReport(id) {
  const r = state.reports.find((x) => x.id === id);
  if (!r) return;
  state.map.flyTo({ center: [r.lon, r.lat], zoom: 15.5 });
  popup([r.lon, r.lat], `<img src="${esc(r.photo_url)}" style="width:100%;border-radius:6px"><br><b>Severity ${r.ai?.severity ?? "?"}/5</b> · ${esc(r.status)}<br>${esc(r.ai?.summary || "")}${r.note ? `<br><i>“${esc(r.note)}”</i>` : ""}`);
}

async function setStatus(id, status) {
  let key = localStorage.getItem("tt_officer_key");
  if (!key) { key = prompt("Officer key (demo):"); if (!key) return; }
  try {
    await api(`/reports/${id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-officer-key": key }, body: JSON.stringify({ status }) });
    localStorage.setItem("tt_officer_key", key);
    loadReports();
  } catch (e) { localStorage.removeItem("tt_officer_key"); alert(`Could not update: ${e.message}`); }
}

// ---------------- command board ----------------
async function loadSituation() {
  const el = $("#situation");
  try {
    const s = await api(`/situation${state.mode === "replay" ? "?mode=replay" : ""}`);
    const rain = Math.max(s.city_forecast.rain_0_24h_mm, s.city_forecast.rain_24_48h_mm);
    el.innerHTML = `
      <h3 class="h">${s.mode === "replay" ? "Situation · replay 26 Aug 2025" : "Situation · next 48 h"}</h3>
      <div class="tiles">
        <div class="tile"><div class="v" style="color:${s.areas.high ? STATUS.high : "inherit"}">${s.areas.high}</div><div class="k">areas at high alert (${s.areas.medium} medium)</div></div>
        <div class="tile"><div class="v">${s.buildings_in_high_alert_areas.toLocaleString()}</div><div class="k">buildings in high-alert areas</div></div>
        <div class="tile"><div class="v">${fmt(rain, 0)} mm</div><div class="k">max 24 h rain (${esc(s.city_forecast.rain_category)})</div></div>
        <div class="tile"><div class="v">${s.low_lying_hospitals_schools_in_high_alert_areas.length}</div><div class="k">low-lying schools/hospitals in high-alert areas</div></div>
      </div>
      ${s.suggested_pump_positions.length ? `<h4>Pre-position dewatering pumps</h4><ol>${s.suggested_pump_positions.map((p) =>
        `<li data-area="${esc(p.area_id)}"><b>${esc(p.name)}</b> · ${p.buildings.toLocaleString()} bldgs, ${p.pct_low_lying}% low-lying</li>`).join("")}</ol>` : `<h4>No pump deployment needed for the next 48 h</h4>`}
      <h4>Drains to clear first</h4><ol>${s.drains_to_clear_first.slice(0, 5).map((d) =>
        `<li data-lat="${d.lat}" data-lon="${d.lon}"><b>${esc(d.kind)}${d.name ? " · " + esc(d.name) : ""}</b> · ${esc(d.area_name)} · ${d.segments > 1 ? `${d.segments} stretches, ` : ""}up to ${d.exposed_buildings} low-lying bldgs within 100 m</li>`).join("")}</ol>
      ${s.low_lying_hospitals_schools_in_high_alert_areas.length ? `<h4>Check these facilities</h4><ol>${s.low_lying_hospitals_schools_in_high_alert_areas.slice(0, 6).map((f) =>
        `<li data-lat="${f.lat}" data-lon="${f.lon}"><b>${esc(f.name)}</b> · ${esc(f.kind)} · ${fmt(f.hand_m)} m above drain</li>`).join("")}</ol>` : ""}
      <p class="m">${esc(s.note)}</p>`;
    state.pumpMarkers.forEach((m) => m.remove());
    state.pumpMarkers = s.suggested_pump_positions.map((p) => pin(p.lon, p.lat, "🚚 Pump", "facility"));
    el.querySelectorAll("li[data-area]").forEach((li) => li.addEventListener("click", () => selectArea(li.dataset.area)));
    el.querySelectorAll("li[data-lat]").forEach((li) => li.addEventListener("click", () =>
      state.map.flyTo({ center: [+li.dataset.lon, +li.dataset.lat], zoom: 16, pitch: 50 })));
  } catch (e) { el.innerHTML = `<p class="muted">Situation unavailable: ${esc(e.message)}</p>`; }
}

function rankAreas(key) {
  const feats = state.areas.features.map((f) => f.properties).filter((p) => !p.sparsely_built);
  const val = key === "heat" ? (p) => p.heat_score * Math.min(1, p.buildings / 1500) : (p) => p[key];
  return feats.sort((a, b) => val(b) - val(a)).slice(0, 10).map((p) => ({ p, v: val(p) }));
}

function renderRanking(key) {
  if (!state.areas) return;
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.rank === key));
  const rows = rankAreas(key), max = rows[0]?.v || 1;
  $("#ranking").innerHTML = rows.map(({ p, v }) => `
    <li data-id="${esc(p.area_id)}"><div>
      <div class="n">${esc(p.name)}</div>
      <div class="s">${esc(p.area_id)} · ${p.buildings.toLocaleString()} buildings · ${key === "heat"
        ? `${fmt(p.lst_c)} °C summer surface` : `${fmt(100 * p.flood_2025_share, 0)}% under water 27 Aug 2025 · ${fmt(100 * p.low_lying_share, 0)}% low-lying`}</div>
      <div class="bar"><span style="width:${(100 * v) / max}%"></span></div></div></li>`).join("");
  document.querySelectorAll("#ranking li").forEach((li) => li.addEventListener("click", () => selectArea(li.dataset.id)));
  state.ranked = rows.map((r) => r.p.area_id);
  if (!$("#tab-command").hidden) highlight(state.ranked);
}

function showTab(tab) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab));
  document.querySelectorAll(".tab").forEach((s) => (s.hidden = s.id !== `tab-${tab}`));
  highlight(tab === "command" && state.ranked ? state.ranked : []);
  if (tab !== "command") { state.pumpMarkers.forEach((m) => m.remove()); state.pumpMarkers = []; }
  if (tab === "command") { loadSituation(); loadReports(); }
  if (isPhone() && (tab === "command" || tab === "report" || tab === "about")) document.body.classList.add("sheet-open");
}

// ---------------- UI wiring ----------------
const isPhone = () => window.matchMedia("(max-width: 760px)").matches;

function bindUi() {
  $("#sheetHandle").addEventListener("click", () => document.body.classList.toggle("sheet-open"));
  $("#legendBtn").addEventListener("click", (e) => {
    const on = document.body.classList.toggle("legend-open");
    e.currentTarget.setAttribute("aria-pressed", on);
  });
  document.querySelectorAll(".layers [data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("#toggle3d").addEventListener("click", (e) => {
    state.threeD = !state.threeD;
    e.currentTarget.setAttribute("aria-pressed", state.threeD);
    if (state.threeD) { state.map.setTerrain({ source: "terrain", exaggeration: 1.5 }); state.map.easeTo({ pitch: 62, bearing: -20, zoom: Math.max(state.map.getZoom(), 14), duration: 1400 }); }
    else { state.map.setTerrain(null); state.map.easeTo({ pitch: 0, bearing: 0, duration: 800 }); }
  });
  $("#toggleSat").addEventListener("click", (e) => {
    state.satellite = !state.satellite;
    e.currentTarget.setAttribute("aria-pressed", state.satellite);
    if (!state.mapbox) { e.currentTarget.title = "Satellite needs a Mapbox token"; return; }
    state.map.setStyle(styleUrl());   // overlays are re-added in onStyleLoad
  });
  document.querySelectorAll(".mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => renderRanking(b.dataset.rank)));
  $("#ask").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#q"); ask(q.value); q.value = ""; });
  document.querySelectorAll("#chips button").forEach((b) => b.addEventListener("click", () => {
    if (b.hasAttribute("data-locate")) locateThen(() => ask("Is my area safe? Check my location."));
    else ask(b.textContent.replace(/^📍\s*/, ""));
  }));
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) $("#mic").hidden = true;
  $("#mic").addEventListener("click", () => {
    const rec = new SR();
    rec.lang = "hi-IN"; rec.interimResults = false;
    $("#mic").classList.add("rec");
    rec.onresult = (e) => ask(e.results[0][0].transcript);
    rec.onend = () => $("#mic").classList.remove("rec");
    rec.start();
  });
  $("#photo").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $("#photo-preview").src = URL.createObjectURL(f); $("#photo-preview").hidden = false; $("#photo-label").hidden = true;
  });
  $("#report-loc").addEventListener("click", () => locateThen((l) => { setReportLoc(l.lat, l.lon, "GPS"); state.map.flyTo({ center: [l.lon, l.lat], zoom: 15 }); },
    () => ($("#report-loc-text").textContent = "Location denied. Tap the map where the problem is.")));
  $("#report-form").addEventListener("submit", submitReport);
  $("#csv").addEventListener("click", () => {
    const cols = ["area_id", "name", "buildings", "flood_score", "heat_score", "combined_score", "priority_score",
      "flood_priority_score", "flood_2025_share", "low_lying_share", "floodplain_share", "hand_median_m", "lst_c", "ndvi",
      "change_flags_flood_prone", "change_area_ha"];
    const rows = state.areas.features.map((f) => cols.map((c) => JSON.stringify(f.properties[c] ?? "")).join(","));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([[cols.join(","), ...rows].join("\n")], { type: "text/csv" }));
    a.download = "tawi_twin_areas.csv"; a.click();
  });
  const closeIntro = () => { $("#intro").hidden = true; localStorage.setItem("tt_intro_seen", "1"); };
  $("#intro-replay").addEventListener("click", async () => {
    closeIntro(); await setMode("replay"); setView("risk");
    ask("Kal Bhagwati Nagar mein paani bharega kya?");
  });
  $("#intro-live").addEventListener("click", () => { closeIntro(); locateThen(() => ask("Is my area safe? Check my location.")); });
}

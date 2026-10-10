// Shared timing, easing, palette and data loading for the launch film.
import {continueRender, delayRender, Easing, staticFile} from 'remotion';
import {loadFont as geist} from '@remotion/google-fonts/Geist';
import {loadFont as geistMono} from '@remotion/google-fonts/GeistMono';
import {loadFont as serif} from '@remotion/google-fonts/InstrumentSerif';
import {loadFont as deva} from '@remotion/google-fonts/NotoSansDevanagari';
import timeline from './timeline.json';

export const FPS = 60;
export const W = 1920;
export const H = 1080;
export const END = timeline.end;

export const F = {
	sans: geist('normal', {weights: ['400', '500', '600', '700', '800', '900'], subsets: ['latin']}).fontFamily,
	mono: geistMono('normal', {weights: ['400', '500'], subsets: ['latin']}).fontFamily,
	serif: serif('italic', {subsets: ['latin']}).fontFamily,
	deva: deva('normal', {weights: ['500', '700'], subsets: ['devanagari']}).fontFamily,
};

export const C = {
	ink: '#0b0d11',
	ink2: '#14171d',
	paper: '#f2f1ec',
	paper2: '#e4e3dc',
	water: '#2f6bff',
	waterSoft: '#7aa2ff',
	red: '#ff3b2f',
	orange: '#ff7a3d',
	amber: '#ffbf2e',
	green: '#1fd17a',
	grey: '#3a3f4a',
	wa: '#25d366',
};
export const RISK = ['#363b46', C.amber, C.orange, C.red];

// One curve everywhere: slow out, long settle.
export const ease = Easing.bezier(0.45, 0, 0.15, 1);
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
/** eased 0..1 progress of a move starting at `start` seconds lasting `dur` */
export const prog = (t: number, start: number, dur = 0.8, e = ease) => e(clamp((t - start) / dur));
/** fade in at a, out at b */
export const win = (t: number, a: number, b: number, fi = 0.4, fo = 0.4) =>
	Math.min(prog(t, a, fi), 1 - prog(t, b - fo, fo));

type Scene = {n: number; start: number; dur: number; words: [number, number, string][]};
const scenes = timeline.scenes as Scene[];
export const sceneStart = (n: number) => scenes[n - 1].start;
export const sceneEnd = (n: number) => scenes[n - 1].start + scenes[n - 1].dur;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** global time (s) when narration scene `n` says `word` (nth occurrence) */
export const cue = (n: number, word: string, nth = 0): number => {
	const hits = scenes[n - 1].words.filter((w) => norm(w[2]) === norm(word));
	const w = hits[nth] ?? hits[hits.length - 1];
	if (!w) throw new Error(`cue ${n} ${word}`);
	return w[0];
};
export const cueEnd = (n: number, word: string, nth = 0): number => {
	const hits = scenes[n - 1].words.filter((w) => norm(w[2]) === norm(word));
	return (hits[nth] ?? hits[hits.length - 1])[1];
};

// ---------- data ----------
export type Area = {id: string; name: string; tier: string; flood: number; rank: number; bldg: number; c: [number, number]; p: [number, number][]};
export type Layers = {
	areas: Area[];
	river: [number, number][][];
	flood: [number, number][][];
	drains: {rank: number; name: string; l: [number, number][]}[];
	reported: {name: string; in: boolean; c: [number, number]}[];
};
export type Data = {
	layers: Layers;
	n: number;
	bx: Float32Array;
	by: Float32Array;
	bc: Uint8Array;
	bw: Uint8Array;
	bs: Float32Array;
	bd: Float32Array; // distance to river (m), for the reveal wave
	replay: Record<string, {w: string}>;
	bhag: Area;
	bhagPt: [number, number];
};

let cache: Data | null = null;
let pending: Promise<Data> | null = null;

const inPoly = (x: number, y: number, p: [number, number][]) => {
	let inside = false;
	for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
		const [xi, yi] = p[i];
		const [xj, yj] = p[j];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
};

async function load(): Promise<Data> {
	const [layers, buf, replay] = await Promise.all([
		fetch(staticFile('data/layers.json')).then((r) => r.json()),
		fetch(staticFile('data/buildings.bin')).then((r) => r.arrayBuffer()),
		fetch(staticFile('data/alerts_replay.json')).then((r) => r.json()),
	]);
	const dv = new DataView(buf);
	const n = buf.byteLength / 7;
	const bx = new Float32Array(n), by = new Float32Array(n), bs = new Float32Array(n), bd = new Float32Array(n);
	const bc = new Uint8Array(n), bw = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		const o = i * 7;
		bx[i] = dv.getInt16(o, true) * 4;
		by[i] = dv.getInt16(o + 2, true) * 4;
		bc[i] = dv.getUint8(o + 4);
		bw[i] = dv.getUint8(o + 5);
		bs[i] = dv.getUint8(o + 6);
	}
	// distance to the river centreline, approximated by the nearest riverbed vertex (coarse grid lookup)
	const rv: [number, number][] = [];
	(layers as Layers).river.forEach((p) => p.forEach((q) => rv.push(q)));
	const G = 400, grid = new Map<string, [number, number][]>();
	rv.forEach((q) => {
		const k = `${Math.floor(q[0] / G)},${Math.floor(q[1] / G)}`;
		if (!grid.has(k)) grid.set(k, []);
		grid.get(k)!.push(q);
	});
	for (let i = 0; i < n; i++) {
		const gx = Math.floor(bx[i] / G), gy = Math.floor(by[i] / G);
		let best = 1e12;
		for (let r = 0; r < 12 && best > (r * G) ** 2; r++) {
			for (let dx = -r; dx <= r; dx++)
				for (let dy = -r; dy <= r; dy++) {
					if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
					const cell = grid.get(`${gx + dx},${gy + dy}`);
					if (!cell) continue;
					for (const q of cell) {
						const d = (q[0] - bx[i]) ** 2 + (q[1] - by[i]) ** 2;
						if (d < best) best = d;
					}
				}
		}
		bd[i] = Math.sqrt(best);
	}
	const L = layers as Layers;
	const bhagPt = L.reported.find((r) => r.name === 'Bhagwati Nagar')!.c;
	const bhag = L.areas.find((a) => inPoly(bhagPt[0], bhagPt[1], a.p)) ?? L.areas[0];
	return {layers: L, n, bx, by, bc, bw, bs, bd, replay: replay.areas, bhag, bhagPt};
}

export const useDataOnce = (): Promise<Data> => {
	if (cache) return Promise.resolve(cache);
	if (!pending) {
		const h = delayRender('data');
		pending = load().then((d) => {
			cache = d;
			continueRender(h);
			return d;
		});
	}
	return pending;
};
export const getData = () => cache;

// The city: 188,180 real buildings on a canvas plus vector layers in SVG, under one camera.
import React, {useEffect, useRef} from 'react';
import {C, Data, H, RISK, W} from './lib';

export type Cam = {x: number; y: number; z: number; rot: number; tilt: number};

export type MapProps = {
	d: Data;
	cam: Cam;
	opacity: number;
	bAlpha: number; // buildings
	reveal: number; // metres from river that have turned risk-coloured; <0 none, 1e9 all
	calm: number; // 0..1 blend everything to quiet green (live mode, dry day)
	focusHigh: number; // 0..1 dim buildings outside replay high-alert areas
	riverAlpha: number;
	riverDraw: number; // 0..1 outline draw-on
	riverRise: number; // 0..1 flood swell of the river (stroke width)
	floodAlpha: number;
	floodSweep: number; // 0..1 radar sweep reveals flood polygons
	hexAlpha: number;
	hexMode: 'outline' | 'replay' | 'live';
	hexReveal: number; // 0..1 hexes pop in by distance from bhagwati
	hexFocus: number; // 0..1 highlight Bhagwati hex
	drains: number; // 0..1 draw drains in rank order
	reported: number; // 0..1 reported pins drop
	rings: number; // 0..1 river distance rings
	children?: React.ReactNode; // world-space overlay (receives same transform)
};

export const project = (cam: Cam, x: number, y: number) => {
	const r = (cam.rot * Math.PI) / 180;
	const dx = (x - cam.x) * cam.z, dy = (y - cam.y) * cam.z;
	return [W / 2 + dx * Math.cos(r) - dy * Math.sin(r), H / 2 + dx * Math.sin(r) + dy * Math.cos(r)];
};

const path = (pts: [number, number][], close = true) =>
	'M' + pts.map((p) => `${p[0]},${p[1]}`).join('L') + (close ? 'Z' : '');

const hexColor = (mode: MapProps['hexMode'], level: string | undefined) => {
	if (mode === 'live') return C.green;
	if (mode === 'replay') return level === 'high' ? C.red : level === 'medium' ? C.amber : C.green;
	return '#ffffff';
};

export const CityMap: React.FC<MapProps> = (p) => {
	const ref = useRef<HTMLCanvasElement>(null);
	const {d, cam} = p;

	useEffect(() => {
		const cv = ref.current;
		if (!cv) return;
		const g = cv.getContext('2d')!;
		g.setTransform(1, 0, 0, 1, 0, 0);
		g.clearRect(0, 0, W, H);
		if (p.bAlpha <= 0.001) return;
		const r = (cam.rot * Math.PI) / 180;
		g.setTransform(cam.z * Math.cos(r), cam.z * Math.sin(r), -cam.z * Math.sin(r), cam.z * Math.cos(r), W / 2, H / 2);
		g.translate(-cam.x, -cam.y);
		// cull to the visible box (generous for rotation/tilt)
		const half = (Math.hypot(W, H) / cam.z) * 0.75;
		const x0 = cam.x - half, x1 = cam.x + half, y0 = cam.y - half, y1 = cam.y + half;
		const minPx = 1.25 / cam.z;
		const scale = 0.62;
		const {n, bx, by, bc, bs, bd} = d;
		const high = p.focusHigh > 0 ? highMask(d) : null;
		const greyCol = RISK[0];
		const calm = p.calm;
		for (let pass = 0; pass < 2; pass++) {
			// pass 0: grey (unrevealed / dimmed); pass 1: coloured
			for (let cls = 0; cls < 4; cls++) {
				const col = pass === 0 ? greyCol : calm > 0.5 ? (cls === 0 ? greyCol : '#2c6e55') : RISK[cls];
				g.fillStyle = col;
				g.globalAlpha = p.bAlpha * (pass === 0 ? 0.9 : 1);
				for (let i = 0; i < n; i++) {
					if (bc[i] !== cls) continue;
					const x = bx[i], y = by[i];
					if (x < x0 || x > x1 || y < y0 || y > y1) continue;
					const coloured = bd[i] < p.reveal && !(high && p.focusHigh > 0.5 && !high[i]);
					if ((pass === 1) !== coloured) continue;
					if (pass === 1 && cls === 0) continue; // lower-risk stays grey
					const s = Math.max(minPx, bs[i] * scale);
					g.fillRect(x - s / 2, y - s / 2, s, s);
				}
			}
		}
	});

	const t = `translate(${W / 2} ${H / 2}) rotate(${cam.rot}) scale(${cam.z}) translate(${-cam.x} ${-cam.y})`;
	const L = d.layers;
	const nr = 1 / cam.z; // one screen pixel in world units
	const bh = d.bhag;
	return (
		<div
			style={{
				position: 'absolute',
				inset: 0,
				opacity: p.opacity,
				transform: `perspective(1800px) rotateX(${cam.tilt}deg)`,
				transformOrigin: '50% 60%',
			}}
		>
			<svg width={W} height={H} style={{position: 'absolute', inset: 0}}>
				<defs>
					<radialGradient id="ringg">
						<stop offset="0" stopColor={C.water} stopOpacity="0" />
						<stop offset="1" stopColor={C.water} stopOpacity="0.25" />
					</radialGradient>
				</defs>
				<g transform={t}>
					{/* river */}
					{p.riverAlpha > 0 &&
						L.river.map((poly, i) => (
							<path
								key={i}
								d={path(poly)}
								fill={C.water}
								fillOpacity={p.riverAlpha * (0.18 + 0.4 * p.riverRise) * Math.min(1, p.riverDraw * 1.5)}
								stroke={C.waterSoft}
								strokeWidth={(1.5 + p.riverRise * 10) * nr}
								strokeOpacity={p.riverAlpha}
								pathLength={1}
								strokeDasharray="1 1"
								strokeDashoffset={1 - p.riverDraw}
								strokeLinejoin="round"
							/>
						))}
					{/* distance rings around river */}
					{p.rings > 0 &&
						[150, 300, 600].map((m, i) =>
							L.river.map((poly, j) => (
								<path
									key={`${i}-${j}`}
									d={path(poly)}
									fill="none"
									stroke={C.waterSoft}
									strokeOpacity={0.35 * p.rings * (1 - i * 0.25)}
									strokeWidth={m * 2 * Math.min(1, p.rings * (1.6 - i * 0.2))}
									strokeLinejoin="round"
									style={{mixBlendMode: 'screen'}}
								/>
							)),
						)}
					{/* hexes */}
					{p.hexAlpha > 0 &&
						L.areas.map((a) => {
							const dist = Math.hypot(a.c[0] - bh.c[0], a.c[1] - bh.c[1]);
							const k = Math.min(1, Math.max(0, (p.hexReveal * 14000 - dist) / 1500));
							if (k <= 0) return null;
							const lvl = d.replay[a.id]?.w;
							const col = hexColor(p.hexMode, lvl);
							const isHigh = p.hexMode === 'replay' && lvl === 'high';
							return (
								<path
									key={a.id}
									d={path(a.p)}
									fill={col}
									fillOpacity={p.hexAlpha * k * (p.hexMode === 'outline' ? 0 : isHigh ? 0.32 : 0.1)}
									stroke={col}
									strokeOpacity={p.hexAlpha * k * (isHigh ? 0.95 : 0.35)}
									strokeWidth={(isHigh ? 2 : 1) * nr}
								/>
							);
						})}
					{/* radar-observed water, 27 Aug 2025 */}
					{p.floodAlpha > 0 &&
						L.flood.map((poly, i) => {
							const a = (Math.atan2(poly[0][1] - 0, poly[0][0] - 0) + Math.PI) / (2 * Math.PI);
							if (a > p.floodSweep) return null;
							return <path key={i} d={path(poly)} fill="#4f8cff" fillOpacity={p.floodAlpha * 0.85} stroke="#a9c4ff" strokeWidth={1 * nr} strokeOpacity={p.floodAlpha} />;
						})}
				</g>
			</svg>
			<canvas ref={ref} width={W} height={H} style={{position: 'absolute', inset: 0}} />
			<svg width={W} height={H} style={{position: 'absolute', inset: 0, overflow: 'visible'}}>
				<g transform={t}>
					{p.hexFocus > 0 && (
						<path
							d={path(bh.p)}
							fill="none"
							stroke="#fff"
							strokeWidth={4 * nr}
							pathLength={1}
							strokeDasharray="1 1"
							strokeDashoffset={1 - p.hexFocus}
						/>
					)}
					{/* priority drains */}
					{p.drains > 0 &&
						L.drains.map((dr) => {
							const k = Math.min(1, Math.max(0, p.drains * 1.6 - (dr.rank / L.drains.length) * 0.6));
							if (k <= 0) return null;
							return (
								<path
									key={dr.rank}
									d={path(dr.l, false)}
									fill="none"
									stroke={dr.rank <= 10 ? C.water : '#9fb6ff'}
									strokeWidth={(dr.rank <= 10 ? 5 : 2.5) * nr}
									strokeLinecap="round"
									pathLength={1}
									strokeDasharray="1 1"
									strokeDashoffset={1 - k}
								/>
							);
						})}
					{p.children}
				</g>
			</svg>
		</div>
	);
};

// buildings inside replay high-alert areas (by nearest area centre; cached)
let maskCache: Uint8Array | null = null;
const highMask = (d: Data) => {
	if (maskCache) return maskCache;
	const hi = d.layers.areas.filter((a) => d.replay[a.id]?.w === 'high');
	const m = new Uint8Array(d.n);
	for (let i = 0; i < d.n; i++) {
		for (const a of hi) {
			const dx = d.bx[i] - a.c[0], dy = d.by[i] - a.c[1];
			if (dx * dx + dy * dy < 420 * 420) {
				m[i] = 1;
				break;
			}
		}
	}
	maskCache = m;
	return m;
};

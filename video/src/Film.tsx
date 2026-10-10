// Tawi Twin launch film. One continuous take: every scene grows out of the last,
// every hit is cued to a word of the narration (timeline.json, from the voice track).
import React, {useEffect, useState} from 'react';
import {AbsoluteFill, continueRender, delayRender, useCurrentFrame} from 'remotion';
import {Cam, CityMap, MapProps, project} from './Map';
import {C, clamp, cue, Data, ease, easeOut, END, F, FPS, getData, H, lerp, prog, sceneStart, useDataOnce, W, win} from './lib';
import {Abs, Center, count, Cursor, fmt, HUD, lift, Phone, Pill, Ripple, Rise, Tool, typed} from './ui';

// ---------------- world layers (circle reveals) ----------------
type Layer = {from: number; bg: string; dark: boolean; o: [number, number]; dur?: number; render: (t: number, d: Data) => React.ReactNode};

const Reveal: React.FC<{t: number; L: Layer; children: React.ReactNode}> = ({t, L, children}) => {
	const k = prog(t, L.from, L.dur ?? 0.8);
	const r = k * Math.hypot(W, H) * 1.05;
	return (
		<AbsoluteFill style={{background: L.bg, clipPath: k >= 1 ? undefined : `circle(${r}px at ${L.o[0]}px ${L.o[1]}px)`}}>
			{children}
		</AbsoluteFill>
	);
};

// ---------------- camera ----------------
type Move = {at: number; dur: number; to: Partial<Cam>};
const cam = (t: number, init: Cam, moves: Move[]): Cam => {
	let s = {...init};
	for (const m of moves) {
		const k = prog(t, m.at, m.dur);
		if (k <= 0) break;
		const tgt = {...s, ...m.to};
		s = {
			x: lerp(s.x, tgt.x, k),
			y: lerp(s.y, tgt.y, k),
			z: Math.exp(lerp(Math.log(s.z), Math.log(tgt.z), k)),
			rot: lerp(s.rot, tgt.rot, k),
			tilt: lerp(s.tilt, tgt.tilt, k),
		};
	}
	return s;
};

const baseMap = (d: Data, c: Cam): MapProps => ({
	d,
	cam: c,
	opacity: 1,
	bAlpha: 0,
	reveal: -1,
	calm: 0,
	focusHigh: 0,
	riverAlpha: 0,
	riverDraw: 0,
	riverRise: 0,
	floodAlpha: 0,
	floodSweep: 0,
	hexAlpha: 0,
	hexMode: 'outline',
	hexReveal: 0,
	hexFocus: 0,
	drains: 0,
	reported: 0,
	rings: 0,
});

const CITY: Cam = {x: 0, y: -300, z: 0.068, rot: 0, tilt: 0};
const FAC = {
	hospital: {name: 'Suri Nursing Home', km: '1.1 km', c: [-1745, -2005] as [number, number]},
	school: {name: 'Hari Singh High School', km: '1.7 km', c: [-146, -1813] as [number, number]},
	college: {name: 'Govt Gandhi Memorial Science College', c: [-1407, -1295] as [number, number]},
	dogra: {name: 'Dogra Higher Secondary School', c: [-504, 1912] as [number, number]},
};

// a label pinned to a world point, drawn in screen space
const WorldTag: React.FC<{c: Cam; p: [number, number]; k: number; children: React.ReactNode; dx?: number; dy?: number; dot?: string}> = ({c, p, k, children, dx = 18, dy = -18, dot = '#fff'}) => {
	if (k <= 0) return null;
	const [x, y] = project(c, p[0], p[1]);
	return (
		<>
			<div style={{position: 'absolute', left: x - 9, top: y - 9, width: 18, height: 18, borderRadius: 9, background: dot, border: '3px solid #0b0d11', transform: `scale(${easeOut(clamp(k * 1.4))})`, boxShadow: '0 0 0 6px rgba(255,255,255,.12)'}} />
			<div
				style={{
					position: 'absolute',
					left: x + dx,
					top: y + dy - 22,
					opacity: k,
					transform: `translateY(${(1 - k) * 14}px)`,
					background: 'rgba(11,13,17,0.82)',
					border: '1px solid rgba(255,255,255,.14)',
					borderRadius: 12,
					padding: '10px 16px',
					color: '#fff',
					fontFamily: F.sans,
					fontSize: 22,
					fontWeight: 600,
					whiteSpace: 'nowrap',
					boxShadow: lift(k, true),
				}}
			>
				{children}
			</div>
		</>
	);
};

const Mono: React.FC<{children: React.ReactNode; style?: React.CSSProperties; color?: string; size?: number}> = ({children, style, color = 'rgba(255,255,255,.6)', size = 18}) => (
	<div style={{fontFamily: F.mono, fontSize: size, letterSpacing: '0.1em', textTransform: 'uppercase', color, ...style}}>{children}</div>
);

// ---------------- 00 cold open + 01 the night ----------------
const rain = (t: number, intensity: number, color = 'rgba(160,190,255,0.5)', angle = 12) => {
	const n = Math.floor(160 * intensity);
	const out: React.ReactNode[] = [];
	for (let i = 0; i < n; i++) {
		const seed = Math.sin(i * 91.7) * 43758.5453;
		const r = seed - Math.floor(seed);
		const r2 = Math.sin(i * 12.9) * 0.5 + 0.5;
		const speed = 1600 + r2 * 900;
		const len = 40 + r * 90;
		const x = (r * (W + 400)) - 200;
		const y = ((t * speed + r2 * 3000) % (H + 400)) - 200;
		out.push(<div key={i} style={{position: 'absolute', left: x + y * Math.tan((angle * Math.PI) / 180), top: y, width: 2, height: len, background: color, transform: `rotate(${-angle}deg)`, borderRadius: 2}} />);
	}
	return out;
};

const Night: React.FC<{t: number}> = ({t}) => {
	const i = clamp(t / 2.4) * 0.6 + prog(t, cue(1, '296'), 1.5) * 0.4;
	const dateIn = cue(1, '26th');
	const numAt = cue(1, '296');
	const lift1 = prog(t, cue(1, 'jammu') - 0.2, 0.8);
	const v = count(t, numAt, 1.6, 296);
	const ring = prog(t, cue(1, '24'), 1.4, ease);
	const gauge = clamp(v / 296);
	return (
		<AbsoluteFill>
			<AbsoluteFill style={{opacity: 1 - prog(t, cue(1, 'new'), 0.3)}}>{rain(t, i)}</AbsoluteFill>
			<Center>
				<Mono style={{opacity: win(t, 0.3, dateIn, 0.6, 0.4), marginBottom: 20}} size={22}>
					25.08.2025 · 23:40 IST · Jammu
				</Mono>
			</Center>
			{/* date */}
			<Abs style={{left: 160, top: lerp(410, 170, lift1), transform: `scale(${lerp(1, 0.42, lift1)})`, transformOrigin: 'left top'}}>
				<Rise t={t} at={dateIn} text="26 August 2025" size={150} weight={800} />
			</Abs>
			{/* 296 mm */}
			{t > numAt - 0.1 && (
				<Abs style={{left: 150, top: 300}}>
					<Mono style={{opacity: prog(t, cue(1, 'jammu'), 0.5)}} size={22}>
						Jammu got
					</Mono>
					<div style={{display: 'flex', alignItems: 'baseline', gap: 26}}>
						<div style={{fontFamily: F.sans, fontWeight: 900, fontSize: 380, letterSpacing: '-0.06em', color: '#fff', lineHeight: 1, fontVariantNumeric: 'tabular-nums', transform: `translateY(${(1 - prog(t, numAt, 0.5, easeOut)) * 60}px)`}}>
							{fmt(v)}
						</div>
						<div style={{fontFamily: F.serif, fontStyle: 'italic', fontSize: 160, color: C.waterSoft, opacity: prog(t, cue(1, 'mm'), 0.5)}}>mm</div>
					</div>
					<Rise t={t} at={cue(1, 'rain')} text="of rain in 24 hours." size={64} weight={600} color="rgba(255,255,255,.85)" />
				</Abs>
			)}
			{/* 24 h ring + gauge */}
			{t > numAt - 0.1 && (
				<Abs style={{right: 220, top: 230}}>
					<svg width={520} height={620} viewBox="0 0 520 620">
						<circle cx={260} cy={260} r={220} fill="none" stroke="rgba(255,255,255,.1)" strokeWidth={2} />
						<circle cx={260} cy={260} r={220} fill="none" stroke={C.water} strokeWidth={6} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - ring} transform="rotate(-90 260 260)" strokeLinecap="round" />
						{Array.from({length: 24}).map((_, h) => {
							const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
							return <line key={h} x1={260 + Math.cos(a) * 200} y1={260 + Math.sin(a) * 200} x2={260 + Math.cos(a) * (h % 6 ? 190 : 180)} y2={260 + Math.sin(a) * (h % 6 ? 190 : 180)} stroke="rgba(255,255,255,.4)" strokeWidth={2} />;
						})}
						{/* gauge cylinder */}
						<rect x={225} y={110} width={70} height={300} rx={35} fill="none" stroke="rgba(255,255,255,.35)" strokeWidth={2} />
						<rect x={231} y={404 - 288 * gauge} width={58} height={288 * gauge} rx={29} fill={C.water} />
						<text x={260} y={470} fill="rgba(255,255,255,.55)" fontFamily={F.mono} fontSize={18} textAnchor="middle" letterSpacing="2">
							RAIN GAUGE · 24 H
						</text>
						<text x={260} y={500} fill="rgba(255,255,255,.4)" fontFamily={F.mono} fontSize={15} textAnchor="middle" letterSpacing="2">
							{`00:00 → ${String(Math.floor(ring * 24)).padStart(2, '0')}:00`}
						</text>
					</svg>
				</Abs>
			)}
		</AbsoluteFill>
	);
};

const Record: React.FC<{t: number}> = ({t}) => {
	const at = cue(1, 'record');
	const k = prog(t, at - 0.05, 0.35, easeOut);
	return (
		<Center>
			<div style={{fontFamily: F.sans, fontWeight: 900, fontSize: 380, letterSpacing: '-0.07em', color: C.ink, transform: `scale(${lerp(1.35, 1, k)})`, opacity: clamp(k * 3), lineHeight: 0.9}}>RECORD.</div>
			<Mono color="rgba(11,13,17,.7)" size={22} style={{marginTop: 30, opacity: prog(t, at + 0.3, 0.4)}}>
				296 mm in 24 h · IMD gauge, Jammu · 26 Aug 2025
			</Mono>
		</Center>
	);
};

// river cross-section -> plan view -> bridge -> evacuations
const River: React.FC<{t: number; d: Data}> = ({t, d}) => {
	const t0 = cue(1, 'tavi');
	const hfl = cue(1, 'highest');
	const plan = cue(1, 'part');
	const level = lerp(0.2, 0.62, prog(t, t0, 1.1)) + lerp(0, 0.2, prog(t, hfl, 0.9));
	const toPlan = prog(t, plan - 0.2, 0.8);
	const bp = d.bhagPt;
	const c = cam(t, {x: bp[0], y: bp[1], z: 0.9, rot: -20, tilt: 0}, [
		{at: plan - 0.2, dur: 1.4, to: {z: 0.42, rot: -10}},
		{at: cue(1, '5'), dur: 2.6, to: {z: 0.16, rot: 0, tilt: 28}},
	]);
	const mp = {
		...baseMap(d, c),
		opacity: toPlan,
		riverAlpha: 1,
		riverDraw: prog(t, plan - 0.1, 1.2),
		riverRise: 0.4 + 0.6 * prog(t, plan, 1),
		bAlpha: prog(t, cue(1, '5') - 0.2, 1.2) * 0.9,
		reveal: -1,
	};
	// bridge across the river at Bhagwati Nagar
	const br = bridge(d);
	const bk = prog(t, cue(1, '4th'), 0.6);
	const brk = prog(t, cue(1, 'gateway') - 0.05, 0.7, easeOut);
	const [ax, ay] = project(c, br.a[0], br.a[1]);
	const [bx2, by2] = project(c, br.b[0], br.b[1]);
	const mx = (ax + bx2) / 2, my = (ay + by2) / 2;
	const evac = count(t, cue(1, '5'), 1.4, 5000);
	return (
		<AbsoluteFill>
			{/* cross-section */}
			<AbsoluteFill style={{opacity: 1 - toPlan}}>
				<svg width={W} height={H}>
					<path d="M160 330 C 560 330, 620 860, 960 860 C 1300 860, 1360 330, 1760 330" fill="none" stroke="rgba(255,255,255,.5)" strokeWidth={3} />
					<clipPath id="chan">
						<path d="M160 330 C 560 330, 620 860, 960 860 C 1300 860, 1360 330, 1760 330 L1760 0 L160 0Z" />
					</clipPath>
					<g clipPath="url(#chan)">
						<rect x={0} y={860 - 530 * level} width={W} height={H} fill={C.water} opacity={0.85} />
						<rect x={0} y={860 - 530 * level} width={W} height={4} fill="#bcd0ff" />
					</g>
					<line x1={260} x2={1660} y1={860 - 530 * 0.7} y2={860 - 530 * 0.7} stroke={C.red} strokeWidth={3} strokeDasharray="14 10" opacity={prog(t, hfl - 0.4, 0.4)} />
					<text x={1660} y={860 - 530 * 0.7 - 16} fill={C.red} fontFamily={F.mono} fontSize={20} textAnchor="end" letterSpacing="2" opacity={prog(t, hfl - 0.4, 0.4)}>
						HIGHEST FLOOD LEVEL
					</text>
				</svg>
				<Abs style={{left: 160, top: 150}}>
					<Mono size={20}>Tawi River · Jammu</Mono>
					<Rise t={t} at={t0 + 0.2} text="The Tawi rose" size={92} />
					<Rise t={t} at={hfl} text="above its highest flood level." size={92} accent={{'highest': C.red}} />
				</Abs>
			</AbsoluteFill>
			{/* plan view: real riverbed + bridge */}
			<CityMap {...mp} />
			{toPlan > 0 && (
				<svg width={W} height={H} style={{position: 'absolute', inset: 0, opacity: toPlan}}>
					{(() => {
						const gap = brk * 70;
						const ux = (bx2 - ax) / Math.hypot(bx2 - ax, by2 - ay), uy = (by2 - ay) / Math.hypot(bx2 - ax, by2 - ay);
						const l1 = [ax, ay, mx - ux * gap, my - uy * gap];
						const l2 = [mx + ux * gap, my + uy * gap, bx2, by2];
						return (
							<g opacity={bk}>
								<line x1={l1[0]} y1={l1[1]} x2={lerp(l1[0], l1[2], bk)} y2={lerp(l1[1], l1[3], bk)} stroke="#fff" strokeWidth={10} strokeLinecap="round" transform={`rotate(${brk * 7} ${l1[0]} ${l1[1]})`} />
								<line x1={l2[2]} y1={l2[3]} x2={lerp(l2[2], l2[0], bk)} y2={lerp(l2[3], l2[1], bk)} stroke={brk > 0 ? C.red : '#fff'} strokeWidth={10} strokeLinecap="round" transform={`rotate(${-brk * 9} ${l2[2]} ${l2[3]})`} />
							</g>
						);
					})()}
				</svg>
			)}
			{toPlan > 0 && (
				<>
					<WorldTag c={c} p={br.b} k={bk * (1 - prog(t, cue(1, '5'), 0.5))} dot={C.red}>
						4th Tawi Bridge {brk > 0.2 && <span style={{color: C.red}}>· gave way</span>}
					</WorldTag>
					<Abs style={{left: 150, bottom: 150, opacity: prog(t, cue(1, '5') - 0.1, 0.5)}}>
						<div style={{fontFamily: F.sans, fontWeight: 900, fontSize: 200, letterSpacing: '-0.06em', color: '#fff', lineHeight: 1, fontVariantNumeric: 'tabular-nums'}}>{fmt(evac)}+</div>
						<Rise t={t} at={cue(1, 'people')} text="people evacuated." size={56} weight={600} color="rgba(255,255,255,.85)" />
					</Abs>
				</>
			)}
		</AbsoluteFill>
	);
};

let bridgeCache: {a: [number, number]; b: [number, number]} | null = null;
const bridge = (d: Data) => {
	if (bridgeCache) return bridgeCache;
	const bp = d.bhagPt;
	const pts: [number, number][] = [];
	d.layers.river.forEach((p) => p.forEach((q) => Math.hypot(q[0] - bp[0], q[1] - bp[1]) < 900 && pts.push(q)));
	const mx = pts.reduce((s, q) => s + q[0], 0) / pts.length, my = pts.reduce((s, q) => s + q[1], 0) / pts.length;
	let sxx = 0, sxy = 0, syy = 0;
	pts.forEach((q) => {
		sxx += (q[0] - mx) ** 2;
		syy += (q[1] - my) ** 2;
		sxy += (q[0] - mx) * (q[1] - my);
	});
	const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); // river axis
	const nx = -Math.sin(ang), ny = Math.cos(ang); // perpendicular
	const L = 420;
	bridgeCache = {a: [mx - nx * L, my - ny * L], b: [mx + nx * L, my + ny * L]};
	return bridgeCache;
};

// ---------------- 02 the gap (paper) ----------------
const Gap: React.FC<{t: number}> = ({t}) => {
	const s = sceneStart(2);
	const city = cue(2, 'city');
	const out = prog(t, cue(2, 'tavi') - 0.45, 0.4, ease);
	const phoneOut = prog(t, city - 0.3, 0.8);
	return (
		<AbsoluteFill style={{transform: `scale(${1 - out})`, transformOrigin: '50% 50%', opacity: 1 - out}}>
			<Phone x={lerp(560, -300, phoneOut)} y={560} light>
				<div style={{position: 'absolute', inset: 0, background: 'linear-gradient(180deg,#dfe4ea,#c9d0d8)'}} />
				<Abs style={{left: 0, right: 0, top: 120, textAlign: 'center', fontFamily: F.sans, color: '#111'}}>
					<div style={{fontSize: 26, fontWeight: 500, opacity: 0.6}}>Tuesday, 26 August</div>
					<div style={{fontSize: 120, fontWeight: 700, letterSpacing: '-0.04em'}}>05:40</div>
				</Abs>
				<Abs style={{left: 24, right: 24, top: 420, padding: 22, borderRadius: 26, background: 'rgba(255,255,255,.6)', fontFamily: F.sans, fontSize: 22, color: '#555', textAlign: 'center', opacity: prog(t, s + 0.4, 0.5)}}>
					No notifications
				</Abs>
			</Phone>
			<Abs style={{left: lerp(900, 340, phoneOut), top: 330, width: 900}}>
				<Mono color="rgba(11,13,17,.5)" size={20} style={{opacity: 1 - phoneOut}}>
					Residents
				</Mono>
				<Rise t={t} at={cue(2, 'no')} out={city - 0.6} text="No warning for their own street." size={110} color={C.ink} italicWords={['street.']} />
			</Abs>
			{/* the missing list */}
			<Abs style={{left: 960 - 380, top: 250, width: 760, opacity: phoneOut, transform: `translateY(${(1 - phoneOut) * 80}px)`}}>
				<Mono color="rgba(11,13,17,.5)" size={20}>
					The city · morning of 26 Aug
				</Mono>
				<div style={{fontFamily: F.sans, fontWeight: 800, fontSize: 72, letterSpacing: '-0.045em', color: C.ink, margin: '12px 0 28px'}}>No list.</div>
				{[
					['Send pumps to', cue(2, 'pumps')],
					['Clear drains first at', cue(2, 'trains')],
					['Check schools at', cue(2, 'first')],
				].map(([label, at], i) => {
					const k = prog(t, (at as number) - 0.15, 0.6, easeOut);
					const blink = Math.floor((t - (at as number)) * 3) % 2 === 0;
					return (
						<div key={i} style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '26px 30px', marginBottom: 16, background: '#fff', borderRadius: 20, boxShadow: lift(k * 0.6), opacity: k, transform: `translateX(${(1 - k) * 60}px)`, fontFamily: F.sans, fontSize: 36, fontWeight: 600, color: C.ink}}>
							<span>{label}</span>
							<span style={{fontFamily: F.mono, color: C.red, opacity: blink ? 1 : 0.25}}>???</span>
						</div>
					);
				})}
			</Abs>
		</AbsoluteFill>
	);
};

// ---------------- 02b title drop + 03 replay (dark map) ----------------
const TitleAndReplay: React.FC<{t: number; d: Data}> = ({t, d}) => {
	const drop = cue(2, 'tavi');
	const rp = cue(3, 'replay');
	const agent = cue(3, 'agent');
	const bp = d.bhagPt;
	const c = cam(t, {...CITY, z: 0.11, rot: -14, tilt: 38}, [
		{at: drop, dur: 3.4, to: {z: 0.07, rot: 0, tilt: 18}},
		{at: rp, dur: 2.0, to: {z: 0.085, tilt: 0, x: -900, y: -900}},
		{at: cue(3, 'colony') - 0.5, dur: 1.8, to: {x: bp[0] + 250, y: bp[1] + 120, z: 0.62, rot: -8, tilt: 32}},
		{at: cue(3, 'why'), dur: 1.4, to: {x: bp[0] + 700, y: bp[1] + 250, z: 0.42, rot: 0, tilt: 26}},
		{at: cue(3, 'then'), dur: 1.4, to: {x: bp[0] + 1000, y: bp[1] - 100, z: 0.3, rot: 0, tilt: 20}},
	]);
	const replayK = prog(t, rp, 1.2);
	const mp: MapProps = {
		...baseMap(d, c),
		bAlpha: 1,
		reveal: lerp(0, 9000, prog(t, drop, 2.8, easeOut)),
		riverAlpha: 1,
		riverDraw: 1,
		riverRise: 0.1,
		hexAlpha: replayK * 0.9,
		hexMode: 'replay',
		hexReveal: prog(t, rp + 0.3, 2.0),
		hexFocus: prog(t, cue(3, 'colony'), 1.0),
		floodAlpha: prog(t, cue(3, 'satellites'), 0.5) * (1 - prog(t, cue(3, 'then'), 0.6)),
		floodSweep: prog(t, cue(3, 'satellites'), 1.4, ease),
	};
	// title
	const titleOut = prog(t, cue(2, 'for', 2) - 0.1, 0.8);
	const allOut = prog(t, rp - 0.4, 0.6);
	const h = cue(3, 'high');
	const why = cue(3, 'why');
	const ev = [
		{at: cue(3, 'satellites'), k: 'Radar saw water here', s: 'Sentinel-1 · 27 Aug 2025', col: '#4f8cff'},
		{at: cue(3, 'ground'), k: 'The ground is low', s: '65.3% within 5 m of drain level', col: C.amber},
		{at: cue(3, 'news'), k: 'News named this area', s: '4th Tawi Bridge damaged', col: C.red},
	];
	const phoneIn = prog(t, cue(3, 'resident') - 0.3, 0.9);
	const phoneOut = prog(t, sceneStart(4) + 0.3, 0.6);
	const q = 'Kal Bhagwati Nagar mein paani bharega kya?';
	const qAt = cue(3, 'asks') - 0.1;
	const ansAt = h - 0.1;
	const share = sceneStart(4);
	const tap = cue(4, 'tap');
	return (
		<AbsoluteFill>
			<CityMap {...mp} />
			{/* vignette for type */}
			<AbsoluteFill style={{background: 'radial-gradient(ellipse at 50% 50%, rgba(11,13,17,0) 40%, rgba(11,13,17,.75) 100%)'}} />
			{/* TITLE */}
			<Center style={{opacity: 1 - allOut}}>
				<div style={{transform: `translateY(${lerp(0, -300, titleOut)}px) scale(${lerp(1, 0.45, titleOut)})`, display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
					<div style={{display: 'flex', alignItems: 'baseline'}}>
						<Rise t={t} at={drop} text="Tawi Twin" size={230} stagger={0.08} tracking={-0.055} />
						<div style={{width: 46, height: 46, borderRadius: 23, background: C.water, marginLeft: 12, transform: `scale(${prog(t, drop + 0.35, 0.5, easeOut)})`}} />
					</div>
					<Rise t={t} at={cue(2, 'monsoon') - 0.1} text="Monsoon & heat command for Jammu" size={52} weight={500} color="rgba(255,255,255,.8)" tracking={-0.02} italicWords={['Jammu']} style={{marginTop: 18}} />
				</div>
				{/* for residents / for control room */}
				<div style={{position: 'absolute', top: 560, display: 'flex', gap: 60}}>
					{[
						{at: cue(2, 'residents', 1), label: 'For residents', icon: '📱'},
						{at: cue(2, 'control'), label: "For the city's control room", icon: '🖥️'},
					].map((x, i) => {
						const k = prog(t, x.at - 0.1, 0.7, easeOut);
						return (
							<div key={i} style={{opacity: k, transform: `translateY(${(1 - k) * 40}px)`, padding: '30px 44px', borderRadius: 28, background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.16)', backdropFilter: 'blur(8px)', fontFamily: F.sans, color: '#fff', fontSize: 44, fontWeight: 700, letterSpacing: '-0.03em'}}>
								<span style={{marginRight: 18}}>{x.icon}</span>
								{x.label}
							</div>
						);
					})}
				</div>
			</Center>
			{/* REPLAY timecode roll */}
			{t > rp - 0.3 && t < cue(3, 'resident') + 1 && (
				<Center style={{opacity: win(t, rp - 0.2, cue(3, 'resident') + 0.6, 0.3, 0.6)}}>
					<Pill bg={C.red} size={30}>
						◀◀ Replay · 26 Aug 2025
					</Pill>
					<div style={{fontFamily: F.mono, fontSize: 120, color: '#fff', marginTop: 30, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums'}}>
						{(() => {
							const k = prog(t, rp, 1.6, ease);
							const days = Math.round(lerp(408, 0, k));
							const dt = new Date(Date.UTC(2025, 7, 25, 23, 0) + days * 86400000);
							const dd = dt.toISOString().slice(0, 10).split('-').reverse().join('.');
							return `${dd} · 23:00`;
						})()}
					</div>
					<Rise t={t} at={cue(3, 'night')} text="The night before the flood." size={60} weight={500} color="rgba(255,255,255,.85)" italicWords={['flood.']} style={{marginTop: 20}} />
				</Center>
			)}
			{/* resident phone */}
			{phoneIn > 0 && (
				<Phone x={lerp(2200, 1460, phoneIn)} y={560 + phoneOut * 0} scale={1}>
					<div style={{position: 'absolute', inset: 0, background: '#0f1115', fontFamily: F.sans}}>
						<div style={{position: 'absolute', top: 64, left: 28, right: 28, display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
							<div style={{color: '#fff', fontSize: 26, fontWeight: 700}}>
								<span style={{color: C.water}}>◆</span> Tawi Twin
							</div>
							<Pill bg={C.red} size={16}>
								Replay
							</Pill>
						</div>
						{/* question */}
						<div style={{position: 'absolute', top: 140, right: 22, maxWidth: 330, padding: '16px 20px', borderRadius: '24px 24px 6px 24px', background: C.water, color: '#fff', fontSize: 23, lineHeight: 1.3, fontWeight: 500, opacity: t > qAt ? 1 : 0}}>
							{typed(t, qAt, q, 26)}
							{t < qAt + q.length / 26 && <span style={{opacity: Math.floor(t * 4) % 2}}>|</span>}
						</div>
						{/* tools inside phone, compact */}
						<div style={{position: 'absolute', top: 270, left: 18, right: 18, display: 'flex', flexDirection: 'column', gap: 10, transform: 'scale(0.82)', transformOrigin: 'left top', width: 460, opacity: 1 - prog(t, ansAt, 0.4)}}>
							<Tool t={t} at={agent} done={cue(3, 'colony') + 0.3} label="find_place" detail="Bhagwati Nagar" />
							<Tool t={t} at={cue(3, 'pulls') - 0.1} done={cue(3, 'evidence') + 0.4} label="area_evidence" detail="radar · terrain · news" />
							<Tool t={t} at={cue(3, 'checks') - 0.1} done={cue(3, 'forecast') + 0.5} label="forecast" detail="replay 26 Aug" />
						</div>
						{/* answer */}
						{t > ansAt && (
							<div style={{position: 'absolute', top: 280, left: 18, right: 18, padding: 22, borderRadius: 24, background: '#1b1e25', color: '#e9e9e9', fontSize: 21, lineHeight: 1.45, opacity: prog(t, ansAt, 0.4), transform: `translateY(${(1 - prog(t, ansAt, 0.6, easeOut)) * 30}px)`}}>
								<div style={{display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10}}>
									<Pill bg={C.red} size={20}>
										▲ HIGH
									</Pill>
									<span style={{fontWeight: 600}}>waterlogging</span>
								</div>
								<div style={{fontSize: 52, fontWeight: 800, letterSpacing: '-0.04em', color: '#fff', fontVariantNumeric: 'tabular-nums'}}>
									{fmt(count(t, cue(3, '185'), 1.0, 184.7), 1)} <span style={{fontSize: 26, fontWeight: 500, opacity: 0.7}}>mm / 24 h</span>
								</div>
								<div style={{marginTop: 12, opacity: prog(t, why, 0.5)}}>
									<b>Kyun:</b> radar ne yahan paani dekha · zameen neechi hai · news mein naam aaya
								</div>
								<div style={{marginTop: 10, opacity: prog(t, cue(3, 'what'), 0.5)}}>
									<b>Kya karein:</b> samaan unche rakhein, paani aur dawai stock karein
								</div>
								<div style={{marginTop: 10, opacity: prog(t, cue(3, 'hospital'), 0.5)}}>🏥 Suri Nursing Home · 1.1 km</div>
								<div style={{marginTop: 6, opacity: prog(t, cue(3, 'school'), 0.5)}}>🏫 Hari Singh High School · 1.7 km</div>
								{/* WhatsApp share button */}
								<div style={{marginTop: 16, opacity: prog(t, share - 0.3, 0.4), display: 'flex', justifyContent: 'center', padding: '14px 0', borderRadius: 999, background: C.wa, color: '#062b14', fontWeight: 700, transform: `scale(${1 - prog(t, tap, 0.12) * 0.06 + prog(t, tap + 0.12, 0.2) * 0.06})`}}>
									Share on WhatsApp
								</div>
							</div>
						)}
					</div>
				</Phone>
			)}
			{/* cursor for the share tap */}
			{t > share - 0.6 && (
				<>
					<Cursor x={lerp(1700, 1460, prog(t, share - 0.5, 0.8))} y={lerp(1000, 850, prog(t, share - 0.5, 0.8))} press={prog(t, tap, 0.1) - prog(t, tap + 0.15, 0.15)} />
					<Ripple t={t} at={tap} x={1460} y={850} />
				</>
			)}
			{/* subtitle translation, left */}
			{t > qAt && t < h + 0.5 && (
				<Abs style={{left: 150, top: 240, width: 820, opacity: win(t, qAt, h, 0.4, 0.5)}}>
					<Mono size={20}>A resident asks · Hinglish</Mono>
					<Rise t={t} at={cue(3, 'will')} text="“Will Bhagwati Nagar flood tomorrow?”" size={84} weight={400} font={F.serif} tracking={-0.01} style={{fontStyle: 'italic', marginTop: 16}} />
				</Abs>
			)}
			{/* evidence cards + verdict */}
			{t > h - 0.2 && t < share + 0.5 && (
				<Abs style={{left: 150, top: 200, width: 640, opacity: 1 - prog(t, cue(3, 'then') + 0.6, 0.5)}}>
					<div style={{opacity: prog(t, h - 0.1, 0.4)}}>
						<Mono size={20}>Bhagwati Nagar · next 24 h</Mono>
						<div style={{display: 'flex', alignItems: 'baseline', gap: 22, margin: '8px 0 30px'}}>
							<div style={{fontFamily: F.sans, fontWeight: 900, fontSize: 150, letterSpacing: '-0.06em', color: C.red, lineHeight: 1}}>HIGH</div>
							<div style={{fontFamily: F.serif, fontStyle: 'italic', fontSize: 64, color: '#fff'}}>risk</div>
						</div>
					</div>
					{ev.map((e, i) => {
						const k = prog(t, e.at - 0.15, 0.6, easeOut);
						return (
							<div key={i} style={{display: 'flex', gap: 22, alignItems: 'center', padding: '22px 26px', marginBottom: 14, borderRadius: 18, background: 'rgba(20,23,29,.85)', border: '1px solid rgba(255,255,255,.1)', opacity: k, transform: `translateX(${(1 - k) * -50}px)`, boxShadow: lift(k, true)}}>
								<div style={{fontFamily: F.mono, fontSize: 26, color: e.col}}>0{i + 1}</div>
								<div>
									<div style={{fontFamily: F.sans, fontSize: 34, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em'}}>{e.k}</div>
									<div style={{fontFamily: F.mono, fontSize: 18, color: 'rgba(255,255,255,.6)', marginTop: 4, letterSpacing: '0.04em'}}>{e.s}</div>
								</div>
							</div>
						);
					})}
				</Abs>
			)}
			{/* map tags */}
			<WorldTag c={c} p={bp} k={prog(t, cue(3, 'colony'), 0.6) * (1 - prog(t, share, 0.5))} dot={C.amber}>
				📍 Bhagwati Nagar
			</WorldTag>
			<WorldTag c={c} p={FAC.hospital.c} k={prog(t, cue(3, 'hospital') - 0.1, 0.6) * (1 - prog(t, share, 0.5))} dot="#ff5a7a">
				🏥 {FAC.hospital.name} · {FAC.hospital.km}
			</WorldTag>
			<WorldTag c={c} p={FAC.school.c} k={prog(t, cue(3, 'school') - 0.1, 0.6) * (1 - prog(t, share, 0.5))} dot={C.green}>
				🏫 {FAC.school.name} · higher ground
			</WorldTag>
		</AbsoluteFill>
	);
};

// ---------------- 04 share (WhatsApp world) ----------------
const Share: React.FC<{t: number}> = ({t}) => {
	const s = sceneStart(4);
	const talks = cue(4, 'talks');
	const ans = cue(4, 'answers');
	const fwd = prog(t, talks - 0.6, 1.2);
	const chatOut = prog(t, ans - 0.4, 0.6);
	const langs = [
		{at: cue(4, 'hindi'), tag: 'Hindi', q: 'कल भगवती नगर में पानी भरेगा?', font: F.deva},
		{at: cue(4, 'english'), tag: 'Hinglish', q: 'Kal Bhagwati Nagar mein paani bharega?', font: F.sans},
		{at: cue(4, 'hindi', 1), tag: 'English', q: 'Will Bhagwati Nagar flood tomorrow?', font: F.sans},
	];
	const cur = [...langs].reverse().find((l) => t >= l.at - 0.2) ?? langs[0];
	const voice = cue(4, 'voice');
	return (
		<AbsoluteFill>
			{/* chat */}
			<AbsoluteFill style={{opacity: 1 - chatOut, transform: `scale(${lerp(1, 0.9, chatOut)})`}}>
				{Array.from({length: 12}).map((_, i) => {
					const col = i % 4, row = Math.floor(i / 4);
					const k = prog(t, talks - 0.6 + i * 0.07, 0.7, easeOut);
					return (
						<div key={i} style={{position: 'absolute', left: 140 + col * 420, top: 160 + row * 270, width: 380, height: 230, borderRadius: 22, background: '#fff', boxShadow: lift(k * 0.5), opacity: k * (i === 5 ? 0 : 1), transform: `scale(${lerp(0.6, 1, k)})`, padding: 18, fontFamily: F.sans}}>
							<div style={{fontSize: 18, color: '#667', fontWeight: 600}}>{['Bhagwati Nagar Residents', 'Mohalla Committee', 'Family 🏠', 'Talab Tillo RWA', 'Gujjar Nagar Help', '', 'Office', 'Nikki Tawi Seva', 'School Parents', 'Shastri Nagar', 'Tuition Batch', 'Beli Charan'][i]}</div>
							<div style={{marginTop: 12, padding: 12, borderRadius: 12, background: '#d9fdd3', fontSize: 16, color: '#1b2b1e', lineHeight: 1.35}}>
								<i style={{color: '#667'}}>↪ Forwarded</i>
								<br />⚠️ <b>HIGH</b> waterlogging risk · 185 mm / 24 h
							</div>
						</div>
					);
				})}
				<div style={{position: 'absolute', left: 960 - 330, top: lerp(140, 400, fwd), width: 660, borderRadius: 30, overflow: 'hidden', background: '#efeae2', boxShadow: lift(1), transform: `scale(${lerp(1, 0.62, fwd)})`, fontFamily: F.sans}}>
					<div style={{background: '#075e54', color: '#fff', padding: '22px 28px', fontSize: 28, fontWeight: 700}}>
						Bhagwati Nagar Residents <span style={{fontWeight: 400, fontSize: 20, opacity: 0.8}}>· 214 members</span>
					</div>
					<div style={{padding: 28}}>
						<div style={{background: '#d9fdd3', borderRadius: '18px 4px 18px 18px', padding: '20px 24px', marginLeft: 60, fontSize: 25, lineHeight: 1.45, color: '#111', opacity: prog(t, s + 0.2, 0.5), transform: `translateY(${(1 - prog(t, s + 0.2, 0.7, easeOut)) * 40}px)`}}>
							⚠️ <b>Tawi Twin alert · Bhagwati Nagar</b>
							<br />
							Waterlogging risk: <b style={{color: '#c62828'}}>HIGH</b>
							<br />
							185 mm of rain expected in 24 h
							<br />
							Nearest hospital: Suri Nursing Home, 1.1 km
							<br />
							<span style={{color: '#027eb5'}}>d2r8k00l2fxqnu.cloudfront.net/?area=JMU-116</span>
							<div style={{textAlign: 'right', fontSize: 16, color: '#667'}}>23:41 ✓✓</div>
						</div>
					</div>
				</div>
				<Abs style={{left: 150, bottom: 140, opacity: win(t, cue(4, 'whatsapp') - 0.2, ans - 0.3)}}>
					<Rise t={t} at={cue(4, 'where')} text="Where Jammu actually talks." size={64} color={C.ink} italicWords={['talks.']} />
				</Abs>
			</AbsoluteFill>
			{/* languages */}
			{t > ans - 0.3 && (
				<Center style={{opacity: prog(t, ans - 0.3, 0.5)}}>
					<div style={{display: 'flex', gap: 18, marginBottom: 50}}>
						{langs.map((l) => (
							<Pill key={l.tag} bg={cur.tag === l.tag ? C.ink : 'rgba(11,13,17,.08)'} color={cur.tag === l.tag ? '#fff' : 'rgba(11,13,17,.5)'} size={26}>
								{l.tag}
							</Pill>
						))}
						<Pill bg={t > voice - 0.2 ? C.water : 'rgba(11,13,17,.08)'} color={t > voice - 0.2 ? '#fff' : 'rgba(11,13,17,.5)'} size={26}>
							🎙 Voice
						</Pill>
					</div>
					{langs.map((l) => {
						const on = cur.tag === l.tag;
						const k = prog(t, l.at - 0.2, 0.5, easeOut);
						return on ? (
							<div key={l.tag} style={{fontFamily: l.font, fontWeight: 700, fontSize: 104, letterSpacing: l.font === F.deva ? 0 : '-0.045em', color: C.ink, opacity: k, transform: `translateY(${(1 - k) * 50}px)`, textAlign: 'center', maxWidth: 1600, lineHeight: 1.15}}>
								{l.q}
							</div>
						) : null;
					})}
					{/* voice waveform */}
					<svg width={900} height={140} style={{marginTop: 40, opacity: prog(t, voice - 0.3, 0.4)}}>
						{Array.from({length: 60}).map((_, i) => {
							const a = Math.abs(Math.sin(i * 0.7 + t * 9) * Math.sin(i * 0.23 + t * 3.1));
							const hh = 10 + a * 110 * prog(t, voice - 0.3, 0.6);
							return <rect key={i} x={i * 15} y={70 - hh / 2} width={8} height={hh} rx={4} fill={C.water} />;
						})}
					</svg>
				</Center>
			)}
		</AbsoluteFill>
	);
};

// ---------------- 05 every building + 06 control room (dark map) ----------------
const Buildings: React.FC<{t: number; d: Data}> = ({t, d}) => {
	const s5 = sceneStart(5);
	const s6 = sceneStart(6);
	const close = cue(5, 'close');
	const high = cue(5, 'high');
	const radar = cue(5, 'radar');
	const checked = cue(5, 'checked');
	const times = cue(5, 'times');
	const c = cam(t, {...CITY, z: 0.05, rot: 10, tilt: 0}, [
		{at: s5, dur: 3.5, to: {z: 0.068, rot: 0, tilt: 30}},
		{at: close - 0.3, dur: 1.4, to: {x: -800, y: -1200, z: 0.16, tilt: 38, rot: -12}},
		{at: radar - 0.3, dur: 1.6, to: {x: 0, y: -800, z: 0.1, tilt: 20, rot: 0}},
		{at: checked - 0.2, dur: 1.6, to: {x: 700, y: -1500, z: 0.17, tilt: 0}},
		{at: s6 - 0.2, dur: 1.6, to: {x: 2400, y: -200, z: 0.075, tilt: 0}},
		{at: cue(6, 'preposition') - 0.4, dur: 1.5, to: {x: 1100, y: -100, z: 0.11}},
	]);
	const tally = count(t, cue(5, '188') - 0.2, 2.2, 188180);
	const sweep = prog(t, radar, 1.8, (x) => x);
	const control = prog(t, s6 - 0.2, 1.0);
	const mp: MapProps = {
		...baseMap(d, c),
		bAlpha: 1,
		reveal: lerp(0, 9000, prog(t, s5 + 0.6, 3.0, easeOut)),
		riverAlpha: 1,
		riverDraw: 1,
		riverRise: 0.1 + 0.6 * win(t, close, high + 0.4),
		rings: win(t, close, radar - 0.2, 0.6, 0.5),
		floodAlpha: win(t, radar, s6, 0.4, 0.6),
		floodSweep: sweep,
		hexAlpha: control * 0.9,
		hexMode: 'replay',
		hexReveal: control,
		focusHigh: prog(t, cue(6, '12') - 0.2, 0.8),
		drains: prog(t, cue(6, 'trains') - 0.3, 1.8, ease),
	};
	const L = d.layers;
	const panel = control;
	const top6 = [...L.areas].sort((a, b) => a.rank - b.rank).slice(0, 6);
	return (
		<AbsoluteFill>
			<CityMap {...mp} />
			<AbsoluteFill style={{background: 'linear-gradient(90deg, rgba(11,13,17,.85) 0%, rgba(11,13,17,0) 45%)', opacity: 1 - control}} />
			{/* radar sweep line */}
			{t > radar - 0.1 && t < radar + 2.0 && (
				<svg width={W} height={H} style={{position: 'absolute', inset: 0}}>
					{(() => {
						const [cx, cy] = project(c, 0, 0);
						const a = sweep * Math.PI * 2 - Math.PI;
						return (
							<g opacity={win(t, radar - 0.1, radar + 1.9, 0.2, 0.3)}>
								<line x1={cx} y1={cy} x2={cx + Math.cos(a) * 2400} y2={cy + Math.sin(a) * 2400} stroke="#a9c4ff" strokeWidth={3} />
								<circle cx={cx} cy={cy} r={8} fill="#a9c4ff" />
							</g>
						);
					})()}
				</svg>
			)}
			{/* tally */}
			<Abs style={{left: 150, top: 150, opacity: 1 - prog(t, s6 - 0.4, 0.5)}}>
				<Mono size={20}>Every building, scored</Mono>
				<div style={{fontFamily: F.sans, fontWeight: 900, fontSize: 170, letterSpacing: '-0.06em', color: '#fff', lineHeight: 1, fontVariantNumeric: 'tabular-nums', opacity: prog(t, cue(5, '188') - 0.2, 0.3)}}>{fmt(tally)}</div>
				<Mono size={18} style={{marginTop: 10, opacity: prog(t, cue(5, 'scored'), 0.4)}}>
					Overture Maps buildings · AWS Open Data
				</Mono>
				<div style={{marginTop: 50, display: 'flex', flexDirection: 'column', gap: 16}}>
					{[
						{at: close, n: '01', k: 'Distance to the Tawi', col: C.waterSoft},
						{at: high, n: '02', k: 'Height above the nearest drain', col: C.amber},
						{at: radar, n: '03', k: 'Radar saw water · 27 Aug 2025', col: '#4f8cff'},
					].map((x) => {
						const k = prog(t, x.at - 0.15, 0.6, easeOut);
						const active = t > x.at - 0.15 && (x.n === '03' || t < [close, high, radar, 1e9][Number(x.n)] - 0.15);
						return (
							<div key={x.n} style={{display: 'flex', alignItems: 'center', gap: 20, opacity: k * (active ? 1 : 0.45), transform: `translateX(${(1 - k) * -40}px)`, fontFamily: F.sans, fontSize: 40, fontWeight: 700, color: '#fff', letterSpacing: '-0.025em'}}>
								<span style={{fontFamily: F.mono, fontSize: 22, color: x.col}}>{x.n}</span>
								{x.k}
							</div>
						);
					})}
				</div>
			</Abs>
			{/* HAND diagram */}
			{t > high - 0.3 && t < radar + 0.6 && (
				<Abs style={{right: 140, bottom: 150, opacity: win(t, high - 0.2, radar + 0.4, 0.4, 0.4)}}>
					<svg width={620} height={330} viewBox="0 0 620 330">
						<rect width={620} height={330} rx={24} fill="rgba(20,23,29,.9)" stroke="rgba(255,255,255,.12)" />
						<path d="M30 250 L180 250 L215 290 L265 290 L300 250 L590 210" fill="none" stroke="rgba(255,255,255,.5)" strokeWidth={3} />
						<rect x={218} y={270} width={44} height={20} fill={C.water} opacity={0.9} />
						<rect x={400} y={140} width={90} height={84} fill={C.orange} />
						<line x1={520} y1={272} x2={520} y2={226} stroke={C.amber} strokeWidth={3} />
						<line x1={505} y1={272} x2={535} y2={272} stroke={C.amber} strokeWidth={3} strokeDasharray="5 5" />
						<line x1={262} y1={272} x2={505} y2={272} stroke={C.amber} strokeWidth={2} strokeDasharray="6 6" opacity={0.6} />
						<text x={540} y={256} fill={C.amber} fontFamily={F.mono} fontSize={20}>
							2.2 m
						</text>
						<text x={240} y={318} fill="rgba(255,255,255,.6)" fontFamily={F.mono} fontSize={16} textAnchor="middle">
							DRAIN
						</text>
						<text x={30} y={50} fill="#fff" fontFamily={F.sans} fontSize={26} fontWeight={700}>
							Height above nearest drain
						</text>
						<text x={30} y={82} fill="rgba(255,255,255,.55)" fontFamily={F.mono} fontSize={16}>
							COPERNICUS DEM 30 M · HAND
						</text>
					</svg>
				</Abs>
			)}
			{/* reported places */}
			{L.reported.map((r, i) => (
				<WorldTag key={r.name} c={c} p={r.c} k={win(t, cue(5, 'reports') + i * 0.18, s6 - 0.3, 0.5, 0.4)} dot={C.red} dx={14} dy={-14}>
					<span style={{fontSize: 18}}>📰 {r.name}</span>
				</WorldTag>
			))}
			{/* 1.5x */}
			{t > cue(5, 'buildings', 1) - 0.4 && t < s6 + 0.4 && (
				<Abs style={{right: 140, top: 180, width: 640, padding: 40, borderRadius: 28, background: 'rgba(14,16,21,.92)', border: '1px solid rgba(255,255,255,.12)', opacity: win(t, cue(5, 'buildings', 1) - 0.4, s6 + 0.2, 0.5, 0.5), boxShadow: lift(1, true)}}>
					<Mono size={18}>Buildings rated high or very high</Mono>
					{[
						{l: 'City average', v: 24.6, at: cue(5, 'buildings', 1), col: '#6b7280'},
						{l: 'Within 500 m of reported places', v: 36.4, at: cue(5, 'are'), col: C.red},
					].map((b) => {
						const k = prog(t, b.at, 0.9, easeOut);
						return (
							<div key={b.l} style={{marginTop: 26}}>
								<div style={{display: 'flex', justifyContent: 'space-between', fontFamily: F.sans, fontSize: 26, color: '#fff', fontWeight: 600}}>
									<span>{b.l}</span>
									<span style={{fontVariantNumeric: 'tabular-nums'}}>{fmt(b.v * k, 1)}%</span>
								</div>
								<div style={{height: 22, marginTop: 10, borderRadius: 11, background: 'rgba(255,255,255,.08)'}}>
									<div style={{height: 22, borderRadius: 11, width: `${(b.v / 40) * 100 * k}%`, background: b.col}} />
								</div>
							</div>
						);
					})}
					<div style={{display: 'flex', alignItems: 'baseline', gap: 16, marginTop: 30, opacity: prog(t, times - 0.4, 0.5), transform: `scale(${lerp(1.2, 1, prog(t, times - 0.4, 0.5, easeOut))})`, transformOrigin: 'left center'}}>
						<div style={{fontFamily: F.sans, fontWeight: 900, fontSize: 130, color: '#fff', letterSpacing: '-0.06em', lineHeight: 1}}>1.5×</div>
						<div style={{fontFamily: F.serif, fontStyle: 'italic', fontSize: 44, color: 'rgba(255,255,255,.85)'}}>more likely</div>
					</div>
					<Mono size={14} style={{marginTop: 14}} color="rgba(255,255,255,.4)">
						8 places, Aug 2025 news · a sanity check, not an accuracy score
					</Mono>
				</Abs>
			)}
			{/* CONTROL ROOM panel */}
			{panel > 0 && (
				<Abs style={{right: 70, top: 110, bottom: 110, width: 640, borderRadius: 30, background: 'rgba(16,18,23,.94)', border: '1px solid rgba(255,255,255,.12)', boxShadow: lift(panel, true), transform: `translateX(${(1 - panel) * 760}px)`, padding: 40, fontFamily: F.sans, color: '#fff', overflow: 'hidden'}}>
					<div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
						<Mono size={17}>Control room · JMC / ICCC</Mono>
						<Pill bg={C.red} size={15}>
							Replay 26 Aug 2025
						</Pill>
					</div>
					<Rise t={t} at={cue(6, 'becomes')} text="The data becomes a plan." size={46} style={{marginTop: 18}} italicWords={['plan.']} />
					<div style={{display: 'flex', gap: 40, marginTop: 30}}>
						<div style={{opacity: prog(t, cue(6, '39') - 0.2, 0.4)}}>
							<div style={{fontSize: 110, fontWeight: 900, letterSpacing: '-0.06em', color: C.red, lineHeight: 1, fontVariantNumeric: 'tabular-nums'}}>{fmt(count(t, cue(6, '39') - 0.2, 1.0, 39))}</div>
							<Mono size={15}>areas at high alert</Mono>
						</div>
						<div style={{opacity: prog(t, cue(6, '12') - 0.2, 0.4)}}>
							<div style={{fontSize: 110, fontWeight: 900, letterSpacing: '-0.06em', lineHeight: 1, fontVariantNumeric: 'tabular-nums'}}>{fmt(count(t, cue(6, '12') - 0.2, 1.2, 12113))}</div>
							<Mono size={15}>buildings inside them</Mono>
						</div>
					</div>
					{[
						{at: cue(6, 'preposition') - 0.2, h: 'Pre-position dewatering pumps', rows: top6.slice(0, 3).map((a, i) => `${i + 1}. ${a.name.split(',')[0]} · ${fmt(a.bldg)} bldgs`)},
						{at: cue(6, 'trains') - 0.2, h: 'Drains to clear first', rows: ['1. Sanjay Nagar-Sector 2 · 10 stretches', '2. Preet Nagar-Nanak Nagar-Sector 6', '3. Green Belt Park-IInd Extension']},
						{at: cue(6, 'schools') - 0.3, h: 'Low-lying schools to check', rows: ['Govt Gandhi Memorial Science College · 0.6 m', 'Dogra Higher Secondary School · 2.2 m']},
					].map((sec) => {
						const k = prog(t, sec.at, 0.6, easeOut);
						return (
							<div key={sec.h} style={{marginTop: 28, opacity: k, transform: `translateY(${(1 - k) * 30}px)`}}>
								<div style={{fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 10}}>{sec.h}</div>
								{sec.rows.map((r, i) => (
									<div key={r} style={{fontSize: 20, color: 'rgba(255,255,255,.75)', padding: '6px 0', borderTop: '1px solid rgba(255,255,255,.08)', opacity: prog(t, sec.at + 0.15 + i * 0.12, 0.4)}}>
										{r}
									</div>
								))}
							</div>
						);
					})}
				</Abs>
			)}
			{/* pumps on map */}
			{top6.slice(0, 3).map((a, i) => (
				<WorldTag key={a.id} c={c} p={a.c} k={win(t, cue(6, 'preposition') + i * 0.2, sceneStart(7) - 0.3, 0.5, 0.3)} dot={C.water} dx={14} dy={-14}>
					<span style={{fontSize: 18}}>⛽ Pump {i + 1}</span>
				</WorldTag>
			))}
			{[FAC.college, FAC.dogra].map((f, i) => (
				<WorldTag key={f.name} c={c} p={f.c} k={win(t, cue(6, 'schools') + i * 0.2, sceneStart(7) - 0.3, 0.5, 0.3)} dot={C.green} dx={14} dy={-14}>
					<span style={{fontSize: 18}}>🏫 check</span>
				</WorldTag>
			))}
		</AbsoluteFill>
	);
};

// ---------------- 07 report (paper) ----------------
const StreetPhoto: React.FC<{t: number}> = ({t}) => (
	<svg viewBox="0 0 400 300" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
		<defs>
			<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" stopColor="#8d97a3" />
				<stop offset="1" stopColor="#b9c0c7" />
			</linearGradient>
			<linearGradient id="wat" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" stopColor="#6d7a73" />
				<stop offset="1" stopColor="#47534d" />
			</linearGradient>
		</defs>
		<rect width="400" height="300" fill="url(#sky)" />
		<rect x="0" y="70" width="120" height="140" fill="#c8b9a2" />
		<rect x="120" y="100" width="90" height="110" fill="#d8cfbf" />
		<rect x="280" y="60" width="120" height="150" fill="#b8a48b" />
		{[0, 1, 2].map((i) => (
			<rect key={i} x={20 + i * 34} y="100" width="20" height="26" fill="#5a5f66" />
		))}
		<rect x="300" y="90" width="26" height="30" fill="#5a5f66" />
		<rect x="345" y="90" width="26" height="30" fill="#5a5f66" />
		<path d="M0 200 L400 190 L400 300 L0 300Z" fill="url(#wat)" />
		{Array.from({length: 9}).map((_, i) => (
			<ellipse key={i} cx={40 + i * 42} cy={230 + (i % 3) * 18} rx={14 + ((t * 20 + i * 7) % 12)} ry={3} fill="none" stroke="rgba(255,255,255,.25)" />
		))}
		<rect x="210" y="170" width="54" height="30" rx="8" fill="#a23b2c" />
		<circle cx="220" cy="203" r="10" fill="#222" />
		<path d="M0 205 L400 196" stroke="rgba(255,255,255,.35)" strokeWidth="1.5" />
	</svg>
);

const Report: React.FC<{t: number}> = ({t}) => {
	const s = sceneStart(7);
	const shot = cue(7, 'photo');
	const vis = cue(7, 'vision');
	const sev = cue(7, 'severity');
	const lands = cue(7, 'lands');
	const assign = cue(7, 'assign');
	const fly = prog(t, lands - 0.2, 0.9);
	const flash = win(t, shot - 0.05, shot + 0.15, 0.05, 0.2);
	const scan = clamp((t - vis) / 1.4);
	const press = prog(t, assign - 0.25, 0.1) - prog(t, assign - 0.1, 0.15);
	const assigned = t > assign - 0.15;
	const out = prog(t, sceneStart(8) - 0.5, 0.6);
	return (
		<AbsoluteFill style={{opacity: 1 - out, transform: `translateY(${-out * 80}px)`}}>
			<Abs style={{left: 150, top: 160, width: 640}}>
				<Mono color="rgba(11,13,17,.5)" size={20}>
					Citizen report
				</Mono>
				<Rise t={t} at={cue(7, 'report') - 0.1} text="Report it with a photo." size={92} color={C.ink} italicWords={['photo.']} />
				<div style={{marginTop: 40, opacity: prog(t, vis - 0.2, 0.5)}}>
					<Pill bg={C.ink} size={24}>
						Amazon Bedrock · vision model
					</Pill>
				</div>
				<div style={{marginTop: 30, fontFamily: F.sans, color: C.ink, opacity: prog(t, sev - 0.3, 0.5)}}>
					<Mono color="rgba(11,13,17,.5)" size={18}>
						Severity
					</Mono>
					<div style={{display: 'flex', gap: 10, marginTop: 12}}>
						{[1, 2, 3, 4, 5].map((i) => (
							<div key={i} style={{width: 90, height: 18, borderRadius: 9, background: i <= 4 && t > sev - 0.3 + i * 0.12 ? (i >= 4 ? C.red : C.orange) : 'rgba(11,13,17,.1)'}} />
						))}
					</div>
					<div style={{fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', marginTop: 14}}>4 / 5 · road under water</div>
				</div>
			</Abs>
			{/* phone with camera */}
			<Phone x={1150} y={560} light style={{opacity: 1 - fly, transform: `translateY(${fly * 120}px) scale(${1 - fly * 0.15})`}}>
				<div style={{position: 'absolute', inset: 0, background: '#000'}}>
					<div style={{position: 'absolute', left: 0, right: 0, top: 90, height: 540, transform: `scale(${lerp(1, 0.55, prog(t, shot + 0.1, 0.7))})`, transformOrigin: '50% 30%', borderRadius: prog(t, shot + 0.1, 0.7) * 30, overflow: 'hidden'}}>
						<StreetPhoto t={t} />
						{/* AI scan */}
						{t > vis && t < lands && (
							<>
								<div style={{position: 'absolute', left: 0, right: 0, top: `${scan * 100}%`, height: 3, background: C.water, boxShadow: `0 0 0 1px ${C.water}`}} />
								<div style={{position: 'absolute', left: '4%', top: '64%', width: '92%', height: '34%', border: `3px solid ${C.red}`, borderRadius: 10, opacity: prog(t, vis + 0.7, 0.3)}}>
									<div style={{position: 'absolute', top: -34, left: 0, background: C.red, color: '#fff', fontFamily: F.mono, fontSize: 16, padding: '4px 10px', borderRadius: 6}}>standing water · 0.94</div>
								</div>
							</>
						)}
					</div>
					{/* shutter */}
					<div style={{position: 'absolute', left: 170, bottom: 60, width: 80, height: 80, borderRadius: 40, border: '5px solid #fff', opacity: 1 - prog(t, shot + 0.2, 0.4)}}>
						<div style={{position: 'absolute', inset: 6, borderRadius: 30, background: '#fff', transform: `scale(${1 - win(t, shot - 0.1, shot + 0.1, 0.05, 0.1) * 0.2})`}} />
					</div>
					<div style={{position: 'absolute', inset: 0, background: '#fff', opacity: flash}} />
				</div>
			</Phone>
			{/* inbox */}
			<Abs style={{right: 110, top: 220, width: 560, borderRadius: 26, background: '#fff', boxShadow: lift(prog(t, lands - 0.6, 0.6)), padding: 30, opacity: prog(t, lands - 0.6, 0.5), transform: `translateX(${(1 - prog(t, lands - 0.6, 0.7, easeOut)) * 120}px)`, fontFamily: F.sans, color: C.ink}}>
				<Mono color="rgba(11,13,17,.5)" size={16}>
					Control room · inbox
				</Mono>
				{[
					{who: 'New · Talab Tillo', what: 'Road under water · severity 4', live: true},
					{who: '12 min · Gandhi Nagar', what: 'Drain overflowing · severity 3'},
					{who: '25 min · Trikuta Nagar', what: 'Puddles · severity 1'},
				].map((r, i) => {
					const k = i === 0 ? prog(t, lands + 0.2, 0.5, easeOut) : 1;
					return (
						<div key={i} style={{display: 'flex', alignItems: 'center', gap: 16, padding: '18px 0', borderBottom: '1px solid rgba(0,0,0,.07)', transform: i === 0 ? `translateY(${(1 - k) * -40}px)` : `translateY(${(1 - prog(t, lands + 0.2, 0.5)) * -80}px)`, opacity: i === 0 ? k : 1}}>
							<div style={{width: 64, height: 48, borderRadius: 10, overflow: 'hidden', background: '#ccc', flexShrink: 0}}>{i === 0 && <StreetPhoto t={t} />}</div>
							<div style={{flex: 1}}>
								<div style={{fontSize: 16, color: '#778'}}>{r.who}</div>
								<div style={{fontSize: 22, fontWeight: 700}}>{r.what}</div>
							</div>
							{r.live && (
								<div style={{padding: '10px 18px', borderRadius: 999, fontSize: 18, fontWeight: 700, background: assigned ? C.green : C.ink, color: assigned ? '#06140c' : '#fff', transform: `scale(${1 - press * 0.08})`}}>{assigned ? 'Assigned ✓' : 'Assign'}</div>
							)}
						</div>
					);
				})}
			</Abs>
			{t > assign - 1.2 && (
				<>
					<Cursor x={lerp(1500, 1700, prog(t, assign - 1.2, 0.8))} y={lerp(700, 330, prog(t, assign - 1.2, 0.8))} press={press} />
					<Ripple t={t} at={assign - 0.2} x={1700} y={330} color={C.ink} />
				</>
			)}
		</AbsoluteFill>
	);
};

// ---------------- 08 AWS (paper diagram) ----------------
const Aws: React.FC<{t: number}> = ({t}) => {
	const s = sceneStart(8);
	const collapse = prog(t, cue(8, 'one') - 0.2, 0.9);
	const nodes: {id: string; label: string; sub: string; x: number; y: number; at: number}[] = [
		{id: 'user', label: 'Residents + control room', sub: 'phone · browser', x: 230, y: 560, at: s + 1.6},
		{id: 'cf', label: 'CloudFront', sub: 'site + map tiles', x: 560, y: 380, at: cue(8, 'cloudfront')},
		{id: 'api', label: 'API Gateway', sub: 'HTTP API', x: 560, y: 740, at: cue(8, 'api')},
		{id: 'lambda', label: 'Lambda', sub: 'Graviton · arm64', x: 900, y: 740, at: cue(8, 'lambda')},
		{id: 'strands', label: 'Strands Agents', sub: 'tool-using agent', x: 900, y: 420, at: cue(8, 'strands')},
		{id: 'bedrock', label: 'Amazon Bedrock', sub: 'reasoning + vision', x: 1250, y: 300, at: cue(8, 'bedrock')},
		{id: 'loc', label: 'Location Service', sub: 'colony search', x: 1250, y: 540, at: cue(8, 'location')},
		{id: 'ddb', label: 'DynamoDB', sub: 'areas · forecasts · reports', x: 1250, y: 800, at: cue(8, 'dynamodb')},
		{id: 'eb', label: 'EventBridge', sub: 'rate(1 hour)', x: 1600, y: 800, at: cue(8, 'eventbridge')},
		{id: 'od', label: 'AWS Open Data', sub: '188,180 buildings', x: 1600, y: 380, at: cue(8, 'buildings')},
		{id: 's3', label: 'S3', sub: 'layers + tiles', x: 1600, y: 590, at: cue(8, 's3')},
	];
	const edges = [
		['user', 'cf'], ['user', 'api'], ['api', 'lambda'], ['lambda', 'strands'], ['strands', 'bedrock'], ['strands', 'loc'], ['lambda', 'ddb'], ['eb', 'ddb'], ['od', 's3'], ['s3', 'cf'],
	];
	const N = Object.fromEntries(nodes.map((n) => [n.id, n]));
	const headK = prog(t, s + 1.2, 0.8);
	const fx = 960, fy = 560;
	const pos = (n: (typeof nodes)[0]) => [lerp(n.x, fx, collapse), lerp(n.y, fy, collapse)];
	const tpl = prog(t, cue(8, 'sam') - 0.3, 0.6, easeOut);
	const out = prog(t, sceneStart(9) - 0.5, 0.5);
	return (
		<AbsoluteFill style={{opacity: 1 - out}}>
			{/* big statement then heading */}
			<Abs style={{left: lerp(960 - 640, 150, headK), top: lerp(380, 120, headK), transform: `scale(${lerp(1, 0.4, headK)})`, transformOrigin: 'left top', opacity: 1 - collapse}}>
				<Rise t={t} at={s} text="Runs on AWS." size={230} color={C.ink} accent={{'AWS.': '#ff9900'}} />
			</Abs>
			<svg width={W} height={H} style={{position: 'absolute', inset: 0, opacity: 1 - collapse}}>
				{edges.map(([a, b]) => {
					const A = N[a], B = N[b];
					const k = prog(t, Math.max(A.at, B.at) + 0.1, 0.7);
					if (k <= 0) return null;
					const [ax, ay] = pos(A), [bx, by] = pos(B);
					const travel = ((t * 0.6 + a.length * 0.13) % 1);
					return (
						<g key={a + b}>
							<line x1={ax} y1={ay} x2={lerp(ax, bx, k)} y2={lerp(ay, by, k)} stroke={C.ink} strokeOpacity={0.35} strokeWidth={2} />
							{k >= 1 && <circle cx={lerp(ax, bx, travel)} cy={lerp(ay, by, travel)} r={5} fill={C.water} />}
						</g>
					);
				})}
				{/* hourly loop around EventBridge */}
				{t > N.eb.at && (
					<circle cx={N.eb.x} cy={N.eb.y} r={118} fill="none" stroke={C.water} strokeWidth={3} pathLength={1} strokeDasharray="0.25 0.75" strokeDashoffset={-((t - N.eb.at) * 0.5)} opacity={prog(t, cue(8, 'every') - 0.2, 0.4)} />
				)}
			</svg>
			{nodes.map((n) => {
				const k = prog(t, n.at - 0.15, 0.6, easeOut);
				if (k <= 0) return null;
				const [x, y] = pos(n);
				return (
					<div key={n.id} style={{position: 'absolute', left: x - 150, top: y - 52, width: 300, height: 104, borderRadius: 22, background: n.id === 'user' ? C.ink : '#fff', color: n.id === 'user' ? '#fff' : C.ink, boxShadow: lift(k * 0.7), opacity: k * (1 - collapse * 0.6), transform: `scale(${lerp(0.7, 1, k) * (1 - collapse * 0.6)})`, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 26px', fontFamily: F.sans}}>
						<div style={{fontSize: 27, fontWeight: 700, letterSpacing: '-0.02em'}}>{n.label}</div>
						<div style={{fontFamily: F.mono, fontSize: 15, opacity: 0.55, marginTop: 4, letterSpacing: '0.04em'}}>{n.sub}</div>
					</div>
				);
			})}
			{/* Location Service callout */}
			<Abs style={{left: 1410, top: 470, opacity: win(t, cue(8, 'colonies') - 0.2, cue(8, 'lambda'), 0.4, 0.4)}}>
				<div style={{padding: '14px 20px', borderRadius: 16, background: C.ink, color: '#fff', fontFamily: F.sans, fontSize: 20, lineHeight: 1.5, boxShadow: lift(1)}}>
					<span style={{color: C.amber}}>✓</span> Bhagwati Nagar
					<br />
					<span style={{color: C.amber}}>✓</span> Gujjar Nagar
					<div style={{fontFamily: F.mono, fontSize: 14, opacity: 0.6}}>NOT IN OPENSTREETMAP</div>
				</div>
			</Abs>
			{/* SAM template */}
			{tpl > 0 && (
				<Center>
					<div style={{width: 520, padding: 40, borderRadius: 28, background: C.ink, color: '#fff', boxShadow: lift(tpl), transform: `scale(${lerp(0.4, 1, tpl)})`, opacity: tpl, fontFamily: F.mono, fontSize: 22, lineHeight: 1.6}}>
						<div style={{color: '#ff9900', marginBottom: 10}}>template.yaml</div>
						<div style={{opacity: 0.6}}>Transform: AWS::Serverless</div>
						<div style={{opacity: 0.6}}>Resources:</div>
						<div style={{opacity: 0.6}}>&nbsp; Api · Agent · Forecast · Reports</div>
						<div style={{opacity: 0.6}}>&nbsp; Table · Bucket · Distribution</div>
						<div style={{marginTop: 18, color: C.green}}>$ sam deploy ✓</div>
					</div>
					<Rise t={t} at={cue(8, 'sam')} text="One AWS SAM template." size={70} color={C.ink} style={{marginTop: 40}} />
				</Center>
			)}
		</AbsoluteFill>
	);
};

// ---------------- 09 today + end ----------------
const Today: React.FC<{t: number; d: Data}> = ({t, d}) => {
	const s = sceneStart(9);
	const dry = cue(9, 'dry');
	const when = cue(9, 'when');
	const every = cue(9, 'every');
	const before = cue(9, 'before');
	const end = cue(9, 'tavi', 1);
	const c = cam(t, {...CITY, z: 0.09, rot: -6, tilt: 30}, [
		{at: s, dur: 4, to: {z: 0.068, rot: 0, tilt: 10}},
		{at: when, dur: 4, to: {z: 0.085, rot: 6, tilt: 34}},
	]);
	const live = 1 - prog(t, every - 0.1, 0.6) + prog(t, end - 0.3, 0.6);
	const mp: MapProps = {
		...baseMap(d, c),
		bAlpha: 1 - prog(t, end - 0.4, 0.8) * 0.75,
		reveal: lerp(-1, 9000, prog(t, every - 0.1, 1.6, easeOut)),
		calm: live > 0.5 ? 1 : 0,
		riverAlpha: 1,
		riverDraw: 1,
		riverRise: 0.05,
		hexAlpha: 0.6 * win(t, s, every, 0.6, 0.4),
		hexMode: 'live',
		hexReveal: 1,
	};
	const endK = prog(t, end - 0.2, 0.8, easeOut);
	return (
		<AbsoluteFill>
			<CityMap {...mp} />
			<AbsoluteFill style={{background: `rgba(11,13,17,${0.35 + 0.5 * endK})`}} />
			<Center style={{opacity: win(t, s, when - 0.1, 0.4, 0.4)}}>
				<Pill bg="rgba(31,209,122,.15)" color={C.green} size={28} style={{border: `1px solid ${C.green}`}}>
					● Live · {`08 Oct 2026`}
				</Pill>
				<Rise t={t} at={dry - 0.3} text="It's dry today." size={150} style={{marginTop: 30}} italicWords={['dry']} />
				<div style={{marginTop: 26, opacity: prog(t, cue(9, 'says'), 0.5)}}>
					<Mono size={24} color="rgba(255,255,255,.75)">
						✓ All 284 areas low · 2.5 mm forecast · 48 h
					</Mono>
				</div>
			</Center>
			<Abs style={{left: 150, top: 330, opacity: win(t, when - 0.1, end - 0.3, 0.4, 0.5)}}>
				<Rise t={t} at={when} text="When the next monsoon comes," size={80} weight={600} color="rgba(255,255,255,.85)" />
				<Rise t={t} at={every} text="every street in Jammu" size={128} />
				<Rise t={t} at={cue(9, 'will')} text="will know before the water does." size={128} italicWords={['before']} accent={{before: C.waterSoft}} />
			</Abs>
			{/* end card */}
			{endK > 0 && (
				<Center>
					<div style={{display: 'flex', alignItems: 'baseline', transform: `scale(${lerp(0.92, 1, endK)})`, opacity: endK}}>
						<div style={{fontFamily: F.sans, fontWeight: 800, fontSize: 210, letterSpacing: '-0.055em', color: '#fff'}}>Tawi Twin</div>
						<div style={{width: 44, height: 44, borderRadius: 22, background: C.water, marginLeft: 12}} />
					</div>
					<div style={{fontFamily: F.serif, fontStyle: 'italic', fontSize: 56, color: 'rgba(255,255,255,.85)', opacity: prog(t, end + 0.5, 0.6), marginTop: -6}}>Know before the water does.</div>
					<div style={{display: 'flex', gap: 16, marginTop: 50, opacity: prog(t, end + 1.0, 0.6)}}>
						<Pill bg="#fff" color={C.ink} size={26}>
							d2r8k00l2fxqnu.cloudfront.net
						</Pill>
						<Pill bg="rgba(255,255,255,.1)" size={26}>
							Built on AWS
						</Pill>
					</div>
					<Mono size={16} style={{marginTop: 40, opacity: prog(t, end + 1.4, 0.6)}} color="rgba(255,255,255,.45)">
						Dupahar · Built on AWS · Not an official warning · Emergency 112
					</Mono>
				</Center>
			)}
		</AbsoluteFill>
	);
};

// ---------------- the film ----------------
export const Film: React.FC = () => {
	const frame = useCurrentFrame();
	const t = frame / FPS;
	const [d, setD] = useState<Data | null>(getData());
	const [h] = useState(() => (getData() ? null : delayRender('film-data')));
	useEffect(() => {
		if (d) return;
		useDataOnce().then((x) => {
			setD(x);
			if (h !== null) continueRender(h);
		});
	}, [d, h]);
	if (!d) return <AbsoluteFill style={{background: C.ink}} />;

	const layers: Layer[] = [
		{from: -1, bg: C.ink, dark: true, o: [960, 540], render: (tt) => <Night t={tt} />},
		{from: cue(1, 'new'), bg: C.red, dark: false, o: [960, 540], dur: 0.35, render: (tt) => <Record t={tt} />},
		{from: cue(1, 'tavi') - 0.45, bg: C.ink, dark: true, o: [960, 900], render: (tt, dd) => <River t={tt} d={dd} />},
		{from: sceneStart(2) - 0.5, bg: C.paper, dark: false, o: [960, 540], render: (tt) => <Gap t={tt} />},
		{from: cue(2, 'tavi') - 0.08, bg: C.ink, dark: true, o: [960, 540], dur: 0.7, render: (tt, dd) => <TitleAndReplay t={tt} d={dd} />},
		{from: cue(4, 'tap') + 0.05, bg: '#efeae2', dark: false, o: [1460, 850], render: (tt) => <Share t={tt} />},
		{from: sceneStart(5) - 0.45, bg: C.ink, dark: true, o: [960, 700], render: (tt, dd) => <Buildings t={tt} d={dd} />},
		{from: sceneStart(7) - 0.5, bg: C.paper, dark: false, o: [1700, 300], render: (tt) => <Report t={tt} />},
		{from: sceneStart(8) - 0.3, bg: C.paper2, dark: false, o: [960, 540], render: (tt) => <Aws t={tt} />},
		{from: sceneStart(9) - 0.45, bg: C.ink, dark: true, o: [960, 560], render: (tt, dd) => <Today t={tt} d={dd} />},
	];
	// which layers are visible: current + the one being covered
	let cur = 0;
	layers.forEach((L, i) => {
		if (t >= L.from) cur = i;
	});
	const covering = prog(t, layers[cur].from, layers[cur].dur ?? 0.8) < 1;
	const visible = covering && cur > 0 ? [cur - 1, cur] : [cur];
	const chapters = [
		{t: sceneStart(1), label: '01 — The night'},
		{t: sceneStart(2), label: '02 — The gap'},
		{t: cue(2, 'tavi'), label: '03 — Tawi Twin'},
		{t: sceneStart(3), label: '04 — Replay'},
		{t: sceneStart(4), label: '05 — Share'},
		{t: sceneStart(5), label: '06 — Every building'},
		{t: sceneStart(6), label: '07 — Control room'},
		{t: sceneStart(7), label: '08 — Report'},
		{t: sceneStart(8), label: '09 — Built on AWS'},
		{t: sceneStart(9), label: '10 — Today'},
	];
	const ch = [...chapters].reverse().find((c) => t >= c.t - 0.3)?.label ?? '00 — Cold open';
	return (
		<AbsoluteFill style={{background: C.ink}}>
			{visible.map((i) => (
				<Reveal key={i} t={t} L={layers[i]}>
					{layers[i].render(t, d)}
				</Reveal>
			))}
			<HUD t={t} end={END} dark={layers[cur].dark ? 1 : 0} chapter={ch} chapters={chapters} opacity={prog(t, 0.2, 0.8) * (1 - prog(t, END - 2.2, 0.8))} />
		</AbsoluteFill>
	);
};

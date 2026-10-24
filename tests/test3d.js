/* node tests/test3d.js : the 3D engine against REDblocks' 3D Flapjack model (claude/flapjack-drive-redblocks.md). */
"use strict";
const P = require("../src/physics.js"), B = require("../src/robots.js");
let fails = 0, n = 0;
function check(ok, what, got) { n++; if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${what}${got !== undefined ? "  (" + got + ")" : ""}`); }
const near = (a, b, rel) => Math.abs(a - b) <= rel * Math.abs(b);
const clone = o => JSON.parse(JSON.stringify(o));
function flapjack(weapon) {                    // as the REDblocks 3D model had it: 18.5 V, 50 mohm, no weapon
  const S = clone(B.PRESETS.flapjack); S.battery = { cells: 5, mAh: 650, R_mohm: 50 }; S.drive.drive_V = 0;
  if (!weapon) S.weapon = { type: "none" };
  return S;
}
function sim(S, opts) {
  const s = new P.Sim(B.build(S), Object.assign({ arena: 0 }, opts || {})); s.reset({ x: 0, y: 0, psi: 0 });
  for (let i = 0; i < 4000; i++) s.step({ L: 0, R: 0, W: 0 });        // settle on the contacts
  s.t0 = s.t; return s;
}
const run = (s, T, cmd, each) => { while (s.t - s.t0 < T) { s.step(cmd(s.t - s.t0)); if (each) each(s); } };

{ // launch
  const s = sim(flapjack()), x0 = s.p[0]; let t8 = null, t1 = null, apk = 0, vmin = 99, shareSum = 0, shareN = 0, shareEarly = 0, v0 = 0;
  run(s, 2.05, () => ({ L: 1, R: 1, W: 0 }), q => {
    const d = q.p[0] - x0; if (!t1 && d >= 1) t1 = q.t - q.t0; if (!t8 && d >= 2.4384) t8 = q.t - q.t0;
    const a = (q.v[0] - v0) / q.opts.h; v0 = q.v[0]; apk = Math.max(apk, a);
    vmin = Math.min(vmin, q.dg.vbus); const w = q.dg.wheels, tt = q.t - q.t0;
    if (tt > 0.005 && tt < 0.05) { shareSum += (w[0].N + w[1].N) / (1.361 * 9.81); shareN++; } shareEarly = shareSum / Math.max(shareN, 1);
  });
  check(near(t8, 0.805, 0.01), "launch: 8 ft in 0.805 s (REDblocks 3D)", t8.toFixed(3));
  check(near(t1, 0.467, 0.02), "launch: 1 m in 0.467 s", t1.toFixed(3));
  check(near(shareEarly, 0.74, 0.08), "launch: the gearbox reaction lifts the nose: 74 % on the wheels as they spin up (5 to 50 ms)", (100 * shareEarly).toFixed(0) + " %");
  check(near(s.v[0], 4.275, 0.002), "launch: top speed 4.275 m/s", s.v[0].toFixed(3));
  check(near(vmin, 16.50, 0.005), "launch: bus sags to 16.50 V", vmin.toFixed(2));
}
{ // point turn
  const s = sim(flapjack()); let psi = 0, last = 0, t90 = null, t180 = null, t360 = null, rpk = 0;
  run(s, 1.0, () => ({ L: -1, R: 1, W: 0 }), q => {
    const st = q.state; let d = st.psi - last; if (d < -Math.PI) d += 2 * Math.PI; if (d > Math.PI) d -= 2 * Math.PI; psi += d; last = st.psi;
    const t = q.t - q.t0; if (!t90 && psi >= Math.PI / 2) t90 = t; if (!t180 && psi >= Math.PI) t180 = t; if (!t360 && psi >= 2 * Math.PI) t360 = t;
    rpk = Math.max(rpk, st.r * 180 / Math.PI);
  });
  check(near(t90, 0.175, 0.03) && near(t180, 0.253, 0.03) && near(t360, 0.379, 0.03), "point turn: 90 / 180 / 360 deg in 0.175 / 0.253 / 0.379 s", [t90, t180, t360].map(v => v.toFixed(3)).join(" / "));
  check(near(rpk, 1692, 0.03), "point turn: peak 1692 deg/s", rpk.toFixed(0));
}
{ // drag-brake stop from top speed
  const s = sim(flapjack()); run(s, 2.0, () => ({ L: 1, R: 1, W: 0 }));
  const x0 = s.p[0], t0 = s.t; let tstop = null;
  while (s.t - t0 < 2.0) { s.step({ L: 0, R: 0, W: 0 }); if (!tstop && s.v[0] < 0.02) tstop = s.t - t0; }
  check(near(tstop, 0.83, 0.08) && near(s.p[0] - x0, 1.80, 0.08), "drag-brake stop: 0.83 s, 1.80 m", `${tstop.toFixed(2)} s, ${(s.p[0] - x0).toFixed(2)} m`);
}
{ // weapon spin-up reaction: 0.955 N m s over 1 s with the brake holding (REDblocks: 21 deg)
  const S = flapjack(true); S.weapon.esc_A = 31.3; S.weapon.rpm_cap = 0;
  const s = sim(S); run(s, 1.0, t => ({ L: 0, R: 0, W: 1 }));
  const yaw = s.state.psi * 180 / Math.PI;
  check(yaw < 0 && Math.abs(yaw) > 12 && Math.abs(yaw) < 32, "spin-up yaw against the blade, brake on: about -21 deg", yaw.toFixed(1) + " deg");
}
{ // vertical spinner: turning at speed tips it (gyro); spin-up dips the nose
  const s = sim(clone(B.PRESETS.vertical)); run(s, 2.5, () => ({ L: 0, R: 0, W: 1 }));
  const rpm = s.ww * 30 / Math.PI, pitch0 = s.state.pitch;
  let maxRoll = 0, maxPitch = 0; const t1 = s.t;
  while (s.t - t1 < 0.6) { s.step({ L: -0.6, R: 0.6, W: 1 }); const st = s.state; maxRoll = Math.max(maxRoll, Math.abs(st.roll)); maxPitch = Math.max(maxPitch, Math.abs(st.pitch - pitch0)); }
  check(rpm > 5000, "vertical spinner spins up", rpm.toFixed(0) + " rpm");
  check(maxRoll * 57.3 > 5 || maxPitch * 57.3 > 5, "turning with it spinning tilts the robot (gyro)", `roll ${(maxRoll * 57.3).toFixed(1)} deg, pitch ${(maxPitch * 57.3).toFixed(1)} deg`);
}
{ // a vertical spinner throws the target up
  const S = clone(B.PRESETS.vertical), R = B.build(S);
  const s = new P.Sim(R, { arena: 0, target: { x: 0.3, y: 0, psi: 0, m: 1.36, a: 0.12, b: 0.12, c: 0.06, mu: 0.3 } });
  s.reset({ x: 0, y: 0, psi: 0 }); s.ww = 1500;
  let zmax = 0; for (let i = 0; i < 40000; i++) { s.step({ L: 0.4, R: 0.4, W: 1 }); zmax = Math.max(zmax, s.tg.p[2]); }
  check(s.hits.length > 0 && zmax > 0.1, "a vertical hit launches the target", `${s.hits.length} hits, ${s.hits.length ? s.hits[0].dE.toFixed(0) : 0} J first, target up to ${(zmax * 1000).toFixed(0)} mm`);
}
{ // energy: what the robot holds never exceeds what the battery gave (flooring it while spinning up)
  const s = sim(clone(B.PRESETS.flapjack)); const E0 = s.kinetic() + 1.361 * 9.81 * s.p[2]; let Ein = 0, worst = -1e9;
  run(s, 1.0, () => ({ L: 1, R: 0.7, W: 1 }), q => { Ein += q.dg.vbus * q.dg.Ib * q.opts.h; worst = Math.max(worst, q.kinetic() + 1.361 * 9.81 * q.p[2] - E0 - Ein); });
  check(worst < 0.01, "energy: never more than the battery delivered", `margin ${(-worst).toFixed(2)} J`);
}
{ // every preset: spin up standing (3 s), then drive an arc with the weapon on: it stays on its wheels
  for (const k of Object.keys(B.PRESETS)) {
    const s = sim(clone(B.PRESETS[k])); run(s, 3.0, () => ({ L: 0, R: 0, W: 1 }));
    let tilt = 0; const t1 = s.t;
    while (s.t - t1 < 1.5) { s.step({ L: 0.7, R: 0.45, W: 1 }); const st = s.state; tilt = Math.max(tilt, Math.abs(st.roll), Math.abs(st.pitch)); }
    const st = s.state;
    check(isFinite(st.x) && !st.upsideDown && tilt * 57.3 < 45, `preset ${k}: spun up, then an arc`, `speed ${st.speed.toFixed(2)} m/s, weapon ${(st.ww * 30 / Math.PI).toFixed(0)} rpm, most tilt ${(tilt * 57.3).toFixed(1)} deg`);
  }
}
// driven into a wall, every upright bot backs away again (wheels near a wall once grounded on hard rim points)
for (const k of ["flapjack", "vertical", "drum", "pusher4wd", "eggbeater"]) {
  const H = 2.4384 / 2, R = B.build(clone(B.PRESETS[k])), s = new P.Sim(R, { arena: 2.4384, ceiling: 1.22 });
  s.reset({ x: H - 0.4, y: 0, psi: 0 });
  for (let i = 0; i < 15000; i++) s.step({ L: 1, R: 1, W: 0 });
  const x0 = s.state.x, Nw = s.state.wheels.reduce((a, w) => a + w.N, 0);
  for (let i = 0; i < 5000; i++) s.step({ L: -1, R: -1, W: 0 });
  check(x0 - s.state.x > 0.15, `${k}: pinned on a wall, then backs off it`, `wheels carry ${Nw.toFixed(1)} N on the wall, backed ${((x0 - s.state.x) * 1000).toFixed(0)} mm in 0.5 s`);
}
// an undercutter's hit throws the target, not itself: the robot stays near the floor through the hit
for (const k of ["flapjack", "undercutter"]) for (const ang of [0, 20, -30]) {
  const R = B.build(clone(B.PRESETS[k])), s = new P.Sim(R, { arena: 0, target: { x: 0.6, y: 0, psi: ang * Math.PI / 180, m: 1.36, a: 0.2, b: 0.2, c: 0.08, mu: 0.5 } });
  s.reset({ x: 0, y: 0, psi: 0 }); for (let i = 0; i < 25000; i++) s.step({ L: 0, R: 0, W: 1 });
  const E0 = 0.5 * R.weapon.I * s.ww * s.ww; let t0 = null, z = 0, Ek = 0;
  for (let i = 0; i < 20000 && (t0 === null || s.t - t0 < 0.03); i++) {
    s.step({ L: 0.6, R: 0.6, W: 1 });
    if (s.hits.length && t0 === null) { t0 = s.t; Ek = 0.5 * R.weapon.I * s.ww * s.ww; }
    if (t0 !== null) z = Math.max(z, s.state.zcog);
  }
  const lift = (z - R.cog.h) * 1000;
  check(t0 !== null && lift < 25 && Ek > 0.45 * E0, `${k} hits a box at ${ang} deg: stays down, blade keeps speed`, `lifts ${lift.toFixed(0)} mm in 30 ms, first tooth leaves the blade ${(100 * Ek / E0).toFixed(0)} % of its energy`);
}
console.log(`\n${n - fails} of ${n} passed`);
process.exit(fails ? 1 : 0);

/* node tests/run_tests.js : the physics against the model it came from, and its own checks. No packages needed. */
"use strict";
const P = require("../src/physics.js"), B = require("../src/robots.js");
let fails = 0, n = 0;
function check(ok, what, got) { n++; if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${what}${got !== undefined ? "  (" + got + ")" : ""}`); }
const near = (a, b, rel) => Math.abs(a - b) <= rel * Math.abs(b);
const clone = o => JSON.parse(JSON.stringify(o));

// Flapjack as the REDblocks legacy model had it: 18.5 V pack (5S), no weapon, no walls
function flapjackLegacy() {
  const S = clone(B.PRESETS.flapjack);
  S.battery = { cells: 5, mAh: 650, R_mohm: 50 }; S.drive.drive_V = 0; S.weapon = { type: "none" };
  return B.build(S);
}
function drive(R, cmd, T, opts) {
  const sim = new P.Sim(R, Object.assign({ arena: 0 }, opts || {}));
  sim.reset({ x: 0, y: 0, psi: 0 });
  const steps = Math.round(T / sim.opts.h), out = [];
  let dist = 0, px = sim.state.xcog, py = sim.state.ycog, apk = 0, vmin = 1e9;
  for (let i = 0; i < steps; i++) {
    const [L, Rr, Wp] = cmd(sim.t);
    sim.step({ L, R: Rr, W: Wp || 0 });
    const st = sim.state; dist += Math.hypot(st.xcog - px, st.ycog - py); px = st.xcog; py = st.ycog;
    out.push([sim.t, dist, st.psi, st.r, st.speed, st.ww]); apk = Math.max(apk, st.ax / 9.81); vmin = Math.min(vmin, st.vbus);
  }
  return { out, apk, vmin, sim };
}
const tAt = (out, col, v) => { for (let i = 1; i < out.length; i++) if (out[i][col] >= v) { const a = out[i - 1], b = out[i]; return a[0] + (v - a[col]) * (b[0] - a[0]) / (b[col] - a[col]); } return NaN; };

// 1. the legacy model's own numbers (flapjack_drive_legacy.py, RK4 at 0.1 ms): launch and point turn
{
  const L = drive(flapjackLegacy(), () => [1, 1], 2.0), T = drive(flapjackLegacy(), () => [-1, 1], 1.0);
  const v = L.out[L.out.length - 1][4];
  check(near(tAt(L.out, 1, 2.4384), 0.8390, 0.003), "launch: time to 8 ft 0.839 s", tAt(L.out, 1, 2.4384).toFixed(4));
  check(near(v, 4.2745, 0.001), "launch: top speed 4.274 m/s", v.toFixed(4));
  check(near(L.apk, 1.098, 0.01), "launch: peak accel 1.10 g", L.apk.toFixed(3));
  check(near(L.vmin, 16.51, 0.003), "launch: bus sag to 16.5 V at 20 A", L.vmin.toFixed(3));
  check(near(tAt(T.out, 2, Math.PI / 2), 0.1737, 0.003), "point turn: 90 deg in 0.174 s", tAt(T.out, 2, Math.PI / 2).toFixed(4));
  check(near(tAt(T.out, 2, 2 * Math.PI), 0.3786, 0.003), "point turn: 360 deg in 0.379 s", tAt(T.out, 2, 2 * Math.PI).toFixed(4));
  check(near(T.out[T.out.length - 1][3] * 180 / Math.PI, 1689.3, 0.003), "point turn: 1689 deg/s", (T.out[T.out.length - 1][3] * 180 / Math.PI).toFixed(1));
  // energy ledger: what the motors took = kinetic energy + every loss
  const e = L.sim.energies(), ke = L.sim.kinetic(), res = (e.term - (ke + e.cu + e.gear + e.tire + e.skid + e.rr + e.wall + e.wdrag)) / e.term;
  check(Math.abs(res) < 1e-6, "launch: energy ledger closes", res.toExponential(2));
}
// 2. loads: three contacts are statics; four on a rectangle share by symmetry; a lifted one drops out
{
  const N = new Float64Array(3), on = new Int32Array(3);
  P.shareLoads(Float64Array.from([-0.065, -0.065, 0.035]), Float64Array.from([0.09, -0.09, 0]), 13.35, 0, 0, N, on);
  check(near(N[0] + N[1], 0.35 * 13.35, 1e-6) && near(N[0], N[1], 1e-9), "three contacts: 35 % on the wheels", (N[0] + N[1]).toFixed(4));
  const N4 = new Float64Array(4), on4 = new Int32Array(4);
  P.shareLoads(Float64Array.from([0.05, 0.05, -0.05, -0.05]), Float64Array.from([0.05, -0.05, 0.05, -0.05]), 10, 0.1, 0, N4, on4);
  check(near(N4[0], N4[1], 1e-9) && N4[0] > N4[2] && near(N4[0] + N4[1] + N4[2] + N4[3], 10, 1e-9), "four contacts: a pitch moment loads the front pair", Array.from(N4).map(v => v.toFixed(3)).join(" "));
  const tip = P.shareLoads(Float64Array.from([0.05, 0.05, -0.05, -0.05]), Float64Array.from([0.05, -0.05, 0.05, -0.05]), 10, 0, 0.6, N4, on4);
  check(N4[1] === 0 && N4[3] === 0 && tip === 1, "a roll moment past the track lifts the right side (tipping)", Array.from(N4).map(v => v.toFixed(3)).join(" "));
}
// 3. weapon spin-up: Flapjack's blade on two 2807s reaches its cap; the yaw kick is the blade's momentum
{
  const R = B.build(clone(B.PRESETS.flapjack));
  const S = drive(R, t => [0, 0, 1], 3.0);
  const rpm = S.out[S.out.length - 1][5] * 30 / Math.PI;
  check(rpm > 11000 && rpm <= 12001, "Flapjack's weapon settles near its 12,000 rpm cap", rpm.toFixed(0));
  const t95 = tAt(S.out, 5, 0.95 * rpm * Math.PI / 30);
  check(t95 > 0.3 && t95 < 3, "and gets to 95 % in a plausible time", t95.toFixed(2) + " s");
  // the REDblocks case: blade torque about 0.955 N m for 1 s, drive brake holding: the chassis creeps about 21 deg
  const S2 = clone(B.PRESETS.flapjack); S2.weapon.esc_A = 31.3; S2.weapon.rpm_cap = 0;
  const Y = drive(B.build(S2), t => [0, 0, t < 1 ? 1 : 0], 1.0);
  const yaw = Y.out[Y.out.length - 1][2] * 180 / Math.PI;
  check(yaw < 0 && Math.abs(yaw) > 12 && Math.abs(yaw) < 30, "spin-up yaw, brake holding: about -21 deg in REDblocks (against the blade)", yaw.toFixed(1) + " deg");
}
// 4. gyro: a vertical spinner at speed turning left rolls toward one side
{
  const S0 = clone(B.PRESETS.vertical), R = B.build(S0);
  const sim = new P.Sim(R, { arena: 0 }); sim.reset({ x: 0, y: 0, psi: 0 });
  sim.s[sim.c.iW] = 800; sim.s[5] = 6;                    // weapon spinning, robot turning left at 6 rad/s
  sim.step({ L: 0, R: 0, W: 0 });
  const H = R.weapon.I * 800, Mx = sim.state.Mx;
  check(near(Mx, -6 * H, 1e-9), "vertical weapon gyro: roll moment = -r H (dir +1)", Mx.toFixed(3) + " N m");
  const N = sim.state.N; check(N[1] < N[0], "  turning left with the front of the disc going up lifts the right wheel", "L " + N[0].toFixed(2) + ", R " + N[1].toFixed(2));
}
// 5. walls: a robot driven into a wall stops there and bounces back a little
{
  const R = flapjackLegacy();
  const sim = new P.Sim(R, { arena: 2.4384 }); sim.reset();
  let maxY = -1e9;
  for (let i = 0; i < 30000; i++) { sim.step({ L: sim.t < 1.0 ? 1 : 0, R: sim.t < 1.0 ? 1 : 0, W: 0 }); maxY = Math.max(maxY, sim.state.ycog); }
  check(maxY < 1.2192 && sim.state.ycog < 1.2192, "wall: the robot stays inside the 8 ft cage", maxY.toFixed(3));
}
// 6. a hit on the target: momentum goes in, the blade slows
{
  const S0 = clone(B.PRESETS.flapjack), R = B.build(S0);
  const sim = new P.Sim(R, { arena: 0, target: { x: 0.33, y: 0, psi: 0, m: 1.36, a: 0.12, b: 0.12, mu: 0.3 } });
  sim.reset({ x: 0, y: 0, psi: 0 });
  sim.s[sim.c.iW] = 1200;
  for (let i = 0; i < 20000 && !sim.hits.length; i++) sim.step({ L: 0.5, R: 0.5, W: 1 });
  const hit = sim.hits[0];
  check(!!hit && hit.J > 0.5 && hit.dE > 5, "the blade bites the target", hit ? `J ${hit.J.toFixed(2)} N s, ${hit.dE.toFixed(0)} J from the blade` : "no hit");
}
// 7. every preset builds and runs
for (const k of Object.keys(B.PRESETS)) {
  const R = B.build(clone(B.PRESETS[k])), S = drive(R, t => [1, 0.6, 1], 1.0);
  const st = S.sim.state, ok = isFinite(st.x) && isFinite(st.ww) && st.speed < 20;
  check(ok, `preset ${k} runs`, `speed ${st.speed.toFixed(2)} m/s, weapon ${(st.ww * 30 / Math.PI).toFixed(0)} rpm, MOI ${(R.Izz * 1e9).toExponential(2)} g mm^2`);
}
// 8. driving curves and the mix
{
  const I = require("../src/input.js");
  const ch = { rate: 60, expo: 30, deadband: 3 };
  check(I.curve(0.02, ch) === 0 && near(I.curve(1, ch), 0.6, 1e-12) && near(I.curve(-1, ch), -0.6, 1e-12), "curve: deadband, then rate at full stick");
  check(I.curve(0.5, { rate: 100, expo: 50, deadband: 0 }) < 0.5, "curve: expo softens the middle", I.curve(0.5, { rate: 100, expo: 50, deadband: 0 }).toFixed(3));
  const C = JSON.parse(JSON.stringify(I.DEFAULT_CONTROLS));
  const [L, R] = I.mixer(C, 0, 0.5, 0, 0);
  check(L === -0.5 && R === 0.5, "arcade: steering left turns the left side back, the right side forward");
  C.steer_at_speed = 50; const [L2, R2] = I.mixer(C, 1, 0.5, 0, 0);
  check(near(L2, 0.75, 1e-12) && R2 === 1, "steering at full throttle cut to 50 % (left side 0.75)", L2.toFixed(3));
}
console.log(`\n${n - fails} of ${n} passed`);
process.exit(fails ? 1 : 0);

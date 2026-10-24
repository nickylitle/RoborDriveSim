// Every catalog motor builds and drives, and the brushed motors give back their published free speed.
const B = require("../src/robots.js"), { Sim } = require("../src/physics.js"), CAT = require("../src/motors.js");
let pass = 0, fail = 0;
const ok = (c, msg) => { c ? pass++ : (fail++, console.log("FAIL " + msg)); };
const base = () => JSON.parse(JSON.stringify(B.PRESETS.undercutter));
for (const [k, m] of Object.entries(CAT.drive)) {
  const S = base(); S.drive.motor = k; S.weapon = { type: "none" };
  const R = B.build(S), sim = new Sim(R, {}); sim.reset({ x: 0, y: 0, psi: 0 });
  for (let i = 0; i < 5000; i++) sim.step({ L: 1, R: 1, W: 0 });   // 0.5 s full throttle
  const st = sim.state;
  ok(isFinite(st.x) && st.x > 0.05 && !st.upsideDown, `${k}: drove ${st.x.toFixed(3)} m`);
  ok(R.drive.G > 1 && R.drive.R > 0 && R.drive.kv > 0, `${k}: constants`);
  if (m.free_rpm_12V) ok(Math.abs(m.kv * 12 / m.G - m.free_rpm_12V) / m.free_rpm_12V < 0.02, `${k}: free speed`);
}
for (const [k] of Object.entries(CAT.weapon)) {
  const S = base(); S.weapon.motor = k;
  const R = B.build(S), sim = new Sim(R, {}); sim.reset({ x: 0, y: 0, psi: 0 });
  for (let i = 0; i < 10000; i++) sim.step({ L: 0, R: 0, W: 1 });  // 1 s spin-up
  ok(isFinite(sim.state.ww) && Math.abs(sim.state.ww) > 100, `${k}: weapon ${sim.state.ww.toFixed(0)} rad/s`);
}
console.log(`${pass} of ${pass + fail} passed`); process.exit(fail ? 1 : 0);

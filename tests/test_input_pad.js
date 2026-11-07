/* node tests/test_input_pad.js : an analog keyboard in gamepad mode, faked: learning each control and reading its depth. */
"use strict";
const I = require("../src/input.js");
let fails = 0, n = 0;
const check = (ok, what, got) => { n++; if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${what}${got !== undefined ? "  (" + got + ")" : ""}`); };
const axes = [0, 0, 0, 0], btn = Array.from({ length: 17 }, () => ({ value: 0, pressed: false }));
Object.defineProperty(globalThis, "navigator", { value: { getGamepads: () => [{ connected: true, id: "fake analog keyboard", axes, buttons: btn }] }, configurable: true });
const inp = new I.Input(null);
inp.C.thr.deadband = 0; inp.C.steer.deadband = 0; inp.C.steer.expo = 0; inp.C.steer.rate = 100;
function learn(ch, set, clear) { inp.learn(ch); for (let f = 0; f <= 10; f++) { set(f / 10); inp.learnStep(); } clear(); return inp.learnStep(); }
const f = learn("fwd", x => axes[1] = -x, () => axes[1] = 0);
check(f && f.a === 1 && f.rest === 0 && f.full === -1, "W on the left stick (XInput: up is -1)", JSON.stringify(f));
learn("back", x => axes[1] = x, () => axes[1] = 0);
learn("left", x => axes[0] = -x, () => axes[0] = 0);
learn("right", x => axes[0] = x, () => axes[0] = 0);
const w = learn("weapon", x => btn[7].value = x, () => btn[7].value = 0);
check(w && w.b === 7, "Shift on the right trigger (an analog button)", JSON.stringify(w));
axes[1] = -0.5; let r = inp.read(1 / 60);
check(Math.abs(r.L - 0.5) < 1e-9 && Math.abs(r.R - 0.5) < 1e-9, "W half way down: half throttle", `${r.L}, ${r.R}`);
axes[1] = 0; axes[0] = -0.25; r = inp.read(1 / 60);
check(Math.abs(r.L + 0.25) < 1e-9 && Math.abs(r.R - 0.25) < 1e-9, "A a quarter down: a quarter turn left", `${r.L}, ${r.R}`);
axes[0] = 0; btn[7].value = 0.3; r = inp.read(1 / 60);
check(Math.abs(r.W - 0.3) < 1e-9, "weapon key 30 % down: 30 % weapon throttle", r.W);
btn[7].value = 0; axes[3] = -1;
inp.learn("weapon"); for (let k = 0; k <= 10; k++) { axes[3] = -1 + 2 * k / 10; inp.learnStep(); } axes[3] = -1;
const di = inp.learnStep();
check(di && di.a === 3 && di.rest === -1 && di.full === 1, "a DirectInput axis that rests at -1", JSON.stringify(di));
axes[3] = 0; r = inp.read(1 / 60); check(Math.abs(r.W - 0.5) < 1e-9, "read from its rest: half way is 50 %", r.W);
axes[3] = -1; inp.down.add("KeyW"); r = inp.read(1 / 60);
check(r.L === 0, "the board's ordinary W press is ignored while mapped", r.L);
inp.padKeysOff = false; inp.down.add("KeyW"); for (let k = 0; k < 30; k++) r = inp.read(1 / 60);
check(r.L > 0.99, "unless asked not to", r.L);
// only W / S learned: A and D still steer from the keyboard (they were thrown away with the mapped keys)
const inp2 = new I.Input(null); inp2.C.steer.deadband = 0; inp2.C.steer.expo = 0; inp2.C.steer.rate = 100;
inp2.padmap = { fwd: { a: 1, rest: 0, full: -1 }, back: { a: 1, rest: 0, full: 1 } };
axes[0] = 0; axes[1] = 0; axes[3] = -1;
inp2.down.add("KeyA"); for (let k = 0; k < 30; k++) r = inp2.read(1 / 60);
check(r.L < -0.99 && r.R > 0.99, "only W / S mapped: A still steers from the keyboard", `${r.L}, ${r.R}`);
inp2.down.add("KeyW"); r = inp2.read(1 / 60);
check(!inp2.down.has("KeyW"), "while W (mapped) is still ignored", [...inp2.down].join(","));
// letting go of the weapon after a hit: in hold mode it stays off until the button is let go and pressed again
axes[1] = 0; axes[3] = 0;
const inp3 = new I.Input(null); inp3.C.weapon_mode = "hold";
inp3.down.add("Space"); const wHeld = inp3.read(1 / 60).W;
inp3.cutWeapon(); const wCut = inp3.read(1 / 60).W;
inp3.down.delete("Space"); inp3.read(1 / 60); inp3.down.add("Space"); const wAgain = inp3.read(1 / 60).W;
check(wHeld > 0.99 && wCut === 0 && wAgain > 0.99, "a hit lets go of a held weapon until it is pressed again", `${wHeld}, ${wCut}, ${wAgain}`);
const inp4 = new I.Input(null); inp4.weaponOn = true; inp4.read(1 / 60); inp4.cutWeapon();
check(inp4.read(1 / 60).W === 0 && !inp4.weaponOn, "a hit turns a toggled weapon off");
// mouse stick deadzone: a small offset reads zero, full stick still reads full
const inp5 = new I.Input(null); inp5.C.thr.deadband = 0; inp5.C.thr.expo = 0; inp5.C.steer.deadband = 0; inp5.mouseLocked = () => true;
inp5.mx = 0; inp5.my = 0.04; const rSmall = inp5.read(1 / 60); inp5.my = 1; const rFull = inp5.read(1 / 60);
check(rSmall.L === 0 && rSmall.R === 0 && rFull.L > 0.99, "mouse stick: 4 % sits in the 5 % deadzone, full is still full", `${rSmall.L}, ${rFull.L}`);
console.log(`\n${n - fails} of ${n} passed`); process.exit(fails ? 1 : 0);

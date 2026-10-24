/* RoborDriveSim input: keyboard and game controller, through the driving curves a transmitter has (rate, expo,
 * deadband, reverse) and its mix (arcade, single stick, tank). Out: {L, R, W}: each drive side -1..1, weapon 0..1.
 *
 * Keyboard (on/off keys) ramps toward full over `ramp` seconds so a tap is a small move; Shift is precision mode.
 * Game controller (standard mapping, any XInput / PlayStation / Switch pad in Chrome or Edge):
 *   arcade: left stick up/down = throttle, right stick left/right = steering
 *   single: left stick does both
 *   tank:   left stick up/down = left side, right stick up/down = right side
 *   right trigger = weapon throttle (analog); A / Cross toggles the weapon on; B / Circle resets; Start pauses
 */
(function (root) {
  "use strict";
  const DEFAULT_CONTROLS = {
    mix: "arcade",                    // arcade, single, tank
    thr: { rate: 100, expo: 0, deadband: 3, reverse: false },
    steer: { rate: 60, expo: 30, deadband: 3, reverse: false },
    steer_at_speed: 100,              // % of the steering rate left at full throttle (some radios cut it)
    invert_reverse: false,            // steering flips when backing up (like a car)
    ramp: 0.12,                       // s for a key to reach full
    precision: 40,                    // % with Shift held
    weapon_mode: "toggle",            // toggle or hold (Space / A button)
    weapon_level: 100,                // % weapon throttle when on
    keys: { up: ["KeyW", "ArrowUp"], down: ["KeyS", "ArrowDown"], left: ["KeyA", "ArrowLeft"], right: ["KeyD", "ArrowRight"],
            tankLup: ["KeyW"], tankLdown: ["KeyS"], tankRup: ["ArrowUp", "KeyI"], tankRdown: ["ArrowDown", "KeyK"],
            weapon: ["Space"] },
  };

  // a channel's curve: deadband, then expo, then rate; x in -1..1
  function curve(x, ch) {
    const db = (ch.deadband || 0) / 100;
    let a = Math.abs(x); if (a <= db) return 0;
    a = (a - db) / (1 - db);
    const e = (ch.expo || 0) / 100;
    a = (1 - e) * a + e * a * a * a;
    const y = Math.sign(x) * a * (ch.rate === undefined ? 1 : ch.rate / 100);
    return ch.reverse ? -y : y;
  }
  function mixer(C, thr, steer, tankL, tankR) {
    let L, R;
    if (C.mix === "tank") { L = tankL; R = tankR; }
    else {
      const cut = 1 - (1 - (C.steer_at_speed === undefined ? 100 : C.steer_at_speed) / 100) * Math.abs(thr);
      steer *= cut;
      if (C.invert_reverse && thr < -0.05) steer = -steer;
      L = thr - steer; R = thr + steer;                  // + steering turns left (counter-clockwise from above)
    }
    const cl = v => Math.max(-1, Math.min(1, v));
    return [cl(L), cl(R)];
  }

  class Input {
    constructor(target) {
      this.C = JSON.parse(JSON.stringify(DEFAULT_CONTROLS));
      this.down = new Set(); this.ramp = { thr: 0, steer: 0, L: 0, R: 0 };
      this.weaponOn = false; this.events = [];
      this.pad = null; this.padPrev = {};
      if (target) {
        target.addEventListener("keydown", e => {
          if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
          if (this.C.keys.weapon.includes(e.code) && !e.repeat) {
            if (this.C.weapon_mode === "toggle") this.weaponOn = !this.weaponOn;
            e.preventDefault();
          }
          if (/^(Arrow|Space)/.test(e.code)) e.preventDefault();
          this.down.add(e.code);
          if (!e.repeat) this.events.push(e.code);
        });
        target.addEventListener("keyup", e => { this.down.delete(e.code); });
        target.addEventListener("blur", () => this.down.clear());
      }
    }
    any(list) { return list.some(k => this.down.has(k)); }
    // the commands for this frame; dt = real seconds since the last
    read(dt) {
      const C = this.C, K = C.keys, prec = this.down.has("ShiftLeft") || this.down.has("ShiftRight") ? C.precision / 100 : 1;
      const rampTo = (key, tgt) => { const r = this.ramp, k = dt / Math.max(C.ramp, 1e-3); r[key] += Math.max(-k, Math.min(k, tgt - r[key])); return r[key]; };
      // keyboard
      let thr = rampTo("thr", (this.any(K.up) ? 1 : 0) - (this.any(K.down) ? 1 : 0));
      let steer = rampTo("steer", (this.any(K.left) ? 1 : 0) - (this.any(K.right) ? 1 : 0));
      let tL = rampTo("L", (this.any(K.tankLup) ? 1 : 0) - (this.any(K.tankLdown) ? 1 : 0));
      let tR = rampTo("R", (this.any(K.tankRup) ? 1 : 0) - (this.any(K.tankRdown) ? 1 : 0));
      let weapon = (C.weapon_mode === "toggle" ? this.weaponOn : this.any(K.weapon)) ? C.weapon_level / 100 : 0;
      // game controller (takes over a channel when its stick is moved)
      const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = Array.from(pads || []).find(p => p && p.connected);
      this.pad = gp ? gp.id : null;
      if (gp) {
        const ax = i => gp.axes[i] || 0, bt = i => gp.buttons[i] ? gp.buttons[i].value || (gp.buttons[i].pressed ? 1 : 0) : 0;
        const big = v => Math.abs(v) > 0.06;
        if (C.mix === "tank") { if (big(ax(1))) tL = -ax(1); if (big(ax(3))) tR = -ax(3); }
        else if (C.mix === "single") { if (big(ax(1))) thr = -ax(1); if (big(ax(0))) steer = -ax(0); }
        else { if (big(ax(1))) thr = -ax(1); if (big(ax(2))) steer = -ax(2); }
        const rt = bt(7); if (rt > 0.05) weapon = rt * C.weapon_level / 100;
        const edge = i => { const p = bt(i) > 0.5, was = this.padPrev[i]; this.padPrev[i] = p; return p && !was; };
        if (edge(0)) this.weaponOn = !this.weaponOn;
        if (edge(1)) this.events.push("PadReset");
        if (edge(9)) this.events.push("PadPause");
        if (C.weapon_mode === "toggle" && this.weaponOn && rt <= 0.05) weapon = C.weapon_level / 100;
      }
      const [L, R] = mixer(C, curve(thr, C.thr) * prec, curve(steer, C.steer) * prec, curve(tL, C.thr) * prec, curve(tR, C.thr) * prec);
      return { L, R, W: weapon, raw: { thr, steer, tL, tR } };
    }
    takeEvents() { const e = this.events; this.events = []; return e; }
  }

  const api = { Input, curve, mixer, DEFAULT_CONTROLS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.RDS = root.RDS || {}; root.RDS.input = api; }
})(typeof window !== "undefined" ? window : globalThis);

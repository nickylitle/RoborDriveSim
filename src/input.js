/* RoborDriveSim input: keyboard and game controller, through the driving curves a transmitter has (rate, expo,
 * deadband, reverse) and its mix (arcade, single stick, tank). Out: {L, R, W}: each drive side -1..1, weapon 0..1.
 *
 * Keyboard (on/off keys) ramps toward full over `ramp` seconds so a tap is a small move; Q is precision mode.
 * Shift / Ctrl held raise / lower the weapon throttle (it stays where you leave it); Space switches the weapon on / off.
 * Game controller (standard mapping, any XInput / PlayStation / Switch pad in Chrome or Edge):
 *   arcade: left stick up/down = throttle, right stick left/right = steering
 *   single: left stick does both
 *   tank:   left stick up/down = left side, right stick up/down = right side
 *   right trigger = weapon throttle (analog); A / Cross toggles the weapon on; B / Circle resets; Start pauses
 * Mouse as a joystick: M (or the Mouse button) captures the mouse on the 3D view (Esc lets it go); moving it moves a virtual stick
 * (up / down = throttle, left / right = steering) that stays where you leave it (or springs back, if set). Right click
 * centres it; the wheel is the weapon throttle; left click switches the weapon on / off.
 * Analog keyboards (Wooting, Razer Huntsman V3 Pro, Keychron HE...) in their gamepad mode, or any controller laid out
 * differently: a learned map (padmap) says which stick or trigger each control is. Learn one by pressing the key:
 * whichever axis or button moves furthest from where it rested is it, read from its resting value to the value at a
 * full press, so XInput sticks, DirectInput axes that rest at -1, and analog triggers all read 0..1.
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
    precision: 40,                    // % with Q held
    weapon_key_ramp: 1.0,             // s for Shift to take the weapon throttle from 0 to full (Ctrl takes it down)
    weapon_mode: "toggle",            // toggle or hold (Space / A button)
    weapon_level: 100,                // % weapon throttle when on
    mouse_px: 250,                    // mouse stick: how far (pixels) the mouse moves for full stick
    mouse_spring: 0,                  // mouse stick: how fast it springs back to centre (per second; 0 = stays put)
    keys: { up: ["KeyW", "ArrowUp"], down: ["KeyS", "ArrowDown"], left: ["KeyA", "ArrowLeft"], right: ["KeyD", "ArrowRight"],
            tankLup: ["KeyW"], tankLdown: ["KeyS"], tankRup: ["ArrowUp", "KeyI"], tankRdown: ["ArrowDown", "KeyK"],
            weapon: ["Space"], precision: ["KeyQ"], wup: ["ShiftLeft", "ShiftRight"], wdown: ["ControlLeft", "ControlRight"] },
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
    if (C.mix === "tank") { L = tankL - steer; R = tankR + steer; }   // A / D (or a steering stick) still turn it
    else {
      const cut = 1 - (1 - (C.steer_at_speed === undefined ? 100 : C.steer_at_speed) / 100) * Math.abs(thr);
      steer *= cut;
      if (C.invert_reverse && thr < -0.05) steer = -steer;
      L = thr - steer; R = thr + steer;                  // + steering turns left (counter-clockwise from above)
    }
    const cl = v => Math.max(-1, Math.min(1, v));
    return [cl(L), cl(R)];
  }

  // the controls a learned map can give, and what each does
  const PAD_CHANNELS = [["fwd", "throttle forward"], ["back", "throttle back"], ["left", "steer left"],
                        ["right", "steer right"], ["weapon", "weapon throttle"],
                        ["tankLup", "left side forward (tank)"], ["tankLdown", "left side back (tank)"],
                        ["tankRup", "right side forward (tank)"], ["tankRdown", "right side back (tank)"]];
  // a learned source's value 0..1: from its resting value to its full-press value
  function srcValue(gp, src) {
    if (!src || !gp) return 0;
    let raw;
    if (src.b !== undefined) { const b = gp.buttons[src.b]; raw = b ? (b.value || (b.pressed ? 1 : 0)) : 0; }
    else raw = gp.axes[src.a] || 0;
    const span = src.full - src.rest;
    if (Math.abs(span) < 1e-6) return 0;
    return Math.max(0, Math.min(1, (raw - src.rest) / span));
  }
  function padSnapshot(gp) {
    return { axes: Array.from(gp.axes), buttons: gp.buttons.map(b => b.value || (b.pressed ? 1 : 0)) };
  }

  class Input {
    constructor(target) {
      this.C = JSON.parse(JSON.stringify(DEFAULT_CONTROLS));
      this.down = new Set(); this.ramp = { thr: 0, steer: 0, L: 0, R: 0 };
      this.weaponOn = false; this.wthr = 0; this.events = [];
      this.pad = null; this.padPrev = {};
      this.padmap = null;               // {fwd: src, back: src, ...}: learned (see learn); null = the standard layout
      this.padKeysOff = true;           // while a learned map is in use, ignore the keyboard's own drive keys (analog
                                        // boards send both, and a digital key would read full the moment it actuates)
      this.learning = null;             // {ch, rest, best} while learning a control
      this.mx = 0; this.my = 0;         // the mouse stick, -1..1 (x right, y forward)
      this.mouseEl = null;
      if (target) {
        target.addEventListener("keydown", e => {
          if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
          if (this.C.keys.weapon.includes(e.code) && !e.repeat) {
            if (this.C.weapon_mode === "toggle") { this.weaponOn = !this.weaponOn; if (!this.weaponOn) this.wthr = 0; }
            e.preventDefault();
          }
          if (/^(Arrow|Space)/.test(e.code) || e.ctrlKey) e.preventDefault();   // Ctrl+S, Ctrl+D...: Ctrl is the weapon throttle
          this.down.add(e.code);
          if (!e.repeat) this.events.push(e.code);
        });
        target.addEventListener("keyup", e => { this.down.delete(e.code); });
        target.addEventListener("blur", () => this.down.clear());
      }
    }
    any(list) { return list.some(k => this.down.has(k)); }
    // the mouse as a joystick, on the 3D view's canvas
    attachMouse(el) {
      this.mouseEl = el;
      const locked = () => document.pointerLockElement === el;
      document.addEventListener("pointerlockchange", () => { if (!locked()) { this.mx = 0; this.my = 0; } });
      document.addEventListener("mousemove", e => {
        if (!locked()) return;
        const px = Math.max(20, this.C.mouse_px || 250), cl = v => Math.max(-1, Math.min(1, v));
        const lim = v => Math.max(-300, Math.min(300, v || 0));   // a glitched event (some systems jump) moves it no further
        this.mx = cl(this.mx + lim(e.movementX) / px); this.my = cl(this.my - lim(e.movementY) / px);
      });
      el.addEventListener("mousedown", e => {
        if (!locked()) return;
        e.preventDefault();
        if (e.button === 2) { this.mx = 0; this.my = 0; }
        else if (e.button === 0) { this.weaponOn = !this.weaponOn; if (!this.weaponOn) this.wthr = 0; }
      });
      el.addEventListener("contextmenu", e => { if (locked()) e.preventDefault(); });
      el.addEventListener("wheel", e => {
        if (!locked()) return;
        e.preventDefault();
        this.wthr = Math.max(0, Math.min(1, this.wthr - Math.sign(e.deltaY) * 0.1));    // 10 % a notch
      }, { passive: false });
    }
    // take the mouse (from a key press or a click: the browser needs one) or let it go
    toggleMouse() {
      const el = this.mouseEl; if (!el) return;
      if (document.pointerLockElement === el) { document.exitPointerLock(); return; }
      try { const p = el.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not allowed here */ }
    }
    mouseLocked() { return !!this.mouseEl && typeof document !== "undefined" && document.pointerLockElement === this.mouseEl; }
    connectedPad() {
      const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
      return Array.from(pads || []).find(p => p && p.connected) || null;
    }
    // learning: call learn(ch) with the key released, then press it fully and let go; learnStep() returns the source
    // once the press is over (or null while waiting). An axis or button counts once it moves more than 0.5.
    learn(ch) {
      const gp = this.connectedPad(); if (!gp) return false;
      this.learning = { ch, rest: padSnapshot(gp), best: null };
      return true;
    }
    learnStep() {
      const L = this.learning, gp = this.connectedPad(); if (!L || !gp) return null;
      const now = padSnapshot(gp);
      let top = null;
      now.axes.forEach((v, i) => { const d = Math.abs(v - (L.rest.axes[i] || 0)); if (!top || d > top.d) top = { d, a: i, v }; });
      now.buttons.forEach((v, i) => { const d = Math.abs(v - (L.rest.buttons[i] || 0)); if (!top || d > top.d) top = { d, b: i, v }; });
      if (top && top.d > Math.max(0.5, L.best ? L.best.d : 0)) L.best = top;          // the deepest press so far
      if (L.best) {
        const cur = L.best.a !== undefined ? now.axes[L.best.a] : now.buttons[L.best.b];
        const rest = L.best.a !== undefined ? L.rest.axes[L.best.a] : L.rest.buttons[L.best.b];
        if (Math.abs(cur - rest) < 0.15) {                // let go: done
          const src = L.best.a !== undefined ? { a: L.best.a, rest: +rest.toFixed(3), full: +L.best.v.toFixed(3) }
                                             : { b: L.best.b, rest: +rest.toFixed(3), full: +L.best.v.toFixed(3) };
          this.padmap = Object.assign({}, this.padmap || {}, { [L.ch]: src });
          this.learning = null;
          return src;
        }
      }
      return null;
    }
    // each mapped control's value now (0..1), for a live display
    padValues() {
      const gp = this.connectedPad(), out = {};
      for (const [ch] of PAD_CHANNELS) out[ch] = this.padmap && this.padmap[ch] ? srcValue(gp, this.padmap[ch]) : null;
      return out;
    }
    // the commands for this frame; dt = real seconds since the last
    read(dt) {
      const C = this.C, K = Object.assign({}, DEFAULT_CONTROLS.keys, C.keys), prec = this.any(K.precision) ? C.precision / 100 : 1;
      const rampTo = (key, tgt) => { const r = this.ramp, k = dt / Math.max(C.ramp, 1e-3); r[key] += Math.max(-k, Math.min(k, tgt - r[key])); return r[key]; };
      // keyboard (left out while a learned map drives, if asked: an analog board sends its keys too)
      const gpNow = this.connectedPad(), mapped = !!(this.padmap && gpNow && Object.keys(this.padmap).length);
      const keysOff = mapped && this.padKeysOff;
      // only the keys of controls the map actually has: an unmapped control (A / D before they are learned, or a key
      // the board does not send as a stick) still drives from the keyboard
      if (keysOff) {
        const pm = this.padmap, kmap = { fwd: K.up, back: K.down, left: K.left, right: K.right, tankLup: K.tankLup,
                                         tankLdown: K.tankLdown, tankRup: K.tankRup, tankRdown: K.tankRdown };
        for (const ch in kmap) if (pm[ch]) for (const k of kmap[ch]) this.down.delete(k);
      }
      let thr = rampTo("thr", (this.any(K.up) ? 1 : 0) - (this.any(K.down) ? 1 : 0));
      let steer = rampTo("steer", (this.any(K.left) ? 1 : 0) - (this.any(K.right) ? 1 : 0));
      let tL = rampTo("L", (this.any(K.tankLup) ? 1 : 0) - (this.any(K.tankLdown) ? 1 : 0));
      let tR = rampTo("R", (this.any(K.tankRup) ? 1 : 0) - (this.any(K.tankRdown) ? 1 : 0));
      // the mouse stick: drives while captured, unless a drive key is held (the keys win)
      if (this.mouseLocked()) {
        const sp = C.mouse_spring || 0;
        if (sp > 0) { const f = Math.max(0, 1 - sp * dt); this.mx *= f; this.my *= f; }
        if (!this.any(K.up) && !this.any(K.down)) { thr = this.my; tL = this.my; tR = this.my; }
        if (!this.any(K.left) && !this.any(K.right)) steer = -this.mx;
      }
      // weapon throttle on Shift (up) and Ctrl (down): it stays where you leave it
      const wk = dt / Math.max(C.weapon_key_ramp === undefined ? 1 : C.weapon_key_ramp, 0.05);
      if (this.any(K.wup)) this.wthr = Math.min(1, this.wthr + wk);
      if (this.any(K.wdown)) this.wthr = Math.max(0, this.wthr - wk);
      let weapon = (C.weapon_mode === "toggle" ? this.weaponOn : this.any(K.weapon)) ? C.weapon_level / 100 : 0;
      weapon = Math.max(weapon, this.wthr * C.weapon_level / 100);
      // game controller (takes over a channel when its stick is moved)
      const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = Array.from(pads || []).find(p => p && p.connected);
      this.pad = gp ? gp.id : null;
      if (gp && mapped) {                                // a learned map: each control from its own stick or trigger
        const m = this.padmap, v = ch => srcValue(gp, m[ch]), big = x => Math.abs(x) > 0.02;
        const pair = (a, b) => (m[a] || m[b]) ? v(a) - v(b) : null;
        const pt = pair("fwd", "back"), ps = pair("left", "right"), pl = pair("tankLup", "tankLdown"), pr = pair("tankRup", "tankRdown");
        // a pair drives outright only when both its ends are mapped; half a pair adds to the keyboard's other half
        const both = (a, b) => !!(m[a] && m[b]);
        if (pt !== null && ((keysOff && both("fwd", "back")) || big(pt))) thr = big(pt) ? pt : (both("fwd", "back") ? pt : thr);
        if (ps !== null && ((keysOff && both("left", "right")) || big(ps))) steer = big(ps) ? ps : (both("left", "right") ? ps : steer);
        if (pl !== null && ((keysOff && both("tankLup", "tankLdown")) || big(pl))) tL = big(pl) ? pl : tL;
        if (pr !== null && ((keysOff && both("tankRup", "tankRdown")) || big(pr))) tR = big(pr) ? pr : tR;
        if (C.mix === "tank" && pl === null && pt !== null) { tL = thr - steer; tR = thr + steer; }   // tank from a stick map
        if (m.weapon) { const w = v("weapon"); if (w > 0.02) weapon = Math.max(weapon, w * C.weapon_level / 100); }
      } else if (gp) {
        const ax = i => gp.axes[i] || 0, bt = i => gp.buttons[i] ? gp.buttons[i].value || (gp.buttons[i].pressed ? 1 : 0) : 0;
        const big = v => Math.abs(v) > 0.06;
        if (C.mix === "tank") { if (big(ax(1))) tL = -ax(1); if (big(ax(3))) tR = -ax(3); }
        else if (C.mix === "single") { if (big(ax(1))) thr = -ax(1); if (big(ax(0))) steer = -ax(0); }
        else { if (big(ax(1))) thr = -ax(1); if (big(ax(2))) steer = -ax(2); }
        const rt = bt(7); if (rt > 0.05) weapon = rt * C.weapon_level / 100;
        const edge = i => { const p = bt(i) > 0.5, was = this.padPrev[i]; this.padPrev[i] = p; return p && !was; };
        if (edge(0)) { this.weaponOn = !this.weaponOn; if (!this.weaponOn) this.wthr = 0; }
        if (edge(1)) this.events.push("PadReset");
        if (edge(9)) this.events.push("PadPause");
        if (C.weapon_mode === "toggle" && this.weaponOn && rt <= 0.05) weapon = C.weapon_level / 100;
        if (rt <= 0.05) weapon = Math.max(weapon, this.wthr * C.weapon_level / 100);
      }
      const [L, R] = mixer(C, curve(thr, C.thr) * prec, curve(steer, C.steer) * prec, curve(tL, C.thr) * prec, curve(tR, C.thr) * prec);
      this.lastRaw = { thr, steer, tL, tR };
      return { L, R, W: weapon, raw: { thr, steer, tL, tR } };
    }
    takeEvents() { const e = this.events; this.events = []; return e; }
  }

  const api = { Input, curve, mixer, DEFAULT_CONTROLS, PAD_CHANNELS, srcValue };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.RDS = root.RDS || {}; root.RDS.input = api; }
})(typeof window !== "undefined" ? window : globalThis);

/* RoborDriveSim app: the setup screen, the drive loop, the HUD and telemetry. */
(function () {
  "use strict";
  const { physics: PH, robots: RB, input: IN, render: RD } = window.RDS;
  let view = null;
  const $ = id => document.getElementById(id);
  const clone = o => JSON.parse(JSON.stringify(o));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window: not kept */ } },
  };

  // ------------------------------------------------------------------ state
  let mine = store.get("rds.robots", {});                 // name -> setup
  let S = clone(mine[store.get("rds.last", "")] || RB.PRESETS.flapjack);
  if (!S.controls) S.controls = clone(IN.DEFAULT_CONTROLS);
  const baseOf = X => X.base || (Object.entries(RB.PRESETS).find(([, p]) => p.name === X.name) || ["flapjack"])[0];
  S.base = baseOf(S);
  const env = Object.assign({ arena: "nhrl3", target: false, tmass_g: 1361, tsize: 120, theight: 60, tmu: 0.3 }, store.get("rds.env", {}));
  let R = null, sim = null, paused = false, timeScale = 1, carry = 0, last = 0;
  const CAMS = ["chase", "top", "arena", "orbit"];
  let trail = [], chart = [], tele = [], topSpeed = 0, matchT0 = 0, errorText = "";
  const input = new IN.Input(window);
  input.attachMouse(document.getElementById("cv"));
  // an analog keyboard (or any controller laid out its own way): its learned map belongs to this computer, not a robot
  const padStore = store.get("rds.padmap", null);
  if (padStore) { input.padmap = padStore.map || null; input.padKeysOff = padStore.keysOff !== false; }
  const savePad = () => store.set("rds.padmap", { map: input.padmap, keysOff: input.padKeysOff });

  function targetOpts() {
    if (!env.target) return null;
    const A = RB.ARENAS[env.arena].size || 3;
    return { x: 0, y: 0.15 * A, psi: 0.3, m: env.tmass_g / 1000, a: env.tsize / 1000, b: env.tsize / 1000, c: (env.theight || 60) / 1000, mu: env.tmu };
  }
  function rebuild(keepPose) {
    try {
      R = RB.build(S); errorText = "";
    } catch (e) { errorText = String(e.message || e); return; }
    const AR = RB.ARENAS[env.arena];
    const opts = { arena: AR.size, ceiling: AR.ceiling || 0, target: targetOpts() };
    const pose = keepPose && sim ? { x: sim.state.x, y: sim.state.y, psi: sim.state.psi } : null;
    sim = new PH.Sim(R, opts);
    if (pose) sim.reset(pose);
    R._wg = Array.from(sim.c.wheelGroup);
    input.C = S.controls;
    if (view) { view.arena(AR.size, AR.ceiling || 0); view.robot(S, R); view.target(sim.tg); }
    trail = []; chart = []; tele = []; topSpeed = 0; matchT0 = 0;
  }

  // ------------------------------------------------------------------ the robot menu
  function fillRobotSel() {
    const sel = $("robotSel"); sel.innerHTML = "";
    const g1 = document.createElement("optgroup"); g1.label = "My robots";
    Object.keys(mine).sort().forEach(n => { const o = document.createElement("option"); o.value = "m:" + n; o.textContent = n; g1.appendChild(o); });
    if (g1.children.length) sel.appendChild(g1);
    const g2 = document.createElement("optgroup"); g2.label = "Start from an archetype";
    Object.entries(RB.PRESETS).forEach(([k, p]) => { const o = document.createElement("option"); o.value = "p:" + k; o.textContent = `${p.name}: ${p.archetype}`; g2.appendChild(o); });
    sel.appendChild(g2);
    sel.value = mine[S.name] ? "m:" + S.name : (Object.entries(RB.PRESETS).find(([, p]) => p.name === S.name) ? "p:" + Object.entries(RB.PRESETS).find(([, p]) => p.name === S.name)[0] : sel.options[0].value);
  }
  $("robotSel").onchange = e => {
    const v = e.target.value;
    const C0 = S.controls;
    S = clone(v.startsWith("m:") ? mine[v.slice(2)] : RB.PRESETS[v.slice(2)]);
    if (v.startsWith("p:")) { S.base = v.slice(2); S.controls = C0; }    // your controls follow you to another robot
    if (!S.controls) S.controls = clone(IN.DEFAULT_CONTROLS);
    S.base = baseOf(S);
    store.set("rds.last", S.name);
    input.weaponOn = false; input.wthr = 0;
    rebuild(); renderSetup();
  };

  // ------------------------------------------------------------------ setup screen
  const get = (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
  const put = (o, p, v) => { const ks = p.split("."); let a = o; ks.slice(0, -1).forEach(k => { if (a[k] == null) a[k] = {}; a = a[k]; }); a[ks[ks.length - 1]] = v; };
  function changed(rebuildPose) { rebuild(rebuildPose !== false); drawSetup(); }

  function fNum(label, path, unit, o = {}) {
    const v = get(S, path);
    const ph = o.ph !== undefined ? ` placeholder="${+(+o.ph).toPrecision(4)}"` : "";
    return `<div class="f${o.adv ? " adv" : ""}"><label>${label}</label><input type="number" data-p="${path}" value="${v === undefined || v === null ? "" : +(+v).toPrecision(6)}" step="${o.step || "any"}"${o.min !== undefined ? ` min="${o.min}"` : ""}${ph}><span class="u">${unit || ""}</span>${o.hint ? `<div class="hint">${o.hint}</div>` : ""}</div>`;
  }
  function fSel(label, path, opts, o = {}) {
    const v = String(get(S, path));
    const opt = ([k, l]) => `<option value="${k}"${String(k) === v ? " selected" : ""}>${l}</option>`;
    let body;
    if (opts.some(q => q[2])) {                          // grouped by maker
      const groups = [...new Set(opts.map(q => q[2] || "Other"))];
      body = groups.map(gname => `<optgroup label="${gname}">${opts.filter(q => (q[2] || "Other") === gname).map(opt).join("")}</optgroup>`).join("");
    } else body = opts.map(opt).join("");
    return `<div class="f${o.adv ? " adv" : ""}"><label>${label}</label><select data-p="${path}" data-t="${o.type || "str"}"${o.wide ? ' style="flex:1 1 100%"' : ""}>${body}</select>${o.hint ? `<div class="hint">${o.hint}</div>` : ""}</div>`;
  }
  function fChk(label, path, o = {}) {
    return `<div class="f${o.adv ? " adv" : ""}"><label>${label}</label><input type="checkbox" data-p="${path}"${(get(S, path) === undefined ? o.def : get(S, path)) ? " checked" : ""}>${o.hint ? `<div class="hint">${o.hint}</div>` : ""}</div>`;
  }
  const opts = o => Object.entries(o).map(([k, v]) => [k, v.label, v.group]);

  function motorHint(M) {
    const bits = [`${M.kv} KV`, `R ${M.R} Ω`];
    if (M.G) bits.push(`${(+M.G).toFixed(M.G % 1 ? 1 : 0)}:1, efficiency ${M.eta}`);
    if (M.mass_g) bits.push(`${M.mass_g} g`);
    return bits.join(" · ") + (M.src ? `<br>${M.src}` : "") + (M.url ? ` · <a href="${M.url}" target="_blank" rel="noopener" style="color:var(--blue)">product page</a>` : "");
  }
  function wheelRows() {
    return `<table class="t"><tr><th>#</th><th>x mm</th><th>y mm</th><th>diameter</th><th>width</th><th>side</th><th>driven</th></tr>` +
      S.wheels.map((q, i) => `<tr><td>${i + 1}</td>
        <td><input type="number" data-p="wheels.${i}.x" value="${q.x}"></td><td><input type="number" data-p="wheels.${i}.y" value="${q.y}"></td>
        <td><input type="number" data-p="wheels.${i}.d" value="${q.d}"></td><td><input type="number" data-p="wheels.${i}.w" value="${q.w || 16}"></td>
        <td><select data-p="wheels.${i}.side"><option${q.side === "L" ? " selected" : ""}>L</option><option${q.side === "R" ? " selected" : ""}>R</option></select></td>
        <td><input type="checkbox" data-p="wheels.${i}.driven"${q.driven ? " checked" : ""}></td></tr>`).join("") + `</table>`;
  }
  function skidRows() {
    if (!S.skids.length) return `<div class="note">No skids: the wheels carry all the weight.</div>`;
    return `<table class="t"><tr><th>#</th><th>x mm</th><th>y mm</th><th title="how far above the floor it sits at rest: 0 touches; a little lets the wheels carry the robot">gap mm</th><th>material</th><th title="sliding friction; blank = the material's value">μ</th></tr>` +
      S.skids.map((q, i) => `<tr><td>${i + 1}</td><td><input type="number" data-p="skids.${i}.x" value="${q.x}"></td><td><input type="number" data-p="skids.${i}.y" value="${q.y}"></td>
        <td><input type="number" data-p="skids.${i}.gap" value="${q.gap || 0}" style="width:50px"></td>
        <td><select data-p="skids.${i}.type">${opts(RB.SKIDS).map(([k, l]) => `<option value="${k}"${k === q.type ? " selected" : ""}>${l}</option>`).join("")}</select></td>
        <td><input type="number" step="0.01" min="0" data-p="skids.${i}.adv.muk" value="${q.adv && q.adv.muk !== undefined ? q.adv.muk : ""}" placeholder="${(RB.SKIDS[q.type] || RB.SKIDS.steel).muk}" style="width:60px"></td></tr>`).join("") + `</table>`;
  }
  function dirOpts(type) {
    return type === "horizontal" ? [[1, "counter-clockwise from above"], [-1, "clockwise from above"]] : [[1, "front of the weapon moves up (hits upward)"], [-1, "front moves down (hits downward)"]];
  }

  function renderSetup() {
    const W = S.weapon || { type: "none" }, C = S.controls, hasW = W.type && W.type !== "none";
    const TI = RB.TIRES[S.tire] || RB.TIRES.urethane, DM = RB.DRIVE_MOTORS[S.drive.motor] || RB.DRIVE_MOTORS.compact1806;
    const WM = RB.WEAPON_MOTORS[W.motor] || RB.WEAPON_MOTORS.m2807_1350;
    $("sbody").innerHTML = `
      <h3 class="step">1 · Pick a robot</h3>
      <div class="cards">${presetCards()}</div>
      <canvas id="view" width="1040" height="600"></canvas>
      <div class="out" id="sum"></div>
      <h3 class="step">2 · Your hardware <button id="bStock" class="mini" title="Put every setting back to this robot's stock values (keeps your controls)">Back to stock</button></h3>
      <div class="note">${S.note || ""}</div>
      <div id="tune">${tuneRows()}</div>
      <h3 class="step">3 · Controls and arena</h3>
      <details><summary>Driving curves <span class="q">how the sticks and keys feel</span></summary><div class="sec">
        <canvas id="curves" width="1040" height="300"></canvas>
        ${fSel("Mix", "controls.mix", [["arcade", "Arcade: left stick throttle, right stick steering"], ["single", "Single stick: left stick does both"], ["tank", "Tank: one stick per side"]])}
        ${fNum("Throttle rate", "controls.thr.rate", "%")}${fNum("Throttle expo", "controls.thr.expo", "%")}${fNum("Throttle deadband", "controls.thr.deadband", "%", { adv: true })}
        ${fChk("Throttle reversed", "controls.thr.reverse", { adv: true })}
        ${fNum("Steering rate (turn rate)", "controls.steer.rate", "%")}${fNum("Steering expo", "controls.steer.expo", "%")}${fNum("Steering deadband", "controls.steer.deadband", "%", { adv: true })}
        ${fChk("Steering reversed", "controls.steer.reverse", { adv: true })}
        ${fNum("Steering left at full throttle", "controls.steer_at_speed", "%", { hint: "100 = the same at any speed" })}
        ${fChk("Steering flips when backing up", "controls.invert_reverse")}
        ${fChk("Invert the controls when it is upside down", "controls.auto_invert", { hint: "like flipping your transmitter's invert switch the moment it lands upside down" })}
        ${fNum("Key ramp (keyboard)", "controls.ramp", "s", { hint: "how long a held key takes to reach full" })}
        ${fNum("Mouse stick: mouse travel for full stick", "controls.mouse_px", "px", { ph: 250, hint: "M takes the mouse as a joystick (Esc lets go): up / down throttle, left / right steering; right click centres it, the wheel is the weapon throttle, left click the weapon on / off" })}
        ${fNum("Mouse stick deadzone", "controls.mouse_deadzone", "%", { ph: 5, hint: "travel round the centre that reads as zero, on each axis, so a small bump of the mouse doesn't creep the robot" })}
        ${fNum("Mouse stick springs back to centre", "controls.mouse_spring", "/s", { ph: 0, hint: "0 = it stays where you leave it, like a held stick; 3 = most of the way back in a third of a second" })}
        ${fNum("Precision (Q held)", "controls.precision", "%")}
        ${fNum("Weapon throttle on Shift / Ctrl: 0 to full in", "controls.weapon_key_ramp", "s", { ph: 1, hint: "hold Shift to spin up, Ctrl to spin down; it stays where you let go. Space switches it off." })}
        ${fSel("Weapon button", "controls.weapon_mode", [["toggle", "Toggle on / off"], ["hold", "Hold to spin"]])}
        ${fNum("Weapon throttle when on", "controls.weapon_level", "%")}
        ${fChk("Let go of the weapon after each hit", "controls.weapon_off_after_hit", { def: true, hint: "as drivers do: the blade stops pulling the robot round and the gyro calms down. Press the weapon again to spin back up" })}
      </div></details>
      <details id="padSec"><summary>Analog keyboard / controller map <span class="q">which key or stick is which</span></summary><div class="sec" id="padBody"></div></details>
      <details><summary>Arena and target <span class="q">where it drives</span></summary><div class="sec">
        <div class="f"><label>Arena</label><select id="arenaSel">${opts(RB.ARENAS).map(([k, l]) => `<option value="${k}"${k === env.arena ? " selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="f"><label>Target box mass</label><input type="number" id="tMass" value="${env.tmass_g}"><span class="u">g</span></div>
        <div class="f"><label>Target box size (square)</label><input type="number" id="tSize" value="${env.tsize}"><span class="u">mm</span></div>
        <div class="f"><label>Target box height</label><input type="number" id="tHeight" value="${env.theight || 60}"><span class="u">mm</span></div>
        <div class="f"><label>Target floor friction</label><input type="number" id="tMu" value="${env.tmu}"><span class="u">μ</span></div>
      </div></details>
      <details id="advAll"><summary>Edit every number <span class="q">positions, wheels, skids, motors: for building your own robot</span></summary><div class="sec">
      <div class="f"><label>Name</label><input type="text" data-p="name" data-t="str" value="${S.name}" style="flex:1"></div>
      <div class="note">Measure every position in mm from one point on the robot (the drive axle centre is handy): x forward, y left.</div>
      <details><summary>Robot <span class="q">how heavy, where is the COG, what is its MOI</span></summary><div class="sec">
        ${fNum("Weight", "mass_g", "g", { hint: "3 lb class limit: 1361 g" })}
        ${fNum("COG forward (x)", "cog.x", "mm")}${fNum("COG left (y)", "cog.y", "mm")}${fNum("COG height above the floor", "cog.h", "mm", { hint: "sets how much weight shifts when it speeds up, brakes or turns" })}
        ${fChk("Estimate the yaw MOI for me", "moi_auto", { hint: "from the outline, wheels and weapon; your CAD's value (about the COG, vertical axis) is better" })}
        ${S.moi_auto ? "" : fNum("Yaw MOI about the COG (turning)", "moi_gmm2", "g mm²", { hint: "SolidWorks Mass Properties: Lzz at the centre of mass, in grams × mm²" })}
        ${S.moi_auto ? "" : fNum("Roll MOI (about x, forward)", "moi_roll", "g mm²", { ph: RB.moi3(Object.assign({}, S, { moi_roll: 0 }))[0], hint: "blank = in proportion to the yaw value; matters for tipping and gyro tilt" })}
        ${S.moi_auto ? "" : fNum("Pitch MOI (about y, left)", "moi_pitch", "g mm²", { ph: RB.moi3(Object.assign({}, S, { moi_pitch: 0 }))[1] })}
        ${fNum("Body bottom above the floor", "body.z0", "mm", { hint: "ground clearance of the chassis (what lands when it tips)" })}
        ${fNum("Body top above the floor", "body.z1", "mm", { hint: "wheels taller than this: it drives upside down too" })}
        <div class="f"><label>Body outline (x,y points in mm, around the edge)</label><textarea rows="2" data-p="body.pts" data-t="pts">${S.body.pts.map(p => p.join(",")).join("; ")}</textarea>
          <div class="hint">what hits the walls and the target, and what is drawn. Wheels and the weapon are added on.</div></div>
      </div></details>
      <details><summary>Wheels <span class="q">how many, where, how big, what tire</span></summary><div class="sec">
        ${fSel("Number of wheels", "_nwheels", [[2, "2"], [3, "3"], [4, "4"], [6, "6"]], { type: "num" })}
        ${wheelRows()}
        ${fChk("Wheels on each side linked (chain / belt)", "linked", { hint: "linked: each side's wheels turn together on that side's motors; not linked: every driven wheel has its own motor" })}
        ${S.linked ? fNum("Motors per side", "motors_per_side", "", { step: 1, min: 1 }) : ""}
        ${fSel("Tire", "tire", opts(RB.TIRES))}
        ${fNum("Grip sliding (μ)", "tire_adv.muk", "", { adv: true, hint: "blank = the tire's value (shown greyed)", ph: TI.muk })}${fNum("Grip peak (μ)", "tire_adv.mus", "", { adv: true, ph: TI.mus })}
        ${fNum("Slip ratio at the peak", "tire_adv.sigp", "", { adv: true, ph: TI.sigp })}${fNum("Rolling resistance (Crr)", "tire_adv.crr", "", { adv: true, ph: TI.crr })}
      </div></details>
      <details><summary>Skids <span class="q">anything else touching the floor</span></summary><div class="sec">
        ${fSel("Number of skids", "_nskids", [[0, "0"], [1, "1"], [2, "2"], [3, "3"], [4, "4"]], { type: "num" })}
        ${skidRows()}
      </div></details>
      <details><summary>Drive motors and battery <span class="q">what drives it</span></summary><div class="sec">
        ${fSel("Drive motor", "drive.motor", opts(RB.DRIVE_MOTORS), { wide: true, hint: motorHint(DM) })}
        ${DM.tangent_d ? fNum("Roller (motor shaft) diameter", "drive.roller_d", "mm", { ph: DM.tangent_d, hint: `tangent drive: ratio = wheel / roller = ${RB.tangentRatio(S, DM).toFixed(2)}:1` }) : ""}
        ${fNum("ESC current limit", "drive.esc_A", "A")}
        ${fChk("Drag brake (stops when you let go)", "drive.brake")}
        ${fNum("Drive voltage cap", "drive.drive_V", "V", { hint: "0 = the full pack; a value runs the drive slower than the pack (an ESC endpoint, e.g. 5S drive on a 6S pack)" })}
        ${fNum("Motor kv", "drive.adv.kv", "rpm/V", { adv: true, hint: "blank = the motor's value (shown greyed)", ph: DM.kv })}${fNum("Motor resistance", "drive.adv.R", "Ω", { adv: true, ph: DM.R })}
        ${fNum("Gearbox ratio", "drive.adv.G", ":1", { adv: true, ph: DM.G })}${fNum("Gearbox efficiency", "drive.adv.eta", "", { adv: true, ph: DM.eta })}${fNum("Rotor inertia", "drive.adv.Jrot", "kg m²", { adv: true, ph: DM.Jrot })}
        ${fNum("Battery cells", "battery.cells", "S", { step: 1, min: 1 })}${fNum("Capacity", "battery.mAh", "mAh")}
        ${fNum("Pack resistance", "battery.R_mohm", "mΩ", { adv: true, ph: 40 })}${fNum("Volts per cell", "battery.cellV", "V", { adv: true, hint: "blank = 3.7 (nominal); 4.2 full, 3.85 HV nominal", ph: 3.7 })}
      </div></details>
      <details><summary>Weapon <span class="q">how big, how heavy, where, which way</span></summary><div class="sec">
        ${fSel("Weapon", "weapon.type", [["none", "None"], ["horizontal", "Horizontal spinner (blade, disc, shell, ring)"], ["vertical", "Vertical spinner (disc, beater)"], ["drum", "Drum"]])}
        ${hasW ? `
        ${fNum("Centre forward (x)", "weapon.x", "mm")}${fNum("Centre left (y)", "weapon.y", "mm")}
        ${fNum("Centre height above the floor", "weapon.z", "mm", { hint: W.type === "horizontal" ? "the blade's plane" : "the axle" })}
        ${fNum("Diameter", "weapon.d", "mm", { hint: W.type === "horizontal" ? "tip to tip" : "tooth tip circle" })}
        ${fNum("Spinning mass", "weapon.mass_g", "g", { hint: "only the part that spins" })}
        ${fSel("Shape", "weapon.shape", opts(RB.SHAPES))}
        ${fNum(W.type === "horizontal" ? "Thickness" : "Width across the robot", "weapon.thick", "mm")}
        ${W.type === "horizontal" && W.shape === "bar" ? fNum("Blade width (drawing only)", "weapon.blade_w", "mm") : ""}
        ${W.type === "horizontal" ? fChk("Weapon sits above the body (shell, ring, top spinner)", "weapon.above", { hint: "off for an undercutter: drawn under the chassis" }) : ""}
        ${fNum("Teeth (impacts per turn)", "weapon.teeth", "", { step: 1, min: 1 })}
        ${fSel("Spin direction", "weapon.dir", dirOpts(W.type), { type: "num" })}
        ${fSel("Weapon motor", "weapon.motor", opts(RB.WEAPON_MOTORS), { wide: true, hint: motorHint(WM) })}
        ${fNum("Number of weapon motors", "weapon.motors", "", { step: 1, min: 1 })}
        ${fNum("Reduction (motor turns per weapon turn)", "weapon.ratio", ":1", { hint: "belt or friction drive; 1 = direct" })}
        ${fNum("Weapon ESC current limit", "weapon.esc_A", "A")}
        ${fChk("ESC brakes the weapon when off", "weapon.brake", { def: true, hint: "drag brake: the motor slows the blade instead of letting it coast" })}
        ${fNum("Brake current", "weapon.brake_A", "A", { adv: true, hint: "blank = the ESC current limit" })}
        ${fNum("Speed cap", "weapon.rpm_cap", "rpm", { hint: "0 = none; a governor or the throttle you run it at" })}
        ${fNum("Weapon MOI (overrides the shape)", "weapon.I_override", "kg m²", { adv: true, hint: "blank = from the shape, mass and diameter", ph: hasW ? RB.weaponI(Object.assign({}, W, { I_override: 0 })) : 0 })}
        ${fNum("Weapon motor kv", "weapon.adv.kv", "rpm/V", { adv: true, ph: WM.kv })}${fNum("Weapon motor resistance", "weapon.adv.R", "Ω", { adv: true, ph: WM.R })}
        ${fNum("Hit restitution", "weapon.adv.bite_e", "", { adv: true, hint: "0 to 1: how much a tooth bounces off rather than bites", ph: 0.3 })}
        ${fNum("Most of the blade's energy one hit can take", "weapon.adv.hit_take", "%", { adv: true, ph: 50, hint: "a rigid hit would stop the blade dead; real armour crushes, so blades keep speed. Tune from slow-motion video: blade rpm before and after a hit" })}
        ` : ""}
      </div></details>
      </div></details>
      </div></details>`;
    // bind
    $("sbody").querySelectorAll("[data-p]").forEach(el => {
      el.addEventListener("change", () => {
        const p = el.dataset.p, t = el.dataset.t;
        let v = el.type === "checkbox" ? el.checked : el.value;
        if (p === "_nwheels") return setWheelCount(+v);
        if (p === "_nskids") return setSkidCount(+v);
        if (t === "pts") {
          const pts = String(v).split(/[;\n]+/).map(s => s.split(",").map(Number)).filter(q => q.length === 2 && q.every(isFinite));
          if (pts.length >= 3) v = pts; else return;
        } else if (el.type === "number") v = v === "" ? undefined : +v;
        else if (t === "num") v = +v;
        if (/^(tire_adv|drive\.adv|weapon\.adv)\./.test(p) || p === "weapon.I_override" || p === "battery.cellV") { if (v === undefined) { put(S, p, undefined); changed(); return; } }
        if (p === "weapon.type" && v !== "none" && (!S.weapon || !S.weapon.d)) S.weapon = clone(RB.PRESETS.undercutter.weapon);
        put(S, p, v);
        const structural = /^(weapon\.type|weapon\.motor|weapon\.shape|moi_auto|moi_gmm2|linked|controls\.mix|tire|drive\.motor|wheels\.\d+\.d)$/.test(p);
        changed(); if (structural) renderSetup();
      });
    });
    const envChange = () => { env.arena = $("arenaSel").value; env.tmass_g = +$("tMass").value; env.tsize = +$("tSize").value; env.theight = +$("tHeight").value; env.tmu = +$("tMu").value; store.set("rds.env", env); rebuild(); drawSetup(); };
    ["arenaSel", "tMass", "tSize", "tHeight", "tMu"].forEach(id => $(id).addEventListener("change", envChange));
    $("sbody").querySelectorAll("[data-card]").forEach(el => el.onclick = () => pickPreset(el.dataset.card));
    $("bStock").onclick = () => pickPreset(S.base);
    bindTune();
    renderPad();
    const nw = $("sbody").querySelector('[data-p="_nwheels"]'); if (nw) nw.value = String(S.wheels.length);
    const ns = $("sbody").querySelector('[data-p="_nskids"]'); if (ns) ns.value = String(S.skids.length);
    drawSetup();
  }
  // ---- 1 · pick: a card per stock robot, drawn from above
  function topView(P) {
    const pts = [], W = P.weapon || {};
    P.body.pts.forEach(p => pts.push(p));
    P.wheels.forEach(q => { const r = q.d / 2, w = (q.w || 16) / 2; pts.push([q.x - r, q.y - w], [q.x + r, q.y + w]); });
    if (W.type && W.type !== "none") { const r = W.d / 2; pts.push([W.x - r, W.y - r], [W.x + r, W.y + r]); }
    (P.skids || []).forEach(q => pts.push([q.x, q.y]));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), pad = 12;
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    const X = (x, y) => `${(-y).toFixed(1)},${(-x).toFixed(1)}`;      // forward is up the card, left is left
    let g = `<polygon points="${P.body.pts.map(p => X(p[0], p[1])).join(" ")}" fill="#273041" stroke="#8a94a6" stroke-width="3"/>`;
    P.wheels.forEach(q => { const r = q.d / 2, w = (q.w || 16) / 2; g += `<rect x="${-q.y - w}" y="${-q.x - r}" width="${2 * w}" height="${2 * r}" rx="${Math.min(w, r) * 0.6}" fill="#11151c" stroke="#5d6878" stroke-width="3"/>`; });
    (P.skids || []).forEach(q => { g += `<circle cx="${-q.y}" cy="${-q.x}" r="6" fill="#8a94a6"/>`; });
    if (W.type === "horizontal") g += `<circle cx="${-W.y}" cy="${-W.x}" r="${W.d / 2}" fill="#e5383b22" stroke="#e5383b" stroke-width="4"/>`;
    else if (W.type && W.type !== "none") { const t = Math.max(W.thick || 10, 8); g += `<rect x="${-W.y - t / 2}" y="${-W.x - W.d / 2}" width="${t}" height="${W.d}" rx="3" fill="#e5383b"/>`; }
    return `<svg viewBox="${-y1} ${-x1} ${y1 - y0} ${x1 - x0}" preserveAspectRatio="xMidYMid meet">${g}</svg>`;
  }
  function presetCards() {
    return Object.entries(RB.PRESETS).map(([k, P]) => `<button class="card${k === S.base ? " on" : ""}" data-card="${k}" title="${P.archetype.replace(/"/g, "&quot;")}">${topView(P)}<b>${P.name}</b><span>${P.archetype.split(/[,(]/)[0]}</span></button>`).join("");
  }
  function pickPreset(k) {
    const C0 = S.controls;
    S = clone(RB.PRESETS[k]); S.base = k; S.controls = C0 || clone(IN.DEFAULT_CONTROLS);
    store.set("rds.last", S.name); input.weaponOn = false; input.wthr = 0;
    rebuild(); renderSetup(); fillRobotSel();
  }

  // ---- 2 · tune: a few knobs that move the numbers that matter for driving, worked out for you
  function weaponSpinTime(A, Wt) {                    // s to 90 % of the target speed at an ESC limit of A amps
    const W = R && R.weapon; if (!W) return 0;
    const Ke = 60 / (2 * Math.PI * W.motor.kv), V = R.battery.V, target = 0.9 * Wt;
    let w = 0, t = 0; const dt = 0.002;
    while (w < target && t < 30) { const I = Math.min(A, (V - Ke * w * W.G) / W.motor.R); if (I <= 0) return 30; w += W.n * Ke * I * W.G * W.eta / W.I * dt; t += dt; }
    return t;
  }
  function knobs() {
    const sm = (() => { try { return RB.summary(S); } catch (e) { return {}; } })();
    const W = S.weapon || {}, hasW = W.type && W.type !== "none";
    const driven = S.wheels.filter(q => q.driven), xw = driven.reduce((a, q) => a + q.x, 0) / Math.max(driven.length, 1);
    const xs = S.skids.length ? S.skids.reduce((a, q) => a + q.x, 0) / S.skids.length : null;
    const main = S.wheels.find(q => q.driven) || S.wheels[0];
    const discJ = q => 0.5 * (q.mass_g || 25) * Math.pow(q.d / 2, 2);            // g mm^2
    const K = [
      { head: "Drive" },
      { id: "dmotor", label: "Drive motor", sel: opts(RB.DRIVE_MOTORS), get: () => S.drive.motor,
        set: v => { S.drive.motor = v; if (S.drive.adv) delete S.drive.adv.G; delete S.drive.roller_d; } },
      { id: "desc", label: "Drive ESC current limit", unit: "A", num: true, get: () => S.drive.esc_A, set: v => { S.drive.esc_A = v; } },
      { id: "cells", label: "Battery", sel: [[2, "2S"], [3, "3S"], [4, "4S"], [5, "5S"], [6, "6S"]], num: true, get: () => S.battery.cells, set: v => { S.battery.cells = v; } },
      { id: "mah", label: "Battery capacity", unit: "mAh", num: true, get: () => S.battery.mAh, set: v => { S.battery.mAh = v; } },
      { id: "wheeld", label: "Wheel diameter", unit: "mm", num: true, get: () => main.d,
        set: v => { const k = v / main.d; S.wheels.forEach(q => { q.d = +(q.d * k).toFixed(1); }); } },
      { id: "wheelm", label: "Wheel mass (each, with tire and hub)", unit: "g", num: true, get: () => main.mass_g || 25,
        set: v => { S.wheels.forEach(q => { q.mass_g = v; }); } },
      { id: "wheelJ", label: "Wheel MOI (each, about its axle)", unit: "g mm²", num: true, blank: true, get: () => S.wheel_moi_gmm2,
        ph: () => Math.round(discJ(main)), set: v => { if (v > 0) S.wheel_moi_gmm2 = v; else delete S.wheel_moi_gmm2; },
        hint: "from CAD; blank = a solid disc of that mass. Heavy wheels launch slower and kick the chassis when they spin up" },
      { id: "tire", label: "Tires", sel: Object.entries(RB.TIRES).map(([k, t]) => [k, t.label]), get: () => S.tire, set: v => { S.tire = v; delete S.tire_adv; } },
      { id: "mass", label: "Robot weight", unit: "g", num: true, get: () => S.mass_g, set: v => { S.mass_g = v; }, hint: "3 lb class: 1361 g" },
    ];
    if (xs !== null && Math.abs(xs - xw) > 5) K.push({ id: "share", label: "Weight on the wheels", unit: "%", min: 20, max: 95, step: 1, get: () => 100 * sm.wheel_share,
      set: v => { S.cog.x = +(xs - v / 100 * (xs - xw)).toFixed(1); }, fmt: v => `${v.toFixed(0)} %`, hint: "your CAD's split: moves the COG between the wheels and the skids" });
    if (hasW) {
      const scaleI = (m1, d1) => { if (W.I_override) W.I_override *= (m1 / W.mass_g) * Math.pow(d1 / W.d, 2); };
      K.push(
        { head: "Weapon" },
        { id: "wmotor", label: "Weapon motor", sel: opts(RB.WEAPON_MOTORS), get: () => W.motor, set: v => { W.motor = v; if (W.adv) { delete W.adv.kv; delete W.adv.R; } } },
        { id: "wn", label: "Number of weapon motors", unit: "", num: true, get: () => W.motors || 1, set: v => { W.motors = Math.max(1, Math.round(v)); } },
        { id: "wratio", label: "Reduction (motor turns per weapon turn)", unit: ":1", num: true, get: () => W.ratio || 1, set: v => { W.ratio = v; }, hint: "1 = direct drive" },
        { id: "wesc", label: "Weapon ESC current limit", unit: "A", num: true, get: () => W.esc_A || 40, set: v => { W.esc_A = v; } },
        { id: "wcap", label: "Speed limit (throttle you run it at)", unit: "rpm", num: true, blank: true, get: () => W.rpm_cap || undefined, ph: () => Math.round(sm.weapon_rpm_free || 0),
          set: v => { W.rpm_cap = v > 0 ? v : 0; }, hint: "blank = full throttle" },
        { id: "wd", label: "Blade diameter", unit: "mm", num: true, get: () => W.d, set: v => { scaleI(W.mass_g, v); W.d = v; }, hint: W.type === "horizontal" ? "tip to tip" : "tooth tip circle" },
        { id: "wm", label: "Blade mass (the spinning part)", unit: "g", num: true, get: () => W.mass_g, set: v => { scaleI(v, W.d); W.mass_g = v; } },
        { id: "wshape", label: "Blade shape", sel: opts(RB.SHAPES), get: () => W.shape, set: v => { W.shape = v; delete W.I_override; } },
        { id: "wI", label: "Blade MOI", unit: "kg m²", num: true, blank: true, get: () => W.I_override, ph: () => +RB.weaponI(Object.assign({}, W, { I_override: 0 })).toPrecision(3),
          set: v => { if (v > 0) W.I_override = v; else delete W.I_override; }, hint: "from CAD; blank = from the shape, mass and diameter" },
        { id: "wteeth", label: "Teeth", unit: "", num: true, get: () => W.teeth || 2, set: v => { W.teeth = Math.max(1, Math.round(v)); } },
        { id: "wdir", label: "Spin direction", sel: dirOpts(W.type), num: true, get: () => W.dir, set: v => { W.dir = v; } });
    }
    return K;
  }
  // what the hardware gives: worked out, not typed in
  function derived() {
    let sm; try { sm = RB.summary(S); } catch (e) { return ""; }
    const W = S.weapon || {}, rows = [
      ["Top speed (no load)", `${sm.top_speed.toFixed(2)} m/s · ${(sm.top_speed * 2.237).toFixed(1)} mph`],
      ["Weight on the wheels", `${(100 * sm.wheel_share).toFixed(0)} %`]];
    if (sm.weapon_I) {
      const rpm = Math.min(sm.weapon_rpm_free, W.rpm_cap || 1e9), w = rpm * Math.PI / 30;
      rows.push(["Weapon speed", `${rpm.toFixed(0)} rpm${W.rpm_cap && W.rpm_cap < sm.weapon_rpm_free ? ` (motor could do ${sm.weapon_rpm_free.toFixed(0)})` : ""}`],
        ["Stored energy", `${(0.5 * sm.weapon_I * w * w).toFixed(0)} J`], ["Tip speed", `${(w * W.d / 2000).toFixed(0)} m/s`],
        ["Spin-up to 90 %", `${weaponSpinTime(W.esc_A || 40, w).toFixed(1)} s`]);
    }
    return `<table class="t derived">${rows.map(([a, b]) => `<tr><td>${a}</td><td><b>${b}</b></td></tr>`).join("")}</table>`;
  }
  function tuneRows() {
    return knobs().map(k => {
      if (k.head) return `<div class="khead">${k.head}</div>`;
      const v = k.get(), hint = k.hint ? `<div class="hint">${k.hint}</div>` : "";
      if (k.sel) {
        const opt = ([a, l]) => `<option value="${a}"${String(a) === String(v) ? " selected" : ""}>${l}</option>`;
        const body = k.sel.some(q => q[2]) ? [...new Set(k.sel.map(q => q[2] || "Other"))].map(g => `<optgroup label="${g}">${k.sel.filter(q => (q[2] || "Other") === g).map(opt).join("")}</optgroup>`).join("") : k.sel.map(opt).join("");
        return `<div class="f knob"><label>${k.label}</label><select data-k="${k.id}">${body}</select>${hint}</div>`;
      }
      if (k.min === undefined) {                       // hardware: a number you read off the part
        const ph = k.ph ? ` placeholder="${k.ph()}"` : "", val = v === undefined || v === null || v === "" ? "" : +(+v).toPrecision(6);
        return `<div class="f knob num"><label>${k.label}</label><input type="number" step="any" data-k="${k.id}" value="${val}"${ph}><span class="u">${k.unit}</span>${hint}</div>`;
      }
      const shown = isFinite(v) ? v : k.min;
      return `<div class="f knob"><label>${k.label}</label><input type="range" data-k="${k.id}" min="${k.min}" max="${k.max}" step="${k.step}" value="${shown}">
        <output id="ko_${k.id}">${k.fmt ? k.fmt(shown) : `${shown} ${k.unit}`}</output>${hint}</div>`;
    }).join("") + `<div class="khead">What that gives you</div><div id="derived">${derived()}</div>`;
  }
  function bindTune() {
    const K = Object.fromEntries(knobs().filter(k => k.id).map(k => [k.id, k]));
    const refresh = () => { $("tune").innerHTML = tuneRows(); bindTune(); };
    $("tune").querySelectorAll("[data-k]").forEach(el => {
      const k = K[el.dataset.k];
      const apply = () => {
        let v = el.value;
        if (el.type === "number") { if (v === "") { if (!k.blank) return null; v = undefined; } else { v = +v; if (!isFinite(v)) return null; } }
        else if (k.num || el.type === "range") v = +v;
        k.set(v); rebuild(true); drawSetup(); return v;
      };
      if (el.type === "range") {
        el.addEventListener("input", () => { const v = apply(); const o = $("ko_" + k.id); if (o) o.textContent = k.fmt ? k.fmt(v) : `${v} ${k.unit}`; $("derived").innerHTML = derived(); });
        el.addEventListener("change", refresh);
      } else el.addEventListener("change", () => { if (apply() !== null || el.value === "") refresh(); });
    });
  }

  function setWheelCount(n) {
    const old = S.wheels, ys = old.map(q => Math.abs(q.y)), y = Math.max(...ys, 60), d = old[0] ? old[0].d : 50, x0 = old.reduce((a, q) => a + q.x, 0) / Math.max(old.length, 1);
    const rows = { 2: [0], 3: [-35, 35], 4: [-45, 45], 6: [-60, 0, 60] };
    if (n === 3) S.wheels = [{ x: x0 - 30, y, d, side: "L", driven: true }, { x: x0 - 30, y: -y, d, side: "R", driven: true }, { x: x0 + 60, y: 0, d: d * 0.6, side: "L", driven: false }];
    else S.wheels = [].concat(...rows[n].map(dx => [{ x: x0 + dx, y, d, side: "L", driven: true }, { x: x0 + dx, y: -y, d, side: "R", driven: true }]));
    if (n >= 4 && S.linked === undefined) S.linked = true;
    changed(false); renderSetup();
  }
  function setSkidCount(n) {
    while (S.skids.length < n) S.skids.push({ x: 80, y: 0, type: "steel" });
    S.skids.length = n; changed(false); renderSetup();
  }
  function drawSetup() {
    const v = $("view"); if (!v || !R) { if ($("sum")) $("sum").textContent = errorText; return; }
    RD.drawSetupView(v, S, R);
    let sm;
    try { sm = RB.summary(S); } catch (e) { $("sum").textContent = String(e); return; }
    const W = S.weapon || {}, over = S.mass_g > 1361 ? ` <span style="color:var(--red)">over 1361 g</span>` : "";
    $("sum").innerHTML = `weight <b>${S.mass_g} g</b>${over} · on the wheels <b>${(100 * sm.wheel_share).toFixed(1)} %</b> · yaw MOI <b>${(sm.moi * 1e9 / 1e6).toFixed(2)}e6 g mm²</b>${S.moi_auto ? " (estimated)" : ""}<br>` +
      `top speed (no load) <b>${sm.top_speed.toFixed(2)} m/s</b> (${(sm.top_speed * 2.237).toFixed(1)} mph) · pack <b>${(R.battery.V).toFixed(1)} V</b>` +
      (sm.weapon_I ? `<br>weapon MOI <b>${sm.weapon_I.toExponential(2)} kg m²</b> · free speed <b>${sm.weapon_rpm_free.toFixed(0)} rpm</b>${W.rpm_cap ? ` (cap ${W.rpm_cap})` : ""} · <b>${(0.5 * sm.weapon_I * Math.pow(Math.min(sm.weapon_rpm_free, W.rpm_cap || 1e9) * Math.PI / 30, 2)).toFixed(0)} J</b> · tip <b>${(Math.min(sm.weapon_rpm_free, W.rpm_cap || 1e9) * Math.PI / 30 * W.d / 2000).toFixed(0)} m/s</b>` : "") +
      (sm.weapon_clear_mm !== undefined && sm.weapon_clear_mm < 10 ? `<br><span style="color:var(--${sm.weapon_clear_mm <= 0 ? "red" : "amber"})">the weapon reaches only ${sm.weapon_clear_mm.toFixed(0)} mm past the front of the body and wheels${sm.weapon_clear_mm <= 0 ? ": the chassis hits first, so it can't hit anything" : ""}. Move it forward or make it bigger.</span>` : "") +
      (sm.weapon_between_wheels_mm !== undefined && sm.weapon_clear_mm > 0 ? `<br><span style="color:var(--ink2)">the wheels reach further forward than the blade: it hits what fits between them (${sm.weapon_between_wheels_mm.toFixed(0)} mm gap)</span>` : "") +
      (errorText ? `<br><span style="color:var(--red)">${errorText}</span>` : "");
    drawCurves();
  }
  function drawCurves() {
    const cv = $("curves"); if (!cv) return;
    const ctx = cv.getContext("2d"), w = cv.width, h = cv.height, C = S.controls;
    ctx.fillStyle = "#0d1118"; ctx.fillRect(0, 0, w, h);
    const X = x => 30 + (x + 1) / 2 * (w - 60), Y = y => h / 2 - y * (h / 2 - 20);
    ctx.strokeStyle = "#1f2733"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(-1), Y(0)); ctx.lineTo(X(1), Y(0)); ctx.moveTo(X(0), Y(-1)); ctx.lineTo(X(0), Y(1)); ctx.stroke();
    ctx.strokeStyle = "#2a3342"; ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.moveTo(X(-1), Y(-1)); ctx.lineTo(X(1), Y(1)); ctx.stroke(); ctx.setLineDash([]);
    for (const [ch, col, lab] of [[C.thr, "#4ea8de", "throttle"], [C.steer, "#f2a541", "steering"]]) {
      ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.beginPath();
      for (let i = 0; i <= 200; i++) { const x = -1 + i / 100; const y = IN.curve(x, ch); i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)); }
      ctx.stroke();
      ctx.fillStyle = col; ctx.font = "22px 'IBM Plex Mono', monospace"; ctx.fillText(lab, lab === "throttle" ? X(-0.95) : X(0.35), lab === "throttle" ? 34 : h - 16);
    }
    ctx.fillStyle = "#5d6878"; ctx.font = "20px 'IBM Plex Mono', monospace"; ctx.fillText("stick →", X(0.7), Y(0) + 26); ctx.fillText("output", X(0) + 8, 28);
  }

  $("bSetup").onclick = () => { $("setup").classList.toggle("open"); if ($("setup").classList.contains("open")) renderSetup(); };
  $("bClose").onclick = () => $("setup").classList.remove("open");
  $("advChk").onchange = e => { document.body.classList.toggle("advanced", e.target.checked); store.set("rds.adv", e.target.checked); };
  if (store.get("rds.adv", false)) { $("advChk").checked = true; document.body.classList.add("advanced"); }
  $("bSave").onclick = () => {
    const n = (S.name || "My robot").trim(); S.name = n;
    mine[n] = clone(S); store.set("rds.robots", mine); store.set("rds.last", n); fillRobotSel();
    flash(`Saved "${n}" in this browser`);
  };
  $("bExport").onclick = () => {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = (S.name || "robot").replace(/[^\w-]+/g, "_") + ".robot.json"; a.click();
  };
  $("bImport").onclick = () => $("fileIn").click();
  $("fileIn").onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then(t => { try { S = JSON.parse(t); if (!S.controls) S.controls = clone(IN.DEFAULT_CONTROLS); rebuild(); renderSetup(); flash(`Opened "${S.name}"`); } catch (err) { flash("Not a robot file: " + err.message); } });
  };

  // ------------------------------------------------------------------ top bar
  $("bReset").onclick = () => doReset();
  $("bPause").onclick = () => togglePause();
  $("bMouse").onclick = () => input.toggleMouse();
  $("bTarget").onclick = () => { env.target = !env.target; store.set("rds.env", env); rebuild(true); syncButtons(); };
  $("bFollow").onclick = () => { if (!view) return; view.mode = CAMS[(CAMS.indexOf(view.mode) + 1) % CAMS.length]; syncButtons(); };
  $("speedSel").onchange = e => { timeScale = +e.target.value; };
  $("bHelp").onclick = () => $("help").classList.toggle("open");
  $("help").onclick = e => { if (e.target.id === "help") $("help").classList.remove("open"); };
  $("bCsv").onclick = () => {
    const head = "t_s,x_m,y_m,z_m,heading_deg,pitch_deg,roll_deg,speed_mps,yaw_rate_dps,left_cmd,right_cmd,weapon_cmd,weapon_rpm,bus_V,battery_A,mAh_used";
    const rows = tele.map(r => r.map(v => +v.toPrecision(6)).join(","));
    const blob = new Blob([head + "\n" + rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = (S.name || "robot").replace(/[^\w-]+/g, "_") + "_drive.csv"; a.click();
  };
  function syncButtons() {
    $("bTarget").classList.toggle("on", env.target); if (view) $("bFollow").textContent = "Camera: " + view.mode;
    $("bPause").classList.toggle("on", paused); $("bPause").textContent = paused ? "Paused" : "Pause";
  }
  // Ctrl is the weapon throttle, and Ctrl+W (close tab) cannot be blocked by a page: ask before leaving instead
  window.addEventListener("beforeunload", e => { e.preventDefault(); e.returnValue = ""; });
  function doReset() { if (sim) sim.reset(); if (view) { view.camYaw = null; view.target(sim.tg); } trail = []; chart = []; tele = []; topSpeed = 0; matchT0 = 0; lastHit = null; input.weaponOn = false; input.wthr = 0; }
  function togglePause() { paused = !paused; syncButtons(); }
  let flashT = 0;
  function flash(t, sub) { const m = $("msg"); m.innerHTML = t + (sub ? `<small>${sub}</small>` : ""); m.hidden = false; flashT = performance.now() + 2200; }
  window.addEventListener("keydown", e => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === "Escape") { $("setup").classList.remove("open"); $("help").classList.remove("open"); }
  });

  // the top bar never keeps the keyboard: Space and the arrows always drive (not re-press a button or a menu)
  document.querySelectorAll("#top button, #top select").forEach(el => {
    el.addEventListener("click", () => { if (el.tagName === "BUTTON") el.blur(); });
    el.addEventListener("change", () => el.blur());
  });
  // ------------------------------------------------------------------ analog keyboard / controller map
  const srcText = src => !src ? "not set" : src.b !== undefined ? `button ${src.b} (${src.rest} → ${src.full})` : `axis ${src.a} (${src.rest} → ${src.full})`;
  function renderPad() {
    const B = $("padBody"); if (!B) return;
    const gp = input.connectedPad(), tank = S.controls.mix === "tank";
    const rows = IN.PAD_CHANNELS.filter(([ch]) => tank || !ch.startsWith("tank"));    // tank: its own side channels too
    const chOpts = Array.from({ length: 8 }, (_, i) => `<option value="${i + 1}">CH${i + 1}</option>`).join("");
    B.innerHTML = `
      <div class="hint" style="margin-bottom:6px">${gp ? `Seen: <b>${gp.id.replace(/</g, "&lt;").slice(0, 70)}</b>` :
        "<b>No controller seen.</b> Turn on your keyboard's gamepad mode (Wootility: Xbox controller or classic controller; Razer Synapse: analog / gamepad keys; Keychron Launcher: gamepad), then press any key."}<br>
        Browsers cannot read how far a key is pressed directly; in gamepad mode the keyboard shows up as a controller, and that they can read.
        Press <b>Learn</b>, then press that key all the way and let go.</div>
      <div class="radio" style="border:1px solid var(--line, #333);border-radius:6px;padding:8px;margin:6px 0">
        <b>RC transmitter</b> <span class="hint">(EdgeTX / OpenTX radio as a USB joystick: channel N is axis N-1)</span>
        <div class="f"><label>Drive</label><select id="rdMode">
          <option value="arcade">steering + throttle channels, mixed in the sim</option>
          <option value="tank">left + right channels, already mixed on the radio</option></select></div>
        <div class="f"><label id="rdALab">Steering channel</label><select id="rdA">${chOpts}</select> <label><input type="checkbox" id="rdArev"> reversed</label></div>
        <div class="f"><label id="rdBLab">Throttle channel</label><select id="rdB">${chOpts}</select> <label><input type="checkbox" id="rdBrev"> reversed</label></div>
        <div class="f"><label>Weapon channel</label><select id="rdW"><option value="0">none</option>${chOpts}</select> <label><input type="checkbox" id="rdWrev"> reversed</label>
          <div class="hint">-100 % is off, +100 % is full (a switch or the throttle stick)</div></div>
        <div class="f"><button id="rdUse" class="prim"${gp ? "" : " disabled"}>Use the radio</button></div>
      </div>
      <div class="hint" id="padLive" style="font-family:var(--mono);font-size:11px;margin:4px 0 8px"></div>
      <table class="t" id="padTbl"><tr><th>Control</th><th>Mapped to</th><th style="width:120px">Now</th><th></th></tr>
      ${rows.map(([ch, lab]) => `<tr><td>${lab}</td><td style="font-family:var(--mono);font-size:11px" id="padSrc_${ch}">${input.learning && input.learning.ch === ch ? "press it fully, then let go…" : srcText(input.padmap && input.padmap[ch])}</td>
        <td><div style="height:8px;background:var(--panel3);border-radius:4px;overflow:hidden"><div id="padBar_${ch}" style="height:100%;width:0;background:var(--blue)"></div></div></td>
        <td><button data-learn="${ch}"${gp ? "" : " disabled"}>Learn</button> <button data-unmap="${ch}" title="Forget this one">×</button></td></tr>`).join("")}</table>
      <div class="f"><label>Ignore this keyboard's ordinary key presses while the map is in use</label><input type="checkbox" id="padKeysOff"${input.padKeysOff ? " checked" : ""}>
        <div class="hint">analog boards send both: without this, W reads full the moment the key actuates and the analog depth is lost</div></div>
      <div class="f"><button id="padClear">Clear the map (standard controller layout)</button></div>`;
    B.querySelectorAll("[data-learn]").forEach(b => b.onclick = () => { if (input.learn(b.dataset.learn)) renderPad(); b.blur(); });
    B.querySelectorAll("[data-unmap]").forEach(b => b.onclick = () => { if (input.padmap) { delete input.padmap[b.dataset.unmap]; if (!Object.keys(input.padmap).length) input.padmap = null; } savePad(); renderPad(); });
    $("padKeysOff").onchange = e => { input.padKeysOff = e.target.checked; savePad(); };
    $("padClear").onclick = () => { input.padmap = null; input.learning = null; savePad(); renderPad(); };
    // the radio: channels straight to controls, no learning
    const rc = Object.assign({ mode: "arcade", a: 1, b: 2, w: 3, arev: false, brev: false, wrev: false }, store.get("rds.radio", {}));
    const setLabels = () => { const t = $("rdMode").value === "tank"; $("rdALab").textContent = t ? "Left side channel" : "Steering channel"; $("rdBLab").textContent = t ? "Right side channel" : "Throttle channel"; };
    $("rdMode").value = rc.mode; $("rdA").value = rc.a; $("rdB").value = rc.b; $("rdW").value = rc.w;
    $("rdArev").checked = rc.arev; $("rdBrev").checked = rc.brev; $("rdWrev").checked = rc.wrev; setLabels();
    $("rdMode").onchange = setLabels;
    $("rdUse").onclick = () => {
      const r = { mode: $("rdMode").value, a: +$("rdA").value, b: +$("rdB").value, w: +$("rdW").value, arev: $("rdArev").checked, brev: $("rdBrev").checked, wrev: $("rdWrev").checked };
      store.set("rds.radio", r);
      const pos = (ch, rev) => ({ a: ch - 1, rest: 0, full: rev ? -1 : 1 }), neg = (ch, rev) => ({ a: ch - 1, rest: 0, full: rev ? 1 : -1 });
      const m = {};
      if (r.mode === "tank") { m.tankLup = pos(r.a, r.arev); m.tankLdown = neg(r.a, r.arev); m.tankRup = pos(r.b, r.brev); m.tankRdown = neg(r.b, r.brev); }
      else { m.right = pos(r.a, r.arev); m.left = neg(r.a, r.arev); m.fwd = pos(r.b, r.brev); m.back = neg(r.b, r.brev); }
      if (r.w) m.weapon = { a: r.w - 1, rest: r.wrev ? 1 : -1, full: r.wrev ? -1 : 1 };
      input.padmap = m; input.learning = null; savePad();
      S.controls.mix = r.mode; changed(); renderSetup(); if ($("padSec")) $("padSec").open = true;
      flash("Radio in use", r.mode === "tank" ? `CH${r.a} left, CH${r.b} right` + (r.w ? `, CH${r.w} weapon` : "") : `CH${r.a} steering, CH${r.b} throttle` + (r.w ? `, CH${r.w} weapon` : ""));
    };
  }
  let padSeen = null;
  function padTick() {
    if (input.learning) { const src = input.learnStep(); if (src) { savePad(); renderPad(); } }
    const gp = input.connectedPad(), id = gp ? gp.id : null;
    if (id !== padSeen) { padSeen = id; renderPad(); }
    if (!$("padTbl") || !$("padSec").open) return;
    const lv = $("padLive");                          // what the sim hears, live: to see why a key does nothing
    if (lv) {
      const ax = gp ? Array.from(gp.axes).map((v, i) => `${i} (CH${i + 1}) ${(v * 100).toFixed(0)}%`).join("  ") : "-";
      const bt = gp ? gp.buttons.map((b, i) => (b.value || (b.pressed ? 1 : 0)) > 0.02 ? `${i}:${(b.value || 1).toFixed(2)}` : null).filter(Boolean).join("  ") || "none" : "-";
      const rw = input.lastRaw || {};
      lv.innerHTML = `controller axes ${ax}<br>buttons pressed ${bt}<br>keys held ${[...input.down].join(" ") || "none"}<br>` +
        (S.controls.mix === "tank" ? `sim hears: left ${(rw.tL || 0).toFixed(2)}, right ${(rw.tR || 0).toFixed(2)} (mix: tank)` : `sim hears: throttle ${(rw.thr || 0).toFixed(2)}, steering ${(rw.steer || 0).toFixed(2)} (mix: ${S.controls.mix})`);
    }
    const v = input.padValues();
    for (const ch in v) { const el = $("padBar_" + ch); if (el) el.style.width = ((v[ch] || 0) * 100).toFixed(0) + "%"; }
  }

  // ------------------------------------------------------------------ the loop
  const cv = $("cv"), ccv = $("chartCv"), cctx = ccv.getContext("2d");
  try { view = new window.RDS.View(cv); view.onMode = () => syncButtons(); } catch (e) { console.error(e); }
  function resize() {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (view) view.resize(r.width, r.height);
    const c2 = ccv.getBoundingClientRect(); ccv.width = Math.round(c2.width * dpr); ccv.height = Math.round(c2.height * dpr); cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);


  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    for (const ev of input.takeEvents()) {
      if (ev === "KeyR" || ev === "PadReset") doReset();
      else if (ev === "KeyP" || ev === "PadPause") togglePause();
      else if (ev === "KeyT") $("bTarget").click();
      else if (ev === "KeyM") input.toggleMouse();
      else if (ev === "KeyC") $("bFollow").click();
      else if (ev === "KeyH") $("bHelp").click();
      else if (ev === "BracketLeft" || ev === "BracketRight") {
        const L = [0.1, 0.25, 0.5, 1], i = L.indexOf(timeScale), j = Math.max(0, Math.min(3, i + (ev === "BracketRight" ? 1 : -1)));
        timeScale = L[j]; $("speedSel").value = String(timeScale);
      }
    }
    padTick();
    let u = input.read(dt);
    const ml = input.mouseLocked();                     // the mouse stick, shown while it drives
    $("mstick").hidden = !ml; $("bMouse").classList.toggle("on", ml);
    if (ml) { const d = $("mdot"); d.setAttribute("cx", input.mx.toFixed(3)); d.setAttribute("cy", (-input.my).toFixed(3)); }
    if (sim && S.controls.auto_invert !== false && sim.state.upsideDown) u = { L: -u.R, R: -u.L, W: u.W, raw: u.raw };
    $("padInfo").textContent = input.pad ? (input.padmap ? "mapped: " : "controller: ") + input.pad.slice(0, 34) : "no controller (keyboard)";
    if (sim && !paused) {
      if (!matchT0 && (Math.abs(u.L) + Math.abs(u.R) + u.W) > 0.01) matchT0 = sim.t || 1e-9;
      carry += dt * timeScale;
      const h = sim.opts.h; let n = Math.floor(carry / h); carry -= n * h; n = Math.min(n, 2500);
      const t0 = performance.now(); simDt = 0;
      for (let i = 0; i < n; i++) {
        simDt += h;
        sim.step(u);
        if (i % 50 === 0 && performance.now() - t0 > 30) { carry = 0; break; }    // a slow computer: slow down, never stall
      }
      const st = sim.state;
      topSpeed = Math.max(topSpeed, st.speed);
      if (!trail.length || sim.t - trail[trail.length - 1][3] > 0.02) { trail.push([st.xcog, st.ycog, st.speed, sim.t]); if (trail.length > 600) trail.shift(); }
      while (sim.hits.length > seenHits) {
        const hh = sim.hits[seenHits++]; if (view) view.spark(hh.x, hh.y, hh.z);
        // teeth landing in quick succession are one hit: their energies add (a gap over HIT_GAP starts a new one)
        if (lastHit && hh.t >= lastHit.tEnd && hh.t - lastHit.tEnd <= HIT_GAP) { lastHit.dE += hh.dE; lastHit.J += hh.J; lastHit.n++; lastHit.tEnd = hh.t; lastHit.born = performance.now(); }
        else { lastHit = { ...hh, n: 1, tEnd: hh.t, born: performance.now() }; hitLabels.push(lastHit); }
        if (S.controls.weapon_off_after_hit !== false) input.cutWeapon();
      }
      if (sim.hits.length < seenHits) seenHits = sim.hits.length;
      if (!chart.length || sim.t - chart[chart.length - 1][0] > 0.02) {
        chart.push([sim.t, st.speed, st.ww * 30 / Math.PI, st.vbus || R.battery.V, st.Ib || 0]); if (chart.length > 400) chart.shift();
        tele.push([sim.t, st.x, st.y, st.z, st.psi * 180 / Math.PI, st.pitch * 180 / Math.PI, st.roll * 180 / Math.PI, st.vfwd, st.r * 180 / Math.PI, st.uL, st.uR, st.uW, st.ww * 30 / Math.PI, st.vbus || 0, st.Ib || 0, st.mAh]);
        if (tele.length > 3000) tele.shift();
      }
    }
    draw(u, dt);
    if (flashT && now > flashT) { $("msg").hidden = true; flashT = 0; }
  }

  let simDt = 0, seenHits = 0, lastHit = null; const hitLabels = [];
  const HIT_GAP = 0.05;                               // s between teeth that still counts as the same hit
  function draw(u, dt) {
    if (!sim || !view) return;
    const st = sim.state;
    view.update(st, R, paused ? 0 : simDt, dt || 0.016); simDt = 0;
    view.target(sim.tg); view.path(trail, Math.max(topSpeed, 1));
    view.render();
    // hit labels in the view
    const box = cv.getBoundingClientRect(), now = performance.now();
    const lay = $("labels"); let html = "";
    for (const L of hitLabels) {
      const age = (now - L.born) / 1000; if (age > 1.6) continue;
      const [x, y, ok] = view.project(L.x, L.y, L.z + 0.05 + 0.06 * age, box.width, box.height);
      if (ok) html += `<div class="hitl" style="left:${x}px;top:${y}px;opacity:${1 - age / 1.6}">${L.dE.toFixed(0)} J${L.n > 1 ? ` <small>(${L.n} teeth)</small>` : ""}</div>`;
    }
    while (hitLabels.length && (now - hitLabels[0].born) > 1600) hitLabels.shift();
    lay.innerHTML = html;
    hud(st, u); bars(st); drawChart(); keysHelp();
  }

  function hud(st, u) {
    const W = sim.c.weapon, rpm = st.ww * 30 / Math.PI, E = W ? 0.5 * W.I * st.ww * st.ww : 0;
    const left = matchT0 ? Math.max(0, 180 - (sim.t - matchT0)) : 180, mm = Math.floor(left / 60), ss = Math.floor(left % 60);
    const cap = R.battery.mAh, used = st.mAh;
    const lifted = (st.wheels || []).map((w, i) => w.N <= 0 ? "wheel " + (i + 1) : null).filter(Boolean);
    const tilt = `pitch ${(st.pitch * 57.3).toFixed(0)}° · roll ${(st.roll * 57.3).toFixed(0)}°`;
    $("hud").innerHTML = `<div class="row"><span class="t">${mm}:${String(ss).padStart(2, "0")}</span><span class="k">${S.name}</span></div>
      <div class="row"><span class="big">${Math.abs(st.vfwd).toFixed(2)}</span><span class="k">m/s ${st.vfwd < -0.05 ? "back" : ""} · ${(Math.abs(st.vfwd) * 2.237).toFixed(1)} mph</span></div>
      <div class="row"><span class="k">turn rate</span><span>${(st.r * 180 / Math.PI).toFixed(0)} °/s</span></div>
      <div class="row"><span class="k">top speed</span><span>${topSpeed.toFixed(2)} m/s</span></div>
      <div class="row"><span class="k">tilt</span><span style="color:${Math.abs(st.pitch) > 0.17 || Math.abs(st.roll) > 0.17 ? "var(--amber)" : "inherit"}">${tilt}</span></div>
      ${st.upsideDown ? `<div class="row" style="color:var(--amber)"><span>UPSIDE DOWN</span><span>${S.controls.auto_invert !== false ? "controls inverted" : ""}</span></div>` : ""}
      ${st.z > 0.03 ? `<div class="row" style="color:var(--amber)"><span>in the air</span><span>${(st.zcog * 1000).toFixed(0)} mm</span></div>` : ""}
      ${W ? `<hr><div class="row"><span class="k">weapon</span><span style="color:${rpm > 100 ? "var(--red)" : "inherit"}">${rpm.toFixed(0)} rpm</span></div>
      <div class="row"><span class="k">stored</span><span>${E.toFixed(0)} J · tip ${(st.ww * W.radius).toFixed(0)} m/s</span></div>` : ""}
      <hr><div class="row"><span class="k">pack</span><span>${(st.vbus || R.battery.V).toFixed(1)} V · ${(st.Ib || 0).toFixed(1)} A</span></div>
      <div class="row"><span class="k">used</span><span>${used.toFixed(0)} of ${cap} mAh</span></div>
      ${lifted.length ? `<div class="row" style="color:var(--amber)"><span>off the floor</span><span>${lifted.join(", ")}</span></div>` : ""}
      ${lastHit ? `<div class="row"><span class="k">last hit</span><span>${lastHit.dE.toFixed(0)} J${lastHit.n > 1 ? ` · ${lastHit.n} teeth` : ""}</span></div>` : ""}
      ${paused ? `<div class="row" style="color:var(--amber)"><span>PAUSED</span><span>P to go</span></div>` : ""}
      ${timeScale !== 1 ? `<div class="row" style="color:var(--blue)"><span>slow motion</span><span>${timeScale}x</span></div>` : ""}`;
  }
  function bars(st) {
    const b = (v, lab, cls) => {
      const p = Math.max(-1, Math.min(1, v));
      const st2 = cls ? `height:${p * 100}%` : (p >= 0 ? `bottom:50%;height:${p * 50}%` : `top:50%;height:${-p * 50}%`);
      return `<div><div class="bar ${cls || ""}"><i style="${st2}"></i></div><div class="barl">${lab}</div></div>`;
    };
    $("bars").innerHTML = b(st.uL, "L") + b(st.uR, "R") + (sim.c.weapon ? b(st.uW, "W", "w") : "");
  }
  function drawChart() {
    const r = ccv.getBoundingClientRect(), w = r.width, h = r.height;
    cctx.clearRect(0, 0, w, h);
    if (chart.length < 2) return;
    const t0 = chart[0][0], t1 = chart[chart.length - 1][0], span = Math.max(t1 - t0, 1);
    const X = t => 50 + (t - t0) / span * (w - 60);
    const series = [[1, "#4ea8de", "speed m/s", Math.max(topSpeed, 1)], [2, "#e5383b", "weapon rpm", Math.max(...chart.map(c => c[2]), 1000)],
                    [4, "#f2a541", "pack A", Math.max(...chart.map(c => c[4]), 10)]];
    cctx.font = "11px 'IBM Plex Mono', monospace";
    series.forEach(([i, col, lab, top], k) => {
      cctx.strokeStyle = col; cctx.lineWidth = 1.6; cctx.beginPath();
      chart.forEach((c, j) => { const y = h - 14 - (c[i] / top) * (h - 28); j ? cctx.lineTo(X(c[0]), y) : cctx.moveTo(X(c[0]), y); });
      cctx.stroke();
      cctx.fillStyle = col; cctx.fillText(`${lab} ${chart[chart.length - 1][i].toFixed(i === 2 ? 0 : 1)}`, 52 + k * 150, 14);
    });
    cctx.fillStyle = "#5d6878"; cctx.fillText(`last ${span.toFixed(0)} s`, w - 80, h - 4);
  }
  let keysMix = "";
  function keysHelp() {
    const C = S.controls; if (keysMix === C.mix + C.weapon_mode + C.weapon_off_after_hit) return; keysMix = C.mix + C.weapon_mode + C.weapon_off_after_hit;
    const drive = C.mix === "tank" ? `<b>W / S</b> left side<br><b>↑ / ↓</b> right side` : `<b>W / S ↑ ↓</b> throttle<br><b>A / D ← →</b> steer`;
    $("keys").innerHTML = `${drive}<br><b>Shift / Ctrl</b> weapon throttle up / down<br><b>Space</b> weapon ${C.weapon_mode === "toggle" ? "on / off" : "(hold)"}${C.weapon_off_after_hit !== false ? " (lets go after a hit)" : ""} · <b>Q</b> precision<br><b>R</b> reset · <b>P</b> pause<br><b>T</b> target · <b>C</b> camera<br><b>M</b> mouse as a joystick (Esc lets go)<br><b>drag</b> orbit · <b>wheel</b> zoom<br><b>[ ]</b> slow motion · <b>H</b> help`;
  }

  $("helpBox").innerHTML = `<h2 style="margin-top:0">RoborDriveSim</h2>
    <p>Drive your combat robot with its real weight, COG, wheels and weapon. Set it up under <b>Setup</b> (or start from an archetype), then drive with the keyboard or a game controller.</p>
    <h3>Mouse as a joystick</h3><p>Press <kbd>M</kbd> (or <b>Mouse</b>): the mouse is captured and moves a stick, shown bottom left. Up / down is throttle, left / right steering; it stays where you leave it (Setup → Driving curves can make it spring back). Right click centres it, the wheel is the weapon throttle (10 % a notch), left click switches the weapon on / off. <kbd>Esc</kbd> lets the mouse go. Keys still work and win while held.</p>
    <h3>Keyboard</h3><p><kbd>W</kbd><kbd>S</kbd> or <kbd>↑</kbd><kbd>↓</kbd> throttle, <kbd>A</kbd><kbd>D</kbd> or <kbd>←</kbd><kbd>→</kbd> steer (tank mix: <kbd>W</kbd><kbd>S</kbd> left side, <kbd>↑</kbd><kbd>↓</kbd> right side). <kbd>Shift</kbd> / <kbd>Ctrl</kbd> held: weapon throttle up / down (it stays where you let go). <kbd>Space</kbd> weapon full on / off (off also zeroes the throttle). <kbd>Q</kbd> precision. Ctrl+W would close the tab, so the page asks before leaving. <kbd>R</kbd> reset, <kbd>P</kbd> pause, <kbd>T</kbd> target box, <kbd>C</kbd> camera (chase, top, whole arena, orbit; drag to orbit, wheel to zoom), <kbd>[</kbd><kbd>]</kbd> slow motion, <kbd>Esc</kbd> closes panels.</p>
    <h3>Game controller</h3><p>Plug it in and press a button (Chrome or Edge). Arcade: left stick up/down throttle, right stick left/right steering. Single: the left stick does both. Tank: one stick per side. Right trigger: weapon throttle. A / Cross: weapon on or off. B / Circle: reset. Start: pause.</p>
    <h3>Analog keyboard</h3><p>Wooting, Razer Huntsman V3 Pro, Keychron HE and similar: turn on the keyboard's gamepad mode in its own app (Wootility, Synapse, Launcher), then in <b>Setup → Analog keyboard / controller map</b> press <b>Learn</b> beside each control and press that key all the way. How far you press is how much throttle or steering you get. Keep "ignore ordinary key presses" on, so the key's digital press does not override its depth.</p>
    <h3>What it simulates</h3><ul>
      <li>Each wheel's grip from the load on it: a tire curve that rises, peaks and slides; weight shifts back when it speeds up, forward when it brakes and outward in a turn (from COG height).</li>
      <li>Motors with back-EMF, resistance and the ESC's current limit, drag brake or coast, gearbox losses, all on one battery: spinning the weapon up sags the drive.</li>
      <li>The weapon spins up on its own motor and its angular momentum rides in the chassis: spin-up twists the robot the other way about the weapon's axis, and turning a robot with a spinning vertical disc or drum tilts it up (gyro), in full 3D: it can tip, wheelie, flip and land.</li>
      <li>Skids slide with their own friction. Walls and the target box are hit with friction; a weapon tooth hitting the target throws it by the blade's inertia and slows the blade.</li></ul>
    <p>It is the Flapjack drive model from REDblocks made general: that model matched a full 3D simulation within about 4 % (launch, turns, braking, battery use). Tests: <code>node tests/run_tests.js</code>.</p>
    <h3>Limits</h3><ul><li>A flat, rigid floor and walls; contacts are springs and dampers (tires 20 kN/m, metal 200 kN/m), and a hit is an impulse at one tooth, not a deformation.</li>
      <li>Values marked "estimate" in the menus are typical numbers, not measurements: replace them with yours.</li></ul>`;

  // ------------------------------------------------------------------ go
  fillRobotSel(); rebuild(); resize(); syncButtons(); requestAnimationFrame(frame);
  if (!store.get("rds.seen", false)) { store.set("rds.seen", true); flash("Drive with W A S D, Space spins the weapon", "Setup (top left) sets your robot · H for help"); }
  window.RDS.app = { get sim() { return sim; }, get S() { return S; }, get R() { return R; }, renderSetup, rebuild, input };
})();

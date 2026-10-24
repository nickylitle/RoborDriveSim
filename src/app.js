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
  const env = Object.assign({ arena: "nhrl3", target: false, tmass_g: 1361, tsize: 120, theight: 60, tmu: 0.3 }, store.get("rds.env", {}));
  let R = null, sim = null, paused = false, timeScale = 1, carry = 0, last = 0;
  const CAMS = ["chase", "top", "arena", "orbit"];
  let trail = [], chart = [], tele = [], topSpeed = 0, matchT0 = 0, errorText = "";
  const input = new IN.Input(window);

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
    S = clone(v.startsWith("m:") ? mine[v.slice(2)] : RB.PRESETS[v.slice(2)]);
    if (!S.controls) S.controls = clone(IN.DEFAULT_CONTROLS);
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
    return `<div class="f${o.adv ? " adv" : ""}"><label>${label}</label><input type="checkbox" data-p="${path}"${get(S, path) ? " checked" : ""}>${o.hint ? `<div class="hint">${o.hint}</div>` : ""}</div>`;
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
    return `<table class="t"><tr><th>#</th><th>x mm</th><th>y mm</th><th title="how far above the floor it sits at rest: 0 touches; a little lets the wheels carry the robot">gap mm</th><th>material</th></tr>` +
      S.skids.map((q, i) => `<tr><td>${i + 1}</td><td><input type="number" data-p="skids.${i}.x" value="${q.x}"></td><td><input type="number" data-p="skids.${i}.y" value="${q.y}"></td>
        <td><input type="number" data-p="skids.${i}.gap" value="${q.gap || 0}" style="width:50px"></td>
        <td><select data-p="skids.${i}.type">${opts(RB.SKIDS).map(([k, l]) => `<option value="${k}"${k === q.type ? " selected" : ""}>${l}</option>`).join("")}</select></td></tr>`).join("") + `</table>`;
  }
  function dirOpts(type) {
    return type === "horizontal" ? [[1, "counter-clockwise from above"], [-1, "clockwise from above"]] : [[1, "front of the weapon moves up (hits upward)"], [-1, "front moves down (hits downward)"]];
  }

  function renderSetup() {
    const W = S.weapon || { type: "none" }, C = S.controls, hasW = W.type && W.type !== "none";
    const TI = RB.TIRES[S.tire] || RB.TIRES.urethane, DM = RB.DRIVE_MOTORS[S.drive.motor] || RB.DRIVE_MOTORS.compact1806;
    const WM = RB.WEAPON_MOTORS[W.motor] || RB.WEAPON_MOTORS.m2807_1350;
    $("sbody").innerHTML = `
      <canvas id="view" width="1040" height="600"></canvas>
      <div class="out" id="sum"></div>
      <div class="f"><label>Name</label><input type="text" data-p="name" data-t="str" value="${S.name}" style="flex:1"></div>
      <div class="note">${S.note || ""} Measure every position in mm from one point on the robot (the drive axle centre is handy): x forward, y left.</div>
      <details open><summary>Robot <span class="q">how heavy, where is the COG, what is its MOI</span></summary><div class="sec">
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
      <details open><summary>Wheels <span class="q">how many, where, how big, what tire</span></summary><div class="sec">
        ${fSel("Number of wheels", "_nwheels", [[2, "2"], [3, "3"], [4, "4"], [6, "6"]], { type: "num" })}
        ${wheelRows()}
        ${fChk("Wheels on each side linked (chain / belt)", "linked", { hint: "linked: each side's wheels turn together on that side's motors; not linked: every driven wheel has its own motor" })}
        ${S.linked ? fNum("Motors per side", "motors_per_side", "", { step: 1, min: 1 }) : ""}
        ${fSel("Tire", "tire", opts(RB.TIRES))}
        ${fNum("Grip sliding (μ)", "tire_adv.muk", "", { adv: true, hint: "blank = the tire's value (shown greyed)", ph: TI.muk })}${fNum("Grip peak (μ)", "tire_adv.mus", "", { adv: true, ph: TI.mus })}
        ${fNum("Slip ratio at the peak", "tire_adv.sigp", "", { adv: true, ph: TI.sigp })}${fNum("Rolling resistance (Crr)", "tire_adv.crr", "", { adv: true, ph: TI.crr })}
      </div></details>
      <details open><summary>Skids <span class="q">anything else touching the floor</span></summary><div class="sec">
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
      <details open><summary>Weapon <span class="q">how big, how heavy, where, which way</span></summary><div class="sec">
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
        ${fNum("Speed cap", "weapon.rpm_cap", "rpm", { hint: "0 = none; a governor or the throttle you run it at" })}
        ${fNum("Weapon MOI (overrides the shape)", "weapon.I_override", "kg m²", { adv: true, hint: "blank = from the shape, mass and diameter", ph: hasW ? RB.weaponI(Object.assign({}, W, { I_override: 0 })) : 0 })}
        ${fNum("Weapon motor kv", "weapon.adv.kv", "rpm/V", { adv: true, ph: WM.kv })}${fNum("Weapon motor resistance", "weapon.adv.R", "Ω", { adv: true, ph: WM.R })}
        ${fNum("Hit restitution", "weapon.adv.bite_e", "", { adv: true, hint: "0 to 1: how much a tooth bounces off rather than bites", ph: 0.3 })}
        ` : ""}
      </div></details>
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
        ${fNum("Precision (Q held)", "controls.precision", "%")}
        ${fNum("Weapon throttle on Shift / Ctrl: 0 to full in", "controls.weapon_key_ramp", "s", { ph: 1, hint: "hold Shift to spin up, Ctrl to spin down; it stays where you let go. Space switches it off." })}
        ${fSel("Weapon button", "controls.weapon_mode", [["toggle", "Toggle on / off"], ["hold", "Hold to spin"]])}
        ${fNum("Weapon throttle when on", "controls.weapon_level", "%")}
      </div></details>
      <details><summary>Arena and target <span class="q">where it drives</span></summary><div class="sec">
        <div class="f"><label>Arena</label><select id="arenaSel">${opts(RB.ARENAS).map(([k, l]) => `<option value="${k}"${k === env.arena ? " selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="f"><label>Target box mass</label><input type="number" id="tMass" value="${env.tmass_g}"><span class="u">g</span></div>
        <div class="f"><label>Target box size (square)</label><input type="number" id="tSize" value="${env.tsize}"><span class="u">mm</span></div>
        <div class="f"><label>Target box height</label><input type="number" id="tHeight" value="${env.theight || 60}"><span class="u">mm</span></div>
        <div class="f"><label>Target floor friction</label><input type="number" id="tMu" value="${env.tmu}"><span class="u">μ</span></div>
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
    const nw = $("sbody").querySelector('[data-p="_nwheels"]'); if (nw) nw.value = String(S.wheels.length);
    const ns = $("sbody").querySelector('[data-p="_nskids"]'); if (ns) ns.value = String(S.skids.length);
    drawSetup();
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
  function doReset() { if (sim) sim.reset(); if (view) { view.camYaw = null; view.target(sim.tg); } trail = []; chart = []; tele = []; topSpeed = 0; matchT0 = 0; input.weaponOn = false; input.wthr = 0; }
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
      else if (ev === "KeyC") $("bFollow").click();
      else if (ev === "KeyH") $("bHelp").click();
      else if (ev === "BracketLeft" || ev === "BracketRight") {
        const L = [0.1, 0.25, 0.5, 1], i = L.indexOf(timeScale), j = Math.max(0, Math.min(3, i + (ev === "BracketRight" ? 1 : -1)));
        timeScale = L[j]; $("speedSel").value = String(timeScale);
      }
    }
    let u = input.read(dt);
    if (sim && S.controls.auto_invert !== false && sim.state.upsideDown) u = { L: -u.R, R: -u.L, W: u.W, raw: u.raw };
    $("padInfo").textContent = input.pad ? "controller: " + input.pad.slice(0, 34) : "no controller (keyboard)";
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
      while (sim.hits.length > seenHits) { const hh = sim.hits[seenHits++]; if (view) view.spark(hh.x, hh.y, hh.z); hitLabels.push({ ...hh, born: performance.now() }); }
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

  let simDt = 0, seenHits = 0; const hitLabels = [];
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
      if (ok) html += `<div class="hitl" style="left:${x}px;top:${y}px;opacity:${1 - age / 1.6}">${L.dE.toFixed(0)} J</div>`;
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
      ${sim.hits.length ? `<div class="row"><span class="k">last hit</span><span>${sim.hits[sim.hits.length - 1].dE.toFixed(0)} J</span></div>` : ""}
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
    const C = S.controls; if (keysMix === C.mix + C.weapon_mode) return; keysMix = C.mix + C.weapon_mode;
    const drive = C.mix === "tank" ? `<b>W / S</b> left side<br><b>↑ / ↓</b> right side` : `<b>W / S ↑ ↓</b> throttle<br><b>A / D ← →</b> steer`;
    $("keys").innerHTML = `${drive}<br><b>Shift / Ctrl</b> weapon throttle up / down<br><b>Space</b> weapon ${C.weapon_mode === "toggle" ? "on / off" : "(hold)"} · <b>Q</b> precision<br><b>R</b> reset · <b>P</b> pause<br><b>T</b> target · <b>C</b> camera<br><b>drag</b> orbit · <b>wheel</b> zoom<br><b>[ ]</b> slow motion · <b>H</b> help`;
  }

  $("helpBox").innerHTML = `<h2 style="margin-top:0">RoborDriveSim</h2>
    <p>Drive your combat robot with its real weight, COG, wheels and weapon. Set it up under <b>Setup</b> (or start from an archetype), then drive with the keyboard or a game controller.</p>
    <h3>Keyboard</h3><p><kbd>W</kbd><kbd>S</kbd> or <kbd>↑</kbd><kbd>↓</kbd> throttle, <kbd>A</kbd><kbd>D</kbd> or <kbd>←</kbd><kbd>→</kbd> steer (tank mix: <kbd>W</kbd><kbd>S</kbd> left side, <kbd>↑</kbd><kbd>↓</kbd> right side). <kbd>Shift</kbd> / <kbd>Ctrl</kbd> held: weapon throttle up / down (it stays where you let go). <kbd>Space</kbd> weapon full on / off (off also zeroes the throttle). <kbd>Q</kbd> precision. Ctrl+W would close the tab, so the page asks before leaving. <kbd>R</kbd> reset, <kbd>P</kbd> pause, <kbd>T</kbd> target box, <kbd>C</kbd> camera (chase, top, whole arena, orbit; drag to orbit, wheel to zoom), <kbd>[</kbd><kbd>]</kbd> slow motion, <kbd>Esc</kbd> closes panels.</p>
    <h3>Game controller</h3><p>Plug it in and press a button (Chrome or Edge). Arcade: left stick up/down throttle, right stick left/right steering. Single: the left stick does both. Tank: one stick per side. Right trigger: weapon throttle. A / Cross: weapon on or off. B / Circle: reset. Start: pause.</p>
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

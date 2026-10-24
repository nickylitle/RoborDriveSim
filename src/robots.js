/* RoborDriveSim robots: the setup a person fills in (mm, g, plain questions), the archetype presets, the part
 * catalogs (tires, skids, motors), and build(): the setup turned into the SI robot the physics runs.
 *
 * Coordinates: measure from any point on the robot you like (the drive axle centre is handy). x is forward, y is
 * left, z is up. Every position in a setup is from that same point.
 *
 * MEASURED values (Nicky's Flapjack tests) are marked; everything else is an estimate to replace with your own.
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ catalogs
  const TIRES = {
    urethane:  { label: "Urethane 20-30A on painted wood (measured, Flapjack)", muk: 1.67, mus: 2.0, sigp: 0.12, crr: 0.02 },
    silicone:  { label: "Silicone 15-20A (estimate)", muk: 1.3, mus: 1.5, sigp: 0.12, crr: 0.02 },
    foam:      { label: "Foam (estimate)", muk: 1.0, mus: 1.1, sigp: 0.15, crr: 0.03 },
    tpu:       { label: "Printed TPU, no tread (estimate)", muk: 0.8, mus: 0.9, sigp: 0.10, crr: 0.015 },
    rubber:    { label: "Hard rubber / O-ring (estimate)", muk: 0.9, mus: 1.0, sigp: 0.10, crr: 0.015 },
  };
  const SKIDS = {
    steel:  { label: "Steel (bolt head, wedge edge): measured 0.203 on painted wood", muk: 0.203, mus: 0.25 },
    ti:     { label: "Titanium (estimate)", muk: 0.25, mus: 0.30 },
    uhmw:   { label: "UHMW (estimate)", muk: 0.22, mus: 0.27 },
    ptfe:   { label: "PTFE / MoS2 coat (estimate)", muk: 0.12, mus: 0.15 },
    tpu:    { label: "TPU / plastic (estimate)", muk: 0.5, mus: 0.6 },
    caster: { label: "Ball caster (estimate)", muk: 0.03, mus: 0.04 },
  };
  // drive motors: kv (rpm/V), R (ohm), G (gearbox), eta, Jrot (rotor, kg m^2)
  const DRIVE_MOTORS = {
    compact1806: { label: "Repeat Compact 1806 2300 KV, 22.6:1 (Flapjack's; R and rotor estimated)", kv: 2300, R: 0.15, G: 22.6, eta: 0.82, Jrot: 8e-7 },
    bl1806_14:   { label: "1806-class brushless, 14:1 (estimate)", kv: 2300, R: 0.15, G: 14, eta: 0.82, Jrot: 8e-7 },
    bl2204_27:   { label: "2204-class brushless, 27:1 (estimate)", kv: 1400, R: 0.12, G: 27, eta: 0.80, Jrot: 1.5e-6 },
    brushed16:   { label: "16 mm brushed gearmotor, 22:1 (estimate)", kv: 1650, R: 2.8, G: 22, eta: 0.70, Jrot: 3e-7 },
  };
  // weapon motors
  const WEAPON_MOTORS = {
    m2807_1350: { label: "2807 1350 KV (Flapjack's; R estimated)", kv: 1350, R: 0.055 },
    m2207_1950: { label: "2207 1950 KV (estimate)", kv: 1950, R: 0.065 },
    m2306_2450: { label: "2306 2450 KV (estimate)", kv: 2450, R: 0.06 },
    m3536_1000: { label: "3536 1000 KV (estimate)", kv: 1000, R: 0.03 },
    m4250_600:  { label: "4250 600 KV (estimate, heavier bots)", kv: 600, R: 0.02 },
  };
  // weapon shapes: I = k m r^2 about the spin axis (r = half the diameter)
  const SHAPES = {
    bar:   { label: "Bar / blade", k: 1 / 3 },
    disc:  { label: "Disc / egg-beater (solid)", k: 0.5 },
    ring:  { label: "Ring / shell (mass at the rim)", k: 0.85 },
    drum:  { label: "Drum (solid)", k: 0.5 },
    tube:  { label: "Drum (tube)", k: 0.8 },
  };
  const ARENAS = {
    nhrl3: { label: "NHRL 3 lb cage, 8 ft x 8 ft (NHRL wiki: inside or outside size not stated)", size: 2.4384 },
    ft12:  { label: "12 ft x 12 ft", size: 3.6576 },
    ft16:  { label: "16 ft x 16 ft", size: 4.8768 },
    open:  { label: "No walls", size: 0 },
  };

  // ------------------------------------------------------------------ archetype presets (adjust every value)
  const w = (x, y, d, side, driven = true) => ({ x, y, d, side, driven });
  const PRESETS = {
    flapjack: {
      name: "Flapjack", archetype: "Horizontal undercutter, 2WD rear drive + front skid",
      note: "Nicky's beetle. Weight, COG split, track, axle-to-skid, wheel size, tire and skid grip MEASURED; MOI from the component build-up.",
      mass_g: 1361, cog: { x: 65, y: 0, h: 23 }, moi_gmm2: 5288000, moi_auto: false,
      body: { pts: [[-45, 60], [-45, -60], [70, -60], [125, 0], [70, 60]] },
      wheels: [w(0, 90, 44, "L"), w(0, -90, 44, "R")], linked: false, motors_per_side: 1,
      tire: "urethane", skids: [{ x: 100, y: 0, type: "steel" }],
      drive: { motor: "compact1806", esc_A: 20, brake: true, drive_V: 18.5 },
      battery: { cells: 6, mAh: 650, R_mohm: 50 },
      weapon: { type: "horizontal", x: 100, y: 0, d: 190, mass_g: 280, shape: "bar", thick: 6.35, blade_w: 30, teeth: 2, dir: 1,
                motor: "m2807_1350", motors: 2, ratio: 2.4, esc_A: 40, I_override: 7.6e-4, rpm_cap: 12000 },
    },
    undercutter: {
      name: "Undercutter", archetype: "Horizontal undercutter, 2WD rear drive + front skid",
      note: "A typical beetle undercutter: wheels at the back, the blade low at the front, a skid under the weapon.",
      mass_g: 1360, cog: { x: 55, y: 0, h: 25 }, moi_auto: true,
      body: { pts: [[-50, 65], [-50, -65], [80, -65], [120, 0], [80, 65]] },
      wheels: [w(0, 85, 50, "L"), w(0, -85, 50, "R")], linked: false, motors_per_side: 1,
      tire: "urethane", skids: [{ x: 95, y: 0, type: "steel" }],
      drive: { motor: "compact1806", esc_A: 20, brake: true, drive_V: 0 },
      battery: { cells: 4, mAh: 650, R_mohm: 40 },
      weapon: { type: "horizontal", x: 95, y: 0, d: 180, mass_g: 250, shape: "bar", thick: 6, teeth: 2, dir: 1,
                motor: "m2807_1350", motors: 1, ratio: 1.6, esc_A: 40 },
    },
    vertical: {
      name: "Vertical spinner", archetype: "Vertical spinner, 2WD + front forks",
      note: "Gyro matters: turning with the disc up to speed rolls the robot onto one wheel.",
      mass_g: 1360, cog: { x: 20, y: 0, h: 28 }, moi_auto: true,
      body: { pts: [[-60, 55], [-60, -55], [70, -55], [110, -40], [110, 40], [70, 55]] },
      wheels: [w(-25, 60, 50, "L"), w(-25, -60, 50, "R")], linked: false, motors_per_side: 1,
      tire: "urethane", skids: [{ x: 105, y: 40, type: "steel" }, { x: 105, y: -40, type: "steel" }],
      drive: { motor: "compact1806", esc_A: 20, brake: true, drive_V: 0 },
      battery: { cells: 4, mAh: 650, R_mohm: 40 },
      weapon: { type: "vertical", x: 70, y: 0, d: 110, mass_g: 300, shape: "disc", thick: 12, teeth: 2, dir: 1,
                motor: "m2207_1950", motors: 1, ratio: 1.5, esc_A: 40 },
    },
    drum: {
      name: "Drum spinner", archetype: "Drum, 2WD + front wedgelets",
      note: "A drum spins about a horizontal axis like a vertical spinner: the same gyro and pitch reaction.",
      mass_g: 1360, cog: { x: 10, y: 0, h: 30 }, moi_auto: true,
      body: { pts: [[-55, 65], [-55, -65], [85, -65], [85, 65]] },
      wheels: [w(-20, 70, 50, "L"), w(-20, -70, 50, "R")], linked: false, motors_per_side: 1,
      tire: "urethane", skids: [{ x: 85, y: 45, type: "steel" }, { x: 85, y: -45, type: "steel" }],
      drive: { motor: "compact1806", esc_A: 20, brake: true, drive_V: 0 },
      battery: { cells: 4, mAh: 650, R_mohm: 40 },
      weapon: { type: "drum", x: 65, y: 0, d: 60, mass_g: 380, shape: "tube", thick: 90, teeth: 2, dir: 1,
                motor: "m2306_2450", motors: 1, ratio: 1.2, esc_A: 40 },
    },
    shell: {
      name: "Shell spinner", archetype: "Shell / ring spinner, 2WD centre drive",
      note: "The whole outer ring spins: a big yaw kick on spin-up, so the robot turns the other way.",
      mass_g: 1360, cog: { x: 0, y: 0, h: 30 }, moi_auto: true,
      body: { pts: [[-90, 40], [-90, -40], [90, -40], [90, 40]] },
      wheels: [w(0, 45, 40, "L"), w(0, -45, 40, "R")], linked: false, motors_per_side: 1,
      tire: "urethane", skids: [{ x: 70, y: 0, type: "caster" }, { x: -70, y: 0, type: "caster" }],
      drive: { motor: "compact1806", esc_A: 20, brake: true, drive_V: 0 },
      battery: { cells: 4, mAh: 650, R_mohm: 40 },
      weapon: { type: "horizontal", x: 0, y: 0, d: 230, mass_g: 550, shape: "ring", thick: 30, teeth: 2, dir: 1,
                motor: "m3536_1000", motors: 1, ratio: 3.0, esc_A: 40 },
    },
    pusher4wd: {
      name: "4WD pusher", archetype: "4WD wedge / pusher (control bot)",
      note: "Four wheels, each side chained together on one motor per side. No spinning weapon.",
      mass_g: 1360, cog: { x: 0, y: 0, h: 25 }, moi_auto: true,
      body: { pts: [[-75, 70], [-75, -70], [75, -70], [110, -60], [110, 60], [75, 70]] },
      wheels: [w(45, 75, 50, "L"), w(-45, 75, 50, "L"), w(45, -75, 50, "R"), w(-45, -75, 50, "R")], linked: true, motors_per_side: 1,
      tire: "urethane", skids: [],
      drive: { motor: "bl2204_27", esc_A: 20, brake: true, drive_V: 0 },
      battery: { cells: 4, mAh: 650, R_mohm: 40 },
      weapon: { type: "none" },
    },
  };

  // ------------------------------------------------------------------ setup -> SI robot
  function weaponI(W) {
    if (!W || W.type === "none") return 0;
    if (W.I_override > 0) return W.I_override;
    const r = W.d / 2000, m = W.mass_g / 1000;
    return (SHAPES[W.shape] || SHAPES.bar).k * m * r * r;
  }
  // yaw MOI estimate (g mm^2): the chassis as a uniform slab over its outline's box, the weapon as its own part (a
  // horizontal weapon's spin is on a bearing, so only its mass counts in yaw; a vertical one also turns about its
  // diameter), the wheels as points, all about the COG
  function estimateMoi(S) {
    const m = S.mass_g, W = S.weapon || {}, mw = W.type && W.type !== "none" ? W.mass_g : 0;
    const xs = S.body.pts.map(p => p[0]), ys = S.body.pts.map(p => p[1]);
    const L = Math.max(...xs) - Math.min(...xs), B = Math.max(...ys) - Math.min(...ys);
    const bx = (Math.max(...xs) + Math.min(...xs)) / 2, by = (Math.max(...ys) + Math.min(...ys)) / 2;
    const mwh = 25 * S.wheels.length, mc = Math.max(m - mw - mwh, 0.2 * m);
    let I = mc * (L * L + B * B) / 12 + mc * ((bx - S.cog.x) ** 2 + (by - S.cog.y) ** 2);
    for (const wh of S.wheels) I += 25 * ((wh.x - S.cog.x) ** 2 + (wh.y - S.cog.y) ** 2);
    if (mw) {
      I += mw * ((W.x - S.cog.x) ** 2 + (W.y - S.cog.y) ** 2);
      if (W.type !== "horizontal") I += 0.5 * weaponI(W) * 1e9;     // kg m^2 -> g mm^2, about a diameter
    }
    return I;
  }

  function build(S) {
    const mm = v => v / 1000;
    const dm = DRIVE_MOTORS[S.drive.motor] || DRIVE_MOTORS.compact1806;
    const da = S.drive.adv || {};
    const tire = Object.assign({}, TIRES[S.tire] || TIRES.urethane, S.tire_adv || {});
    const V = S.battery.cells * (S.battery.cellV || 3.7);
    const moi = S.moi_auto ? estimateMoi(S) : S.moi_gmm2;
    const R = {
      name: S.name, m: S.mass_g / 1000, Izz: moi * 1e-9, tau: 0.010,
      cog: { x: mm(S.cog.x), y: mm(S.cog.y), h: mm(S.cog.h) },
      wheels: S.wheels.map(q => {
        const r = mm(q.d / 2), mw = (q.mass_g || 25) / 1000;
        return { x: mm(q.x), y: mm(q.y), r, driven: !!q.driven, side: q.side, J: 0.5 * mw * r * r };
      }),
      linked: !!S.linked, motorsPerSide: S.motors_per_side || 1,
      skids: (S.skids || []).map(q => { const k = Object.assign({}, SKIDS[q.type] || SKIDS.steel, q.adv || {}); return { x: mm(q.x), y: mm(q.y), muk: k.muk, mus: k.mus }; }),
      tire: { muk: tire.muk, mus: tire.mus, sigp: tire.sigp, vmin: 0.05, crr: tire.crr },
      drive: { kv: da.kv || dm.kv, R: da.R || dm.R, G: da.G || dm.G, eta: da.eta || dm.eta, etab: da.eta || dm.eta,
               Jrot: da.Jrot || dm.Jrot, Imax: S.drive.esc_A, brake: S.drive.brake, vmax: S.drive.drive_V || 0 },
      battery: { V, R: (S.battery.R_mohm || 40) / 1000, mAh: S.battery.mAh },
      outline: S.body.pts.map(p => [mm(p[0]), mm(p[1])]),
    };
    // the robot's outline also takes in its wheels (they hit walls too)
    for (const q of S.wheels) {
      const r = q.d / 2, side = Math.sign(q.y) || 1, wd = q.w || 16;
      R.outline.push([mm(q.x - r), mm(q.y + side * wd / 2)], [mm(q.x + r), mm(q.y + side * wd / 2)]);
    }
    R.outline = hull(R.outline);
    const W = S.weapon || { type: "none" };
    if (W.type && W.type !== "none") {
      const wm = WEAPON_MOTORS[W.motor] || WEAPON_MOTORS.m2807_1350, wa = W.adv || {};
      const I = weaponI(W), r = mm(W.d / 2);
      R.weapon = {
        type: W.type, x: mm(W.x), y: mm(W.y), I, dir: W.dir || 1, radius: r, teeth: W.teeth || 2,
        motor: { kv: wa.kv || wm.kv, R: wa.R || wm.R, Imax: W.esc_A || 40 }, n: W.motors || 1, G: W.ratio || 1,
        eta: wa.eta || 0.9,
        // drag: set so a free-spinning weapon settles a little under its no-load speed (bearings + air)
        drag: 0, drag0: wa.drag0 !== undefined ? wa.drag0 : 0.002 * I / 7.6e-4,
        bite_e: wa.bite_e !== undefined ? wa.bite_e : 0.3, flingShare: 0.35,
        rpm_cap: W.rpm_cap || 0,
      };
      // air drag: about 3 % of the motor's stall-limited torque at the theoretical top speed
      const wtop = (wm.kv * V * 2 * Math.PI / 60) / (W.ratio || 1);
      const Tlim = (W.motors || 1) * (60 / (2 * Math.PI * wm.kv)) * (W.esc_A || 40) * (W.ratio || 1);
      R.weapon.drag = wa.drag !== undefined ? wa.drag : 0.03 * Tlim / (wtop * wtop);
      if (W.type === "horizontal") {
        R.weaponFootprint = [];
        for (let k = 0; k < 16; k++) { const a = 2 * Math.PI * k / 16; R.weaponFootprint.push([mm(W.x) + r * Math.cos(a), mm(W.y) + r * Math.sin(a)]); }
      } else {
        const t = mm(W.thick || 10) / 2;
        R.weaponFootprint = [[mm(W.x) + r, mm(W.y) - t], [mm(W.x) + r, mm(W.y) + t], [mm(W.x) - r, mm(W.y) + t], [mm(W.x) - r, mm(W.y) - t]];
      }
    }
    return R;
  }
  function hull(P) {                                     // convex hull (counter-clockwise), for collisions
    const pts = P.map(p => p.slice()).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  // quick numbers a person can check the setup against
  function summary(S) {
    const R = build(S), W = R.weapon, d = R.drive;
    const vdrive = d.vmax > 0 ? Math.min(d.vmax, R.battery.V) : R.battery.V;
    const rmax = Math.max(...R.wheels.map(q => q.r));
    const top = d.kv * vdrive * 2 * Math.PI / 60 / d.G * rmax;
    const out = { top_speed: top, wheel_share: 0, moi: R.Izz };
    // static load on the wheels
    const P = global.RDS ? global.RDS.physics : (typeof require !== "undefined" ? require("./physics.js") : null);
    if (P) {
      const c = P.compile(R); P.shareLoads(c.dx, c.dy, R.m * 9.81, 0, 0, c.N, c.on);
      out.wheel_share = c.N.slice(0, c.nw).reduce((a, b) => a + b, 0) / (R.m * 9.81);
      out.loads = Array.from(c.N);
    }
    if (W) {
      const wtop = W.motor.kv * R.battery.V * 2 * Math.PI / 60 / W.G;
      out.weapon_rpm_free = wtop * 60 / (2 * Math.PI);
      out.weapon_I = W.I;
      out.weapon_energy_free = 0.5 * W.I * wtop * wtop;
      out.tip_speed_free = wtop * W.radius;
    }
    return out;
  }

  const global = typeof window !== "undefined" ? window : globalThis;
  const api = { TIRES, SKIDS, DRIVE_MOTORS, WEAPON_MOTORS, SHAPES, ARENAS, PRESETS, build, summary, estimateMoi, weaponI, hull };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.RDS = root.RDS || {}; root.RDS.robots = api; }
})(typeof window !== "undefined" ? window : globalThis);

/* RoborDriveSim physics, 3D.
 *
 * The chassis is a rigid body in 3D (position, velocity, orientation quaternion, angular velocity in its own frame),
 * as in REDblocks' 3D engine. Everything touches the floor, the walls and the target through penalty contacts
 * (a spring and a damper on each penetration, friction on the slip), so nothing is assumed about which way up it is:
 * it pitches, rolls, wheelies, tips, flips and lands.
 *
 *  - Wheels: a disc on an axle along the robot's y axis. Its contact point is the lowest point of the disc; the tire
 *    is a spring-damper (tread compliance) and grips through the combined-slip curve from the Flapjack drive model
 *    (brush rise, peak, slide) on the load it actually carries. Each wheel (or each side's linked set) spins on its
 *    own state with its motors' reflected rotor inertia; the gearbox's reaction goes into the chassis.
 *  - Skids and the body: skid points slide with Stribeck friction; the body's outline (a prism from its bottom to its
 *    top) is checked against the floor, walls and ceiling so it lands on its armour when it tips or flips.
 *  - Motors: back-EMF, resistance, the ESC's current limit, drag brake or coast, gearbox efficiency in the right
 *    direction, all drive and weapon motors on one pack with internal resistance (fixed point on the bus voltage).
 *  - Weapon: its spin (relative to the chassis) on its own motors. Its angular momentum H is carried in the chassis
 *    equations: I w' = torque - w x (I w + H) - dH/dt. So spinning up twists the chassis the other way about the
 *    weapon's axis, and turning a robot with a spinning vertical disc or drum makes it roll and pitch (gyro). Hits on
 *    the target are impulses through the tooth: blade inertia, target and robot, restitution, once per tooth.
 *  - Target: a 3D box with its own contacts: it slides, tumbles and flies when a vertical weapon catches it.
 *
 * Semi-implicit Euler at 50 us (contacts are stiff; this is well inside their stability limit).
 * Units SI. Browser: window.RDS.physics; node: module.exports.
 */
(function (root) {
  "use strict";
  const G0 = 9.81;
  // ---------------------------------------------------------------- small 3-vector and quaternion helpers
  const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => Math.sqrt(dot(a, a));
  function qrot(q, v) {                                 // rotate v by unit quaternion q = [w, x, y, z]
    const [w, x, y, z] = q, tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
  }
  const qconj = q => [q[0], -q[1], -q[2], -q[3]];
  function qmul(a, b) {
    return [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
            a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
  }
  function qint(q, w, h) {                              // q advanced by body rate w over h (exact rotation)
    const a = norm(w) * h;
    if (a < 1e-12) return q;
    const s = Math.sin(a / 2) / norm(w), d = [Math.cos(a / 2), w[0] * s, w[1] * s, w[2] * s];
    const r = qmul(q, d), n = Math.hypot(...r);
    return r.map(c => c / n);
  }
  const qyaw = psi => [Math.cos(psi / 2), 0, 0, Math.sin(psi / 2)];

  // ---------------------------------------------------------------- tire curve, motors (as in the Flapjack model)
  function tireMu(sig, mus, muk, sigp) {
    const sig0 = 0.5 * sigp;
    return muk * Math.tanh(sig / sig0) + (mus - muk) * (sig / sigp) * Math.exp(1.0 - sig / sigp);
  }
  function motorCurrent(u, wm, vbus, mo) {
    if (!mo.brake && Math.abs(u) < 0.02) return 0.0;
    const v = mo.vmax > 0 ? Math.min(vbus, mo.vmax) : vbus;
    let I = (u * v - mo.Ke * wm) / mo.R;
    if (I > mo.Imax) I = mo.Imax; else if (I < -mo.Imax) I = -mo.Imax;
    if (mo.oneWay && I < 0) I = 0;                      // a weapon ESC that only drives (no braking current)
    return I;
  }

  // ---------------------------------------------------------------- the robot, compiled
  // R from robots.js build(): m, I [Ixx, Iyy, Izz] about the COG (body axes), cog {x, y, h}, wheels [{x, y, z, r, w,
  // driven, side, J}], linked, motorsPerSide, skids [{x, y, z, mus, muk}], tire, drive, battery, weapon {type, x, y,
  // z, I, dir, radius, thick, teeth, motor, n, G, eta, drag, drag0, bite_e, rpm_cap}, outline [[x, y]], z0, z1
  function compile(R) {
    const c = { R };
    const C = [R.cog.x, R.cog.y, R.cog.h];
    const rel = (x, y, z) => [x - C[0], y - C[1], z - C[2]];
    const groups = [];
    R.wheels.forEach((w, i) => {
      let g;
      if (R.linked && w.driven) g = groups.find(q => q.linked && q.side === w.side);
      if (!g) { g = { linked: !!(R.linked && w.driven), side: w.side, wheels: [], motors: 0, J: 0 }; groups.push(g); }
      g.wheels.push(i);
    });
    const mo = R.drive, Ke = 60 / (2 * Math.PI * mo.kv);
    for (const g of groups) {
      const driven = g.wheels.some(i => R.wheels[i].driven);
      g.motors = !driven ? 0 : (g.linked ? R.motorsPerSide : g.wheels.filter(i => R.wheels[i].driven).length);
      g.J = g.wheels.reduce((s, i) => s + R.wheels[i].J, 0) + g.motors * mo.Jrot * mo.G * mo.G;
    }
    // angular momentum a spinning group carries (wheels + rotors: a rotor turns G times as fast, so it holds G Jrot w,
    // not the G^2 Jrot w its reflected inertia would suggest). The chassis feels the change of this, no more: taking
    // the reflected inertia's torque instead gave a fake wheelie at launch (the bug REDblocks fixed in 2026-10)
    for (const g of groups) g.Jmom = g.wheels.reduce((s, i) => s + R.wheels[i].J, 0) + g.motors * mo.Jrot * mo.G;
    c.groups = groups; c.ng = groups.length;
    c.wheelGroup = new Int32Array(R.wheels.length);
    groups.forEach((g, k) => g.wheels.forEach(i => { c.wheelGroup[i] = k; }));
    c.dmotor = { Ke, R: mo.R, Imax: mo.Imax, brake: !!mo.brake, G: mo.G, eta: mo.eta, etab: mo.etab || mo.eta, vmax: mo.vmax || 0 };
    c.wheels = R.wheels.map(w => ({ c: rel(w.x, w.y, w.z), r: w.r }));
    c.skids = R.skids.map(s => ({ p: rel(s.x, s.y, s.z || 0), muk: s.muk, mus: s.mus }));
    // the body's corners (bottom and top of the outline) and edge midpoints at the bottom
    const pts = [];
    // the body only: the wheels make their own contacts (a big wheel's square footprint would poke through the floor)
    const ol = R.bodyOutline || R.outline;
    for (let i = 0; i < ol.length; i++) {
      const a = ol[i], b = ol[(i + 1) % ol.length];
      pts.push(rel(a[0], a[1], R.z0), rel(a[0], a[1], R.z1), rel((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, R.z0), rel((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, R.z1));
    }
    c.hull = pts;
    // eight points round each wheel's tread, so a wheel can hit the target too
    c.wrimPts = [];
    for (const w of c.wheels) for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; c.wrimPts.push(add(w.c, [w.r * Math.cos(a), 0, w.r * Math.sin(a)])); }
    c.poly = ol.map(p => [p[0] - C[0], p[1] - C[1]]); c.zlo = R.z0 - C[2]; c.zhi = R.z1 - C[2];
    const W = R.weapon && R.weapon.type !== "none" ? R.weapon : null;
    c.weapon = W;
    if (W) {
      c.wmotor = { Ke: 60 / (2 * Math.PI * W.motor.kv), R: W.motor.R, Imax: W.motor.Imax, brake: false, oneWay: true };
      c.wc = rel(W.x, W.y, W.z);
      c.waxis = W.type === "horizontal" ? [0, 0, W.dir] : [0, -W.dir, 0];       // spin sense in the body frame
      // its rim, for walls and the floor
      c.wrim = [];
      for (let k = 0; k < 16; k++) {
        const a = 2 * Math.PI * k / 16, cs = Math.cos(a) * W.radius, sn = Math.sin(a) * W.radius;
        c.wrim.push(W.type === "horizontal" ? add(c.wc, [cs, sn, 0]) : add(c.wc, [cs, 0, sn]));
        if (W.type !== "horizontal") { c.wrim.push(add(c.wc, [cs, W.thick / 2, sn])); c.wrim.push(add(c.wc, [cs, -W.thick / 2, sn])); }
      }
    }
    c.I = R.I.slice(); c.Iinv = R.I.map(v => 1 / v);
    c.reach = Math.max(...c.hull.map(norm), ...(c.wrim || []).map(norm), ...c.wheels.map(w => norm(w.c) + w.r)) + 0.01;
    return c;
  }

  // ---------------------------------------------------------------- the simulation
  class Sim {
    constructor(R, opts) {
      this.opts = Object.assign({ h: 1e-4, arena: 2.4384, ceiling: 1.2, k_tire: 2e4, c_tire: 80, k_hard: 2e5, c_hard: 250,
                                  e_wall: 0.3, mu_wall: 0.3, mu_body: 0.25, target: null }, opts || {});
      this.setRobot(R);
    }
    setRobot(R) { this.c = compile(R); this.R = R; this.reset(); }
    reset(pose) {
      const c = this.c, R = this.R, o = this.opts;
      const ps = pose || { x: 0, y: -0.5 * o.arena + 0.35, psi: Math.PI / 2 };
      this.q = qyaw(ps.psi);
      // pose places the robot's reference point on the floor; the state carries the COG (settled on its contacts)
      const off = qrot(this.q, [R.cog.x, R.cog.y, 0]);
      this.p = [ps.x + off[0], ps.y + off[1], R.cog.h + this.settle()];
      this.v = v3(); this.w = v3();                      // world velocity of the COG; body-frame angular velocity
      this.wg = new Float64Array(c.ng);                  // wheel group spin (relative to the chassis)
      this.ww = 0; this.wangle = 0; this.lastBite = -1e9;
      this.t = 0; this.charge = 0; this.dg = {}; this.hits = []; this.u = { L: 0, R: 0, W: 0 };
      const T = o.target;
      if (T) {
        const I = [T.m * (T.b * T.b + T.c * T.c) / 12, T.m * (T.a * T.a + T.c * T.c) / 12, T.m * (T.a * T.a + T.b * T.b) / 12];
        this.tg = { p: [T.x, T.y, T.c / 2 - 0.0005], v: v3(), q: qyaw(T.psi || 0), w: v3(), m: T.m, I, a: T.a, b: T.b, c: T.c, mu: T.mu };
      } else this.tg = null;
      this.E = { hit: 0 };
    }
    settle() {                                          // static sink of the contacts under the robot's weight
      const R = this.R, o = this.opts, W = R.m * G0;
      const kw = R.wheels.length * o.k_tire + R.skids.length * o.k_hard;
      return -W / Math.max(kw, 1);
    }

    // forces and moments on the chassis, the wheels' and weapon's torques, the target's forces
    forces() {
      const c = this.c, R = this.R, o = this.opts, u = this.u, q = this.q, p = this.p, v = this.v;
      const ww = qrot(q, this.w);                         // world angular velocity
      const [qw, qx, qy, qz] = q;                          // the third row of the rotation: a point's height, cheaply
      const r20 = 2 * (qx * qz - qw * qy), r21 = 2 * (qy * qz + qw * qx), r22 = 1 - 2 * (qx * qx + qy * qy);
      const zOf = b => p[2] + r20 * b[0] + r21 * b[1] + r22 * b[2];
      // world force and moment about the COG, accumulated as plain numbers (no garbage in the hot loops)
      let Fx = 0, Fy = 0, Fz = -R.m * G0, Mx_ = 0, My_ = 0, Mz_ = 0;
      const applyS = (fx, fy, fz, rx, ry, rz) => { Fx += fx; Fy += fy; Fz += fz; Mx_ += ry * fz - rz * fy; My_ += rz * fx - rx * fz; Mz_ += rx * fy - ry * fx; };
      const apply = (f, r) => applyS(f[0], f[1], f[2], r[0], r[1], r[2]);
      const velAt = r => add(v, cross(ww, r));
      // the full rotation, for points
      const R00 = 1 - 2 * (q[2] * q[2] + q[3] * q[3]), R01 = 2 * (q[1] * q[2] - q[0] * q[3]), R02 = 2 * (q[1] * q[3] + q[0] * q[2]);
      const R10 = 2 * (q[1] * q[2] + q[0] * q[3]), R11 = 1 - 2 * (q[1] * q[1] + q[3] * q[3]), R12 = 2 * (q[2] * q[3] - q[0] * q[1]);
      // ---- motors on the bus
      const gs = c.groups, dm = c.dmotor, W = c.weapon;
      const I = c.Ibuf || (c.Ibuf = new Float64Array(c.ng));
      const uOf = g => g.side === "L" ? u.L : (g.side === "R" ? u.R : 0);
      let uw = u.W || 0;
      if (W && W.rpm_cap > 0) { const cap = W.rpm_cap * Math.PI / 30; uw *= Math.max(0, Math.min(1, (cap - this.ww) / (0.02 * cap))); }
      let vbus = R.battery.V, IW = 0;
      const busPower = () => {
        let P = 0;
        for (let k = 0; k < c.ng; k++) { const g = gs[k]; if (!g.motors) { I[k] = 0; continue; } const wm = this.wg[k] * dm.G; I[k] = motorCurrent(uOf(g), wm, vbus, dm); P += g.motors * (I[k] * dm.R + dm.Ke * wm) * I[k]; }
        if (W) { const wm = this.ww * W.G; IW = motorCurrent(uw, wm, vbus, c.wmotor); P += W.n * (IW * c.wmotor.R + c.wmotor.Ke * wm) * IW; }
        return P;
      };
      for (let it = 0; it < 10; it++) vbus = 0.4 * vbus + 0.6 * (R.battery.V - R.battery.R * busPower() / vbus);
      const Pbus = busPower(), Ib = Pbus / vbus;
      // ---- wheels
      const Tg = new Float64Array(c.ng), axle = qrot(q, [0, 1, 0]);
      const h = o.h;
      const wheels = [];
      let ground = 0;
      for (let i = 0; i < c.wheels.length; i++) {
        const wh = c.wheels[i], k = c.wheelGroup[i], cw = qrot(q, wh.c), center = add(p, cw);
        // the lowest point of the disc
        let d = [-axle[0] * -axle[2], -axle[1] * -axle[2], -1 + axle[2] * axle[2]];   // -z minus its part along the axle
        const dn = norm(d); let N = 0, slip = 0, mu = 0;
        if (dn > 0.05) {
          d = mul(d, 1 / dn);
          const s = add(center, mul(d, wh.r)), pen = -s[2];
          if (pen > 0) {
            const r = sub(s, p), vs = velAt(r), rim = cross(mul(axle, this.wg[k]), sub(s, center)), vc = add(vs, rim);
            N = o.k_tire * pen - o.c_tire * vs[2]; if (N < 0) N = 0;
            const vt = [vc[0], vc[1], 0], sm = Math.hypot(vt[0], vt[1]);
            const vref = Math.max(Math.abs(this.wg[k] * wh.r), Math.hypot(vs[0], vs[1]), R.tire.vmin);
            slip = sm / vref; mu = tireMu(slip, R.tire.mus, R.tire.muk, R.tire.sigp);
            const Ft = sm > 1e-12 ? [-mu * N * vt[0] / sm, -mu * N * vt[1] / sm, 0] : v3();
            const f = add(Ft, [0, 0, N]);
            // the wheel keeps the torque about its axle; the chassis takes the rest through the bearing
            let tAx = dot(cross(sub(s, center), Ft), axle);
            // never more than brings the tread to the ground's speed this step (a light idler wheel would otherwise
            // flip back and forth: its spin is far stiffer than anything else here)
            const gJ = c.groups[k].J, lim = sm / wh.r * gJ / h;
            if (Math.abs(tAx) > lim) tAx = Math.sign(tAx) * lim;
            const Trr = R.tire.crr * N * wh.r * Math.tanh(this.wg[k] * wh.r / 0.02);
            Tg[k] += tAx - Trr;
            apply(f, r);                                  // the whole contact force, at the contact
            ground++;
          }
        }
        wheels.push({ N, slip, mu, lifted: N <= 0 });
      }
      for (let k = 0; k < c.ng; k++) {
        const g = gs[k]; if (!g.motors) continue;
        const Tm = g.motors * dm.Ke * I[k], w = this.wg[k];
        const Tout = Tm * w >= 0 ? dm.eta * dm.G * Tm : dm.G * Tm / dm.etab;
        Tg[k] += Tout;
      }
      // ---- skids, the body outline, the weapon rim: floor, walls, ceiling
      const H = 0.5 * o.arena, near = o.arena > 0 && (Math.abs(p[0]) > H - c.reach || Math.abs(p[1]) > H - c.reach);
      const lowEnough = p[2] < c.reach;
      const skidN = [];
      for (const sk of c.skids) {
        let N = 0;
        if (zOf(sk.p) >= 0) { skidN.push(0); continue; }
        const r = qrot(q, sk.p), s = add(p, r);
        if (s[2] < 0) {
          const vs = velAt(r);
          N = o.k_hard * -s[2] - o.c_hard * vs[2]; if (N < 0) N = 0;
          const vm = Math.hypot(vs[0], vs[1]), mub = sk.muk + (sk.mus - sk.muk) * Math.exp(-((vm / 0.01) ** 2)), den = Math.sqrt(vm * vm + 2.5e-5);
          apply([-mub * N * vs[0] / den, -mub * N * vs[1] / den, N], r);
        }
        skidN.push(N);
      }
      let bodyHit = 0;
      const hard = (b, mu, wallOnly) => {                // a point of the robot against floor, walls, ceiling
        const rz = r20 * b[0] + r21 * b[1] + r22 * b[2], sz = p[2] + rz;
        const ceil = o.ceiling > 0 && sz > o.ceiling;
        if (sz > 0 && !near && !ceil) return;
        const rx = R00 * b[0] + R01 * b[1] + R02 * b[2], ry = R10 * b[0] + R11 * b[1] + R12 * b[2];
        const sx = p[0] + rx, sy = p[1] + ry;
        if (sz > 0 && !ceil && Math.abs(sx) < H && Math.abs(sy) < H) return;     // near a wall, but not this point
        const vx = v[0] + ww[1] * rz - ww[2] * ry, vy = v[1] + ww[2] * rx - ww[0] * rz, vz = v[2] + ww[0] * ry - ww[1] * rx;
        if (sz < 0 && lowEnough && !wallOnly) {
          const N = o.k_hard * -sz - o.c_hard * vz;
          if (N > 0) { const den = Math.sqrt(vx * vx + vy * vy + 2.5e-5), k = -mu * N / den; applyS(k * vx, k * vy, N, rx, ry, rz); bodyHit++; }
        }
        if (near) {
          for (let ax = 0; ax < 2; ax++) for (let si = 0; si < 2; si++) {
            const sg = si ? -1 : 1, pen = sg * (ax ? sy : sx) - H; if (pen <= 0) continue;
            const vn = sg * (ax ? vy : vx), N = o.k_hard * pen + o.c_hard * vn; if (N <= 0) continue;
            const tx = ax ? vx : 0, ty = ax ? 0 : vy, tz = vz, den = Math.sqrt(tx * tx + ty * ty + tz * tz + 2.5e-5), k = -o.mu_wall * N / den;
            applyS(k * tx - (ax ? 0 : sg * N), k * ty - (ax ? sg * N : 0), k * tz, rx, ry, rz);
          }
        }
        if (ceil) { const N = o.k_hard * (sz - o.ceiling) + o.c_hard * vz; if (N > 0) applyS(0, 0, -N, rx, ry, rz); }
      };
      for (const r0 of c.hull) hard(r0, o.mu_body);
      // the weapon's rim: its surface moves with the spin, so touching the floor or a wall drags on the blade and
      // kicks the robot (an undercutter tipped onto its blade, a vertical clipping the wall)
      let wtau = 0;
      if (W) {
        const sw = qrot(q, c.waxis), cwW = qrot(q, c.wc);
        const rim = (r, s0, pen, n) => {
          // the rim is a circle spinning in place: the spin slides its material along the surface it touches (friction)
          // but does not move the circle toward it, so the push-back's damping uses the chassis' motion only. With the
          // spin in the damping, a tilted blade's rim points read 15-40 m/s "into" the floor and kicked the robot up.
          const vc = velAt(r), vs = add(vc, cross(mul(sw, this.ww), sub(r, cwW)));
          let N = o.k_hard * pen - o.c_hard * dot(vc, n); if (N <= 0) return;
          const vt = sub(vs, mul(n, dot(vs, n))), vm = norm(vt), f = add(mul(n, N), vm > 1e-9 ? mul(vt, -0.3 * N / Math.sqrt(vm * vm + 2.5e-5)) : v3());
          apply(f, r); wtau += dot(cross(sub(r, cwW), f), sw); bodyHit++;
        };
        for (const r0 of c.wrim) {
          const z0 = zOf(r0);
          if (z0 > 0) {
            if (!near) continue;
            const sx = p[0] + R00 * r0[0] + R01 * r0[1] + R02 * r0[2], sy = p[1] + R10 * r0[0] + R11 * r0[1] + R12 * r0[2];
            if (Math.abs(sx) < H && Math.abs(sy) < H) continue;
          }
          const r = qrot(q, r0), sp = add(p, r);
          if (sp[2] < 0 && lowEnough) rim(r, sp, -sp[2], [0, 0, 1]);
          if (near) for (let ax = 0; ax < 2; ax++) for (const sg of [1, -1]) { const pen = sg * sp[ax] - H; if (pen > 0) { const n = [0, 0, 0]; n[ax] = -sg; rim(r, sp, pen, n); } }
        }
      }
      for (const wh of c.wheels) {                       // wheels against walls (their outer rim, four points)
        if (!near) break;
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) hard(add(wh.c, [a * wh.r, 0, b * wh.r]), 0.6, true);   // walls only: the tire is the wheel's floor contact
      }
      // ---- the target box
      let tgF = null;
      if (this.tg) tgF = this.targetContacts(apply, velAt);
      // ---- the weapon
      let wdot = 0, Tw = 0;
      if (W) {
        const wm = this.ww * W.G;
        const Tm = W.n * c.wmotor.Ke * IW * W.G, Tout = Tm * this.ww >= 0 ? W.eta * Tm : Tm / W.eta;
        const Td = W.drag * this.ww * Math.abs(this.ww) + W.drag0 * Math.tanh(this.ww / 1.0);
        Tw = Tout - Td; wdot = (Tw + wtau) / W.I; void wm;
      }
      const F = [Fx, Fy, Fz], M = [Mx_, My_, Mz_];
      return { F, M, Tg, I, IW, vbus, Ib, wheels, skidN, wdot, Tw, ground, bodyHit, tgF };
    }

    // robot points inside the target box, and the box's corners inside the robot's body prism
    targetContacts(apply, velAt) {
      const T = this.tg, o = this.opts, c = this.c, q = this.q, p = this.p;
      const dist = norm(sub(T.p, p));
      const tF = { F: v3(), M: v3() };
      if (dist > c.reach + Math.hypot(T.a, T.b, T.c)) return tF;
      const twv = qrot(T.q, T.w), tvel = r => add(T.v, cross(twv, r));
      const k = o.k_hard * 0.5, cdmp = o.c_hard * 0.5, mu = 0.35;
      const push = (fOnRobot, rR, rT) => { apply(fOnRobot, rR); tF.F = sub(tF.F, fOnRobot); tF.M = sub(tF.M, cross(rT, fOnRobot)); };
      // robot points in the box
      const pts = c.hull.concat(c.wrim || [], c.wrimPts), nHull = c.hull.length, nRim = (c.wrim || []).length;
      const hx = T.a / 2, hy = T.b / 2, hz = T.c / 2;
      const axW = c.weapon ? qrot(qconj(T.q), qrot(q, c.waxis)) : null;   // the spin axis in the box's frame
      for (let ip = 0; ip < pts.length; ip++) {
        const r0 = pts[ip];
        const rR = qrot(q, r0), s = add(p, rR), rT = sub(s, T.p), l = qrot(qconj(T.q), rT);
        const dx = hx - Math.abs(l[0]), dy = hy - Math.abs(l[1]), dz = hz - Math.abs(l[2]);
        if (dx <= 0 || dy <= 0 || dz <= 0) continue;
        // out through the nearest face. A blade's rim can only push out sideways in its own plane: a low blade
        // that has bitten into a box's side is nearest the bottom face, and pushing it out through the bottom
        // drove it into the floor, threw the box up, and the floor's spring-back launched the robot
        const ds = [dx, dy, dz];
        if (axW && ip >= nHull && ip < nHull + nRim) for (let j = 0; j < 3; j++) if (Math.abs(axW[j]) > 0.7) ds[j] = Infinity;
        let j = ds[0] <= ds[1] && ds[0] <= ds[2] ? 0 : (ds[1] <= ds[2] ? 1 : 2);
        if (!isFinite(ds[j])) j = dx <= dy && dx <= dz ? 0 : (dy <= dz ? 1 : 2);
        const nl = [0, 0, 0]; nl[j] = Math.sign(l[j]) || 1; const d = [dx, dy, dz][j];
        const n = qrot(T.q, nl), rv = sub(velAt(rR), tvel(rT)), vn = dot(rv, n);
        let N = k * d - cdmp * vn; if (N <= 0) continue;
        const vt = sub(rv, mul(n, vn)), vm = norm(vt);
        const f = add(mul(n, N), vm > 1e-9 ? mul(vt, -mu * N * Math.tanh(vm / 0.02) / vm) : v3());
        push(f, rR, rT);
      }
      // box corners in the robot's prism
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const rT = qrot(T.q, [sx * hx, sy * hy, sz * hz]), s = add(T.p, rT), rR = sub(s, p), l = qrot(qconj(q), rR);
        if (l[2] < c.zlo || l[2] > c.zhi) continue;
        const hit = insidePoly(l[0], l[1], c.poly); if (!hit) continue;
        let [d, nx, ny] = hit, nl = [nx, ny, 0];
        const dzlo = l[2] - c.zlo, dzhi = c.zhi - l[2];
        if (dzlo < d) { d = dzlo; nl = [0, 0, -1]; } if (dzhi < d) { d = dzhi; nl = [0, 0, 1]; }
        const n = qrot(q, nl), rv = sub(tvel(rT), velAt(rR)), vn = dot(rv, n);
        let N = k * d - cdmp * vn; if (N <= 0) continue;
        const vt = sub(rv, mul(n, vn)), vm = norm(vt);
        const fT = add(mul(n, N), vm > 1e-9 ? mul(vt, -mu * N * Math.tanh(vm / 0.02) / vm) : v3());
        push(mul(fT, -1), rR, rT);
      }
      return tF;
    }

    // the target's own floor, walls and weight
    targetStep(h, tF) {
      const T = this.tg, o = this.opts, k = o.k_hard * 0.5, cd = 2 * 0.35 * Math.sqrt(k * T.m / 4);
      let F = add(tF.F, [0, 0, -T.m * G0]), M = tF.M.slice();
      const twv = qrot(T.q, T.w), H = 0.5 * o.arena;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const r = qrot(T.q, [sx * T.a / 2, sy * T.b / 2, sz * T.c / 2]), s = add(T.p, r), vs = add(T.v, cross(twv, r));
        const contact = (pen, n, vn) => {
          let N = k * pen - cd * vn; if (N <= 0) return;
          const vt = sub(vs, mul(n, dot(vs, n))), vm = norm(vt);
          const f = add(mul(n, N), vm > 1e-9 ? mul(vt, -T.mu * N / Math.sqrt(vm * vm + 2.5e-5)) : v3());
          F = add(F, f); M = add(M, cross(r, f));
        };
        if (s[2] < 0) contact(-s[2], [0, 0, 1], vs[2]);
        if (o.arena > 0) for (let ax = 0; ax < 2; ax++) for (const sg of [1, -1]) { const pen = sg * s[ax] - H; if (pen > 0) { const n = [0, 0, 0]; n[ax] = -sg; contact(pen, n, -sg * vs[ax]); } }
        if (o.ceiling > 0 && s[2] > o.ceiling) contact(s[2] - o.ceiling, [0, 0, -1], -vs[2]);
      }
      T.v = add(T.v, mul(F, h / T.m));
      const Mb = qrot(qconj(T.q), M), w = T.w;
      const Iw = [T.I[0] * w[0], T.I[1] * w[1], T.I[2] * w[2]], gyr = cross(w, Iw);
      T.w = [w[0] + h * (Mb[0] - gyr[0]) / T.I[0], w[1] + h * (Mb[1] - gyr[1]) / T.I[1], w[2] + h * (Mb[2] - gyr[2]) / T.I[2]];
      T.p = add(T.p, mul(T.v, h)); T.q = qint(T.q, T.w, h);
    }

    step(u) {
      const h = this.opts.h, c = this.c, R = this.R;
      this.u = u;
      const f = this.forces();
      // chassis: semi-implicit Euler, the weapon's momentum carried in the rotation
      this.v = add(this.v, mul(f.F, h / R.m));
      const Mb = qrot(qconj(this.q), f.M), w = this.w, I = c.I;
      let H = v3(), Hdot = v3();
      if (c.weapon) { H = mul(c.waxis, c.weapon.I * this.ww); Hdot = mul(c.waxis, c.weapon.I * f.wdot); }
      for (let k = 0; k < c.ng; k++) {                   // the drive's spinning parts: about the axle (body y)
        const g = c.groups[k]; H[1] += g.Jmom * this.wg[k]; Hdot[1] += g.Jmom * f.Tg[k] / g.J;
      }
      // I (w' - w) / h = M - w x I w - w' x H - dH/dt: the spinning parts' gyroscope taken at the new rate (implicit),
      // stable at any weapon speed (explicit, a fast blade's nutation grows by itself)
      const Iw = [I[0] * w[0], I[1] * w[1], I[2] * w[2]], gyr = cross(w, Iw);
      const rhs = [I[0] / h * w[0] + Mb[0] - gyr[0] - Hdot[0], I[1] / h * w[1] + Mb[1] - gyr[1] - Hdot[1], I[2] / h * w[2] + Mb[2] - gyr[2] - Hdot[2]];
      // (diag(I / h) - [H]x) w' = rhs, with [H]x the cross-product matrix (w' x H = -[H]x w')
      const A = [[I[0] / h, H[2], -H[1]], [-H[2], I[1] / h, H[0]], [H[1], -H[0], I[2] / h]];
      this.w = solve3(A, rhs);
      this.p = add(this.p, mul(this.v, h));
      this.q = qint(this.q, this.w, h);
      for (let k = 0; k < c.ng; k++) this.wg[k] += h * f.Tg[k] / c.groups[k].J;
      if (c.weapon) { this.ww = Math.max(0, this.ww + h * f.wdot); this.wangle += this.ww * h; }
      if (this.tg) { this.targetStep(h, f.tgF); if (c.weapon) this.weaponHit(); }
      this.charge += f.Ib * h; this.t += h;
      this.dg = f;
    }

    // a tooth on the target: an impulse along the tooth's motion, once per tooth
    weaponHit() {
      const c = this.c, W = c.weapon, T = this.tg, R = this.R;
      if (this.ww < 5) return;
      const period = 2 * Math.PI / Math.max(W.teeth, 1);
      if (this.wangle - this.lastBite < period) return;
      const q = this.q, cw = add(this.p, qrot(q, c.wc)), a = qrot(q, c.waxis);
      // the target point nearest the weapon centre (box clamp in its own frame)
      const l = qrot(qconj(T.q), sub(cw, T.p)), cl = [Math.max(-T.a / 2, Math.min(T.a / 2, l[0])), Math.max(-T.b / 2, Math.min(T.b / 2, l[1])), Math.max(-T.c / 2, Math.min(T.c / 2, l[2]))];
      const qp = add(T.p, qrot(T.q, cl)), d = sub(qp, cw), ax = dot(d, a), rad = sub(d, mul(a, ax)), rr = norm(rad);
      const half = W.type === "horizontal" ? W.thick / 2 + 0.004 : W.thick / 2 + 0.004;
      if (Math.abs(ax) > half || rr > W.radius || rr < 0.25 * W.radius) return;
      const tdir = mul(cross(a, rad), 1 / rr);           // where the tooth is going there
      const rR = sub(qp, this.p), vR = add(this.v, cross(qrot(q, this.w), rR));
      const rT = sub(qp, T.p), vT = add(T.v, cross(qrot(T.q, T.w), rT));
      const vrel = this.ww * rr + dot(sub(vR, vT), tdir);
      if (vrel <= 0) return;
      // effective masses along the tooth: the target, the blade (I / r^2), the robot behind the bearing
      const invI = (Ib, Iq, r) => { const rb = qrot(qconj(Iq), cross(r, tdir)); return rb[0] * rb[0] / Ib[0] + rb[1] * rb[1] / Ib[1] + rb[2] * rb[2] / Ib[2]; };
      const kT = 1 / T.m + invI(T.I, T.q, rT), kB = rr * rr / W.I, kR = 1 / R.m + invI(c.I, q, sub(cw, this.p));
      let J = (1 + W.bite_e) * vrel / (kT + kB + kR);
      // a rigid point impulse stops the blade dead on a solid hit (its tip is far lighter than the target), but real
      // armour crushes and the tooth bites only a few mm, so a blade keeps part of its speed: cap the energy one hit
      // can take (hit_take, a fraction; tune it from slow-motion video of the blade's speed before and after a hit)
      const take = W.hit_take !== undefined ? W.hit_take : 0.5;
      const Jmax = W.I * this.ww * (1 - Math.sqrt(Math.max(0, 1 - take))) / rr;
      if (J > Jmax) J = Jmax;
      const Jv = mul(tdir, J);
      // the target
      T.v = add(T.v, mul(Jv, 1 / T.m));
      const dL = qrot(qconj(T.q), cross(rT, Jv)); T.w = [T.w[0] + dL[0] / T.I[0], T.w[1] + dL[1] / T.I[1], T.w[2] + dL[2] / T.I[2]];
      // the blade slows; the robot is kicked back at the bearing
      const E0 = 0.5 * W.I * this.ww * this.ww;
      this.ww = Math.max(0, this.ww - J * rr / W.I);
      this.v = sub(this.v, mul(Jv, 1 / R.m));
      const rc = sub(cw, this.p), mb = qrot(qconj(q), cross(rc, Jv)); this.w = [this.w[0] - mb[0] / c.I[0], this.w[1] - mb[1] / c.I[1], this.w[2] - mb[2] / c.I[2]];
      // the floor pushes back during the hit, not after it: without this the impulse rolled the robot (and the
      // box) straight into its soft tire springs, which threw it into the air on the rebound
      this.floorReact(this.v, this.w, q, R.m, c.I, this.groundPoints());
      this.floorReact(T.v, T.w, T.q, T.m, T.I, this.boxGroundPoints());
      this.lastBite = this.wangle;
      const dE = E0 - 0.5 * W.I * this.ww * this.ww;
      this.hits.push({ t: this.t, J, dE, x: qp[0], y: qp[1], z: qp[2], vtip: this.ww * rr });
      if (this.hits.length > 50) this.hits.shift();
    }

    // the robot's points on (or within 2 mm of) the floor: {r: offset from the COG, mu, ax: a wheel's axle (it rolls
    // freely the other way)}
    groundPoints() {
      const c = this.c, R = this.R, q = this.q, p = this.p, out = [], axle = qrot(q, [0, 1, 0]);
      const near = (r, mu, ax) => { if (p[2] + r[2] < 0.002) out.push({ r, mu, ax }); };
      let d = [axle[0] * axle[2], axle[1] * axle[2], -1 + axle[2] * axle[2]]; const dn = norm(d);
      if (dn > 0.05) { d = mul(d, 1 / dn); for (const wh of c.wheels) near(add(qrot(q, wh.c), mul(d, wh.r)), R.tire.mus, axle); }
      for (const sk of c.skids) near(qrot(q, sk.p), sk.mus, null);
      for (const r0 of c.hull) near(qrot(q, r0), this.opts.mu_body, null);
      return out;
    }
    boxGroundPoints() {
      const T = this.tg, out = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const r = qrot(T.q, [sx * T.a / 2, sy * T.b / 2, sz * T.c / 2]); if (T.p[2] + r[2] < 0.002) out.push({ r, mu: T.mu, ax: null });
      }
      return out;
    }
    // the floor during a hit: inelastic normal impulses where the hit would drive a point into the floor, and friction
    // impulses (at most mu times the normal one) against the sliding the hit gives each point (sequential impulses).
    // v is the world velocity, w the body-frame angular velocity, I the body-frame principal inertias; both change.
    floorReact(v, w, q, m, I, pts) {
      if (!pts.length) return;
      const n = pts.length, Pn = new Float64Array(n), Pt = pts.map(() => [0, 0]);
      const vel = r => { const W = qrot(q, w); return add(v, cross(W, r)); };
      const push = (r, dir, P) => {                       // impulse P along world dir at offset r
        for (let k = 0; k < 3; k++) v[k] += dir[k] * P / m;
        const b = qrot(qconj(q), cross(r, dir)); for (let k = 0; k < 3; k++) w[k] += b[k] * P / I[k];
      };
      const kOf = (r, dir) => { const b = qrot(qconj(q), cross(r, dir)); return 1 / m + b[0] * b[0] / I[0] + b[1] * b[1] / I[1] + b[2] * b[2] / I[2]; };
      const ez = [0, 0, 1];
      const tdirs = pts.map(pt => pt.ax ? [[pt.ax[0], pt.ax[1], 0]] : [[1, 0, 0], [0, 1, 0]]);
      for (let it = 0; it < 40; it++) {
        let worst = 0;
        for (let i = 0; i < n; i++) {
          const pt = pts[i];
          // normal: the floor only pushes
          let vz = vel(pt.r)[2], dP = -vz / kOf(pt.r, ez); if (Pn[i] + dP < 0) dP = -Pn[i];
          if (dP) { Pn[i] += dP; push(pt.r, ez, dP); worst = Math.max(worst, Math.abs(vz)); }
          // friction, bounded by mu times this point's normal impulse
          for (let a = 0; a < tdirs[i].length; a++) {
            let t = tdirs[i][a]; const tn = Math.hypot(t[0], t[1]); if (tn < 1e-6) continue; t = [t[0] / tn, t[1] / tn, 0];
            const vt = dot(vel(pt.r), t), lim = pt.mu * Pn[i];
            let target = Pt[i][a] - vt / kOf(pt.r, t); target = Math.max(-lim, Math.min(lim, target));
            const d = target - Pt[i][a]; if (d) { Pt[i][a] = target; push(pt.r, t, d); }
          }
        }
        if (worst < 1e-4) break;
      }
    }

    get state() {
      const q = this.q, R = this.R, c = this.c, f = this.dg || {};
      const fwd = qrot(q, [1, 0, 0]), up = qrot(q, [0, 0, 1]);
      const ref = sub(this.p, qrot(q, [R.cog.x, R.cog.y, R.cog.h]));
      return {
        t: this.t, x: ref[0], y: ref[1], z: ref[2], xcog: this.p[0], ycog: this.p[1], zcog: this.p[2], q: this.q.slice(),
        psi: Math.atan2(fwd[1], fwd[0]), pitch: Math.asin(Math.max(-1, Math.min(1, -fwd[2]))), roll: Math.atan2(qrot(q, [0, 1, 0])[2], up[2]),
        upsideDown: up[2] < 0, vx: this.v[0], vy: this.v[1], vz: this.v[2], speed: Math.hypot(this.v[0], this.v[1]), vfwd: fwd[0] * this.v[0] + fwd[1] * this.v[1],
        r: qrot(q, this.w)[2], groups: Array.from(this.wg), ww: this.ww, wangle: this.wangle,
        uL: this.u.L, uR: this.u.R, uW: this.u.W, mAh: this.charge / 3.6, vbus: f.vbus, Ib: f.Ib,
        wheels: f.wheels || [], skidN: f.skidN || [], target: this.tg, bodyHit: f.bodyHit,
      };
    }
    kinetic() {
      const c = this.c, R = this.R, w = this.w;
      let ke = 0.5 * R.m * dot(this.v, this.v) + 0.5 * (c.I[0] * w[0] * w[0] + c.I[1] * w[1] * w[1] + c.I[2] * w[2] * w[2]);
      c.groups.forEach((g, k) => { ke += 0.5 * g.J * this.wg[k] ** 2; });
      if (c.weapon) ke += 0.5 * c.weapon.I * this.ww * this.ww;
      return ke;
    }
  }
  function solve3(A, b) {                               // Cramer's rule, 3 x 3
    const d = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    const col = (k) => A.map((r, i) => r.map((v, j) => (j === k ? b[i] : v)));
    const det = M => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
  }
  function insidePoly(px, py, Q) {                      // counter-clockwise convex polygon: [depth, nx, ny] or null
    let best = Infinity, bn = null;
    for (let i = 0; i < Q.length; i++) {
      const a = Q[i], b = Q[(i + 1) % Q.length];
      let ex = b[0] - a[0], ey = b[1] - a[1]; const L = Math.hypot(ex, ey) || 1e-12; ex /= L; ey /= L;
      const nx = ey, ny = -ex, d = (px - a[0]) * nx + (py - a[1]) * ny;
      if (d > 0) return null;
      if (-d < best) { best = -d; bn = [nx, ny]; }
    }
    return [best, bn[0], bn[1]];
  }

  const api = { Sim, compile, tireMu, motorCurrent, qrot, qmul, qconj, qyaw };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.RDS = root.RDS || {}; root.RDS.physics = api; }
})(typeof window !== "undefined" ? window : globalThis);

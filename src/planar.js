/* RoborDriveSim physics.
 *
 * Built from the Flapjack drive model in REDblocks (examples/case_studies/combat_robot/flapjack_drive_legacy.py),
 * which matched the REDblocks 3D drive model within about 4 % on launch, point turns, braking and a fight's energy.
 * That model is a planar rigid body (x, y, yaw) on two driven wheels and a sliding skid. Here it is general:
 *
 *  - any number of wheels at any positions, each with its own radius; a wheel is driven or free; driven wheels on
 *    one side can be linked (chain or belt) so they turn together on that side's motors
 *  - any number of skids (sliding contact points: a wedge edge, a bolt head, forks)
 *  - normal loads shared by a rigid floor plane on equal contact springs (exact for three contacts, the usual
 *    choice for more), with fore-aft and side load transfer from COG height (lagged, as in the original) and the
 *    weapon's pitch / roll moments; a contact that would pull is lifted off and the rest re-shared
 *  - each motor: back-EMF, winding resistance, ESC current limit, drag brake or coast, gearbox efficiency in the
 *    right direction; all motors (drive and weapon) on one pack with internal resistance, so a spinning-up weapon
 *    sags the drive
 *  - the combined-slip tire curve (brush rise, peak, slide), Stribeck skid friction, rolling resistance
 *  - the weapon: a spin state on its own motor(s); its spin-up and drag react on the chassis about the spin axis
 *    (horizontal: yaw; vertical or drum: pitch), and a vertical weapon's gyroscope rolls the chassis when it turns
 *  - arena walls and an optional target box (penalty contacts with friction), and weapon hits on the target as
 *    impulses through the tooth (blade inertia, target and robot masses, restitution, one bite per tooth)
 *
 * Fixed-step RK4 (0.1 ms by default). Runs in a browser (window.RDS.physics) and under node (module.exports).
 * Units: SI inside (m, kg, s, N, A, V); the setup screen works in mm and g and converts (see robots.js).
 */
(function (root) {
  "use strict";
  const G0 = 9.81;

  // ---------------------------------------------------------------- tire curve and motors (as in the original)
  function tireMu(sig, mus, muk, sigp) {
    const sig0 = 0.5 * sigp;
    return muk * Math.tanh(sig / sig0) + (mus - muk) * (sig / sigp) * Math.exp(1.0 - sig / sigp);
  }
  // ESC + motor: current from the throttle u (-1..1), the motor shaft speed wm and the bus voltage
  function motorCurrent(u, wm, vbus, mo) {
    if (!mo.brake && Math.abs(u) < 0.02) return 0.0;      // coast: the ESC lets go
    const v = mo.vmax > 0 ? Math.min(vbus, mo.vmax) : vbus;   // a drive capped below the pack (ESC endpoint)
    let I = (u * v - mo.Ke * wm) / mo.R;
    if (I > mo.Imax) I = mo.Imax; else if (I < -mo.Imax) I = -mo.Imax;
    if (mo.oneWay && I < 0 && u >= 0 && wm >= 0) I = Math.max(I, 0);   // a weapon ESC that only drives
    return I;
  }

  // ---------------------------------------------------------------- normal loads on a rigid floor plane
  // contacts at (dx, dy) from the COG; N = a + b dx + c dy over the ones touching (equal contact springs), such that
  // sum N = W, sum N dx = My, sum N dy = Mx. Lifted contacts (N < 0) drop out and the rest re-share.
  function shareLoads(dx, dy, W, My, Mx, N, on) {
    const n = dx.length;
    for (let i = 0; i < n; i++) on[i] = 1;
    let tip = 0;
    for (let pass = 0; pass <= n; pass++) {
      let s0 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
      for (let i = 0; i < n; i++) if (on[i]) { s0++; sx += dx[i]; sy += dy[i]; sxx += dx[i] * dx[i]; sxy += dx[i] * dy[i]; syy += dy[i] * dy[i]; }
      if (s0 === 0) { for (let i = 0; i < n; i++) N[i] = 0; return 2; }
      const eps = 1e-9 * (sxx + syy + 1e-6) + 1e-12;
      // solve [[s0 sx sy][sx sxx sxy][sy sxy syy]] [a b c] = [W My Mx] (regularised: two contacts in a line still work)
      const A = [[s0 + eps, sx, sy], [sx, sxx + eps, sxy], [sy, sxy, syy + eps]], bv = [W, My, Mx];
      const sol = solve3(A, bv);
      let neg = -1, worst = 0;
      for (let i = 0; i < n; i++) {
        N[i] = on[i] ? sol[0] + sol[1] * dx[i] + sol[2] * dy[i] : 0;
        if (on[i] && N[i] < worst) { worst = N[i]; neg = i; }
      }
      if (neg < 0) {
        // what the touching contacts could not hold (a moment beyond the support): the robot is tipping
        let fx = 0, fy = 0; for (let i = 0; i < n; i++) { fx += N[i] * dx[i]; fy += N[i] * dy[i]; }
        if (Math.abs(fx - My) > 1e-3 * (Math.abs(My) + W * 0.01) || Math.abs(fy - Mx) > 1e-3 * (Math.abs(Mx) + W * 0.01)) tip = 1;
        return tip;
      }
      on[neg] = 0; tip = 1;
    }
    return 1;
  }
  function solve3(A, b) {
    const M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < 3; c++) {
      let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c] || 1e-30;
      for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c] / d; for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]; }
    }
    return [M[0][3] / (M[0][0] || 1e-30), M[1][3] / (M[1][1] || 1e-30), M[2][3] / (M[2][2] || 1e-30)];
  }

  // ---------------------------------------------------------------- a robot, compiled to arrays the step uses
  // R (from robots.js build()): m, Izz, cog {x, y, h}, wheels [{x, y, r, driven, side, J}], linked, motorsPerSide,
  // skids [{x, y, mus, muk}], tire {muk, mus, sigp, vmin, crr}, drive motor {kv, R, G, eta, etab, Jrot, Imax, brake},
  // battery {V, R, mAh}, weapon {type, x, y, I, dir, radius, teeth, motor {...}, n, G, eta, drag, bite_e},
  // outline [[x, y], ...] (from the robot's origin), weapon footprint, tau
  function compile(R) {
    const c = { R };
    const cx = R.cog.x, cy = R.cog.y;
    // drive groups: linked wheels on each side turn together; otherwise each wheel turns alone
    const groups = [];
    R.wheels.forEach((w, i) => {
      let g;
      if (R.linked && w.driven) g = groups.find(q => q.linked && q.side === w.side);
      if (!g) { g = { linked: !!(R.linked && w.driven), side: w.side, wheels: [], motors: 0, J: 0 }; groups.push(g); }
      g.wheels.push(i);
    });
    const mo = R.drive;
    const Ke = 60 / (2 * Math.PI * mo.kv);                // V s/rad = N m/A at the motor
    for (const g of groups) {
      const driven = g.wheels.some(i => R.wheels[i].driven);
      g.motors = !driven ? 0 : (g.linked ? R.motorsPerSide : g.wheels.filter(i => R.wheels[i].driven).length);
      g.J = g.wheels.reduce((s, i) => s + R.wheels[i].J, 0) + g.motors * mo.Jrot * mo.G * mo.G;
    }
    c.groups = groups;
    c.wheelGroup = new Int32Array(R.wheels.length);
    groups.forEach((g, k) => g.wheels.forEach(i => { c.wheelGroup[i] = k; }));
    c.dmotor = { Ke, R: mo.R, Imax: mo.Imax, brake: mo.brake !== false && mo.brake !== 0, G: mo.G, eta: mo.eta, etab: mo.etab || mo.eta, vmax: mo.vmax || 0 };
    // contacts: wheels then skids, from the COG
    const pts = [...R.wheels.map(w => [w.x, w.y]), ...R.skids.map(s => [s.x, s.y])];
    c.dx = Float64Array.from(pts.map(p => p[0] - cx)); c.dy = Float64Array.from(pts.map(p => p[1] - cy));
    c.N = new Float64Array(pts.length); c.on = new Int32Array(pts.length);
    c.nw = R.wheels.length; c.ns = R.skids.length;
    const W = R.weapon || { type: "none" };
    c.weapon = W.type && W.type !== "none" ? W : null;
    if (c.weapon) {
      const wm = W.motor;
      c.wmotor = { Ke: 60 / (2 * Math.PI * wm.kv), R: wm.R, Imax: wm.Imax, brake: false, oneWay: true };
      c.wdx = W.x - cx; c.wdy = W.y - cy;
    }
    // state layout: body 0..9, groups, weapon, energies
    c.ng = groups.length;
    c.iG = 10; c.iW = 10 + c.ng; c.iE = c.iW + 1;
    c.E = { term: 0, cu: 1, gear: 2, tire: 3, skid: 4, rr: 5, wall: 6, wdrag: 7, bat: 8, target: 9 };
    c.NS = c.iE + 10;
    c.I = new Float64Array(c.ng); c.Tg = new Float64Array(c.ng);
    return c;
  }

  // ---------------------------------------------------------------- arena and target contacts
  function wallForces(px, py, vx, vy, H, A, acc) {
    // a point at (px, py) moving at (vx, vy) against the four walls of a square of half side H; acc [Fx, Fy, P]
    for (let k = 0; k < 4; k++) {
      const ax = k < 2 ? 0 : 1, sg = (k % 2) ? -1 : 1;
      const q = ax === 0 ? px : py, pen = sg * q - H;
      if (pen <= 0) continue;
      const vn = sg * (ax === 0 ? vx : vy), vt = ax === 0 ? vy : vx;
      let Nn = A.k * pen + A.c * vn; if (Nn < 0) Nn = 0;
      const Ft = -A.mu * Nn * Math.tanh(vt / 0.02);
      const fx = ax === 0 ? -sg * Nn : Ft, fy = ax === 0 ? Ft : -sg * Nn;
      acc[0] += fx; acc[1] += fy; acc[2] += -(fx * vx + fy * vy);
    }
  }
  // the deepest point of P inside a convex polygon Q (world): returns [depth, nx, ny] (normal out of Q) or null
  function insideConvex(px, py, Q) {
    let best = Infinity, bn = null;
    for (let i = 0; i < Q.length; i++) {
      const a = Q[i], b = Q[(i + 1) % Q.length];
      let ex = b[0] - a[0], ey = b[1] - a[1]; const L = Math.hypot(ex, ey) || 1e-12; ex /= L; ey /= L;
      const nx = ey, ny = -ex;                         // outward for a counter-clockwise polygon
      const d = (px - a[0]) * nx + (py - a[1]) * ny;
      if (d > 0) return null;
      if (-d < best) { best = -d; bn = [nx, ny]; }
    }
    return [best, bn[0], bn[1]];
  }
  function ccw(poly) {                                  // make a polygon counter-clockwise
    let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return s < 0 ? poly.slice().reverse() : poly;
  }

  // ---------------------------------------------------------------- the simulation
  class Sim {
    constructor(R, opts) {
      this.opts = Object.assign({ h: 2e-4, arena: 2.4384, k_wall: 5e4, e_wall: 0.3, mu_wall: 0.3, target: null }, opts || {});
      this.setRobot(R);
    }
    setRobot(R) {
      this.c = compile(R); this.R = R;
      this.outline = ccw(R.outline);
      // how far any part of the robot reaches from its COG (walls and the target are only checked within it)
      const all = this.outline.concat(R.weaponFootprint || []);
      this.reachR = Math.max(...all.map(([x, y]) => Math.hypot(x - R.cog.x, y - R.cog.y))) + 0.005;
      this.wo = { pts: this.outline.map(() => [0, 0]), weapon: (R.weaponFootprint || []).map(() => [0, 0]) };
      this.tpoly = [[0, 0], [0, 0], [0, 0], [0, 0]];
      this.reset();
    }
    reset(pose) {
      const c = this.c, R = this.R, o = this.opts;
      this.s = new Float64Array(c.NS);
      const ps = pose || { x: 0, y: -0.5 * o.arena + 0.35, psi: Math.PI / 2 };
      // pose places the robot's origin; the state carries the COG
      const cs = Math.cos(ps.psi), sn = Math.sin(ps.psi);
      this.s[0] = ps.x + cs * R.cog.x - sn * R.cog.y; this.s[1] = ps.y + sn * R.cog.x + cs * R.cog.y; this.s[2] = ps.psi;
      this.t = 0; this.uL = 0; this.uR = 0; this.uW = 0; this.charge = 0; this.dg = {}; this.hits = [];
      this.wangle = 0; this.lastBite = -1e9;
      const T = o.target;
      this.tg = T ? { x: T.x, y: T.y, psi: T.psi || 0, vx: 0, vy: 0, r: 0, m: T.m, I: T.m * (T.a * T.a + T.b * T.b) / 12, a: T.a, b: T.b, mu: T.mu } : null;
      this.k = [0, 1, 2, 3].map(() => new Float64Array(c.NS)); this.tmp = new Float64Array(c.NS);
      if (this.tg) { this.tk = [0, 1, 2, 3].map(() => new Float64Array(6)); this.tt = new Float64Array(6); }
      const m = R.m;
      const lw = -Math.log(Math.max(o.e_wall, 1e-3));
      if (T) this.TA = { k: o.k_wall, c: 2 * Math.sqrt(o.k_wall * T.m) * lw / Math.sqrt(Math.PI ** 2 + lw * lw), mu: o.mu_wall };
      this.tacc = [0, 0, 0];
      this.A = { k: o.k_wall, c: 2 * Math.sqrt(o.k_wall * m) * lw / Math.sqrt(Math.PI * Math.PI + lw * lw), mu: o.mu_wall };
    }

    // the robot's outline (and its weapon's footprint) in the world, from a state vector
    worldOutline(s, fresh) {
      const R = this.R, cs = Math.cos(s[2]), sn = Math.sin(s[2]);
      const ox = s[0] - (cs * R.cog.x - sn * R.cog.y), oy = s[1] - (sn * R.cog.x + cs * R.cog.y);
      const W = fresh ? { pts: this.outline.map(() => [0, 0]), weapon: (R.weaponFootprint || []).map(() => [0, 0]) } : this.wo;
      const fill = (src, dst) => { for (let i = 0; i < src.length; i++) { const x = src[i][0], y = src[i][1]; dst[i][0] = ox + cs * x - sn * y; dst[i][1] = oy + sn * x + cs * y; } };
      fill(this.outline, W.pts); fill(R.weaponFootprint || [], W.weapon);
      W.ox = ox; W.oy = oy;
      return W;
    }
    targetPoly(T, fresh) {
      const cs = Math.cos(T.psi), sn = Math.sin(T.psi), a = T.a / 2, b = T.b / 2, P = fresh ? [[0, 0], [0, 0], [0, 0], [0, 0]] : this.tpoly;
      const L = [[-a, -b], [a, -b], [a, b], [-a, b]];
      for (let i = 0; i < 4; i++) { P[i][0] = T.x + cs * L[i][0] - sn * L[i][1]; P[i][1] = T.y + sn * L[i][0] + cs * L[i][1]; }
      return P;
    }

    // time derivative of the robot state (and the target's, when there is one)
    deriv(s, T, u, ds, dT, dg) {
      const c = this.c, R = this.R, o = this.opts, m = R.m, h = R.cog.h;
      const cs = Math.cos(s[2]), sn = Math.sin(s[2]);
      const vbx = cs * s[3] + sn * s[4], vby = -sn * s[3] + cs * s[4], r = s[5];
      // weapon moments on the chassis (pitch My, roll Mx, yaw Mz), from its spin-up / drag and its gyroscope
      let wI = 0, Tw = 0, Pw = 0, IW = 0, Pwdrag = 0, Pwcu = 0;
      const W = c.weapon, ww = W ? s[c.iW] : 0;
      // the weapon ESC's speed cap (a governor): throttle eases off over the last 2 % below the cap
      let uw = u.W || 0;
      if (W && W.rpm_cap > 0) { const cap = W.rpm_cap * Math.PI / 30; uw *= Math.max(0, Math.min(1, (cap - ww) / (0.02 * cap))); }
      // ---- the bus: every motor on one pack (fixed point on the voltage, as in the original)
      const gs = c.groups, dm = c.dmotor;
      const I = c.I;
      let vbus = R.battery.V, Ib = 0;
      const uOf = g => g.side === "L" ? u.L : (g.side === "R" ? u.R : 0);
      for (let it = 0; it < 12; it++) {
        let P = 0;
        for (let k = 0; k < c.ng; k++) {
          const g = gs[k]; if (!g.motors) { I[k] = 0; continue; }
          const wm = s[c.iG + k] * dm.G;
          I[k] = motorCurrent(uOf(g), wm, vbus, dm);
          P += g.motors * (I[k] * dm.R + dm.Ke * wm) * I[k];
        }
        if (W) {
          const wm = ww * W.G;
          IW = motorCurrent(uw, wm, vbus, c.wmotor);
          P += W.n * (IW * c.wmotor.R + c.wmotor.Ke * wm) * IW;
        }
        Ib = P / vbus;
        vbus = 0.4 * vbus + 0.6 * (R.battery.V - R.battery.R * Ib);
      }
      let Pterm = 0, Pcu = 0;
      for (let k = 0; k < c.ng; k++) {
        const g = gs[k]; if (!g.motors) { I[k] = 0; continue; }
        const wm = s[c.iG + k] * dm.G;
        I[k] = motorCurrent(uOf(g), wm, vbus, dm);
        Pterm += g.motors * (I[k] * dm.R + dm.Ke * wm) * I[k]; Pcu += g.motors * I[k] * I[k] * dm.R;
      }
      if (W) {
        const wm = ww * W.G;
        IW = motorCurrent(uw, wm, vbus, c.wmotor);
        const Tm = W.n * c.wmotor.Ke * IW * W.G;           // at the weapon, before losses
        const Tout = Tm * ww >= 0 ? W.eta * Tm : Tm / W.eta;
        const Td = W.drag * ww * Math.abs(ww) + W.drag0 * Math.tanh(ww / 1.0);   // air + bearings
        Tw = Tout - Td; wI = Tw / W.I;
        Pterm += W.n * (IW * c.wmotor.R + c.wmotor.Ke * wm) * IW; Pcu += W.n * IW * IW * c.wmotor.R;
        Pw = Tm * ww - Tout * ww; Pwdrag = Td * ww;
      }
      Ib = Pterm / vbus;
      // reaction on the chassis = - (net torque on the weapon) about its axis; gyroscope for a horizontal axis
      let My = 0, Mx = 0, Mz = 0;
      if (W) {
        const Hs = W.I * ww * W.dir;                       // spin momentum, signed along the weapon's axis
        if (W.type === "horizontal") Mz -= W.dir * Tw;
        else {                                             // vertical / drum: axis across the robot (y)
          // dir +1: the front of the weapon moves up (spin about -y); chassis reaction about +y (nose down = +My)
          My += W.dir * Tw;
          Mx += -r * Hs;                                   // gyroscope: turning rolls the robot
        }
      }
      // ---- normal loads (lagged accelerations, as in the original)
      const tip = shareLoads(c.dx, c.dy, m * G0, -h * m * s[8] + My, -h * m * s[9] - Mx, c.N, c.on);
      // ---- wheels
      let Fbx = 0, Fby = 0, Mzt = Mz, Ptire = 0, Pgear = Pw, Prr = 0;
      const Tg = c.Tg; Tg.fill(0);
      for (let i = 0; i < c.nw; i++) {
        const wh = R.wheels[i], k = c.wheelGroup[i], N = c.N[i], w = s[c.iG + k], rw = wh.r;
        const xi = c.dx[i], yi = c.dy[i];
        const vcx = vbx - r * yi, vcy = vby + r * xi;
        const sx = vcx - w * rw, sy = vcy, sm = Math.sqrt(sx * sx + sy * sy);
        const vref = Math.max(Math.abs(w * rw), Math.sqrt(vcx * vcx + vcy * vcy), R.tire.vmin);
        const sig = sm / vref, mu = tireMu(sig, R.tire.mus, R.tire.muk, R.tire.sigp);
        let Fx = 0, Fy = 0;
        if (sm > 1e-12) { Fx = -mu * N * sx / sm; Fy = -mu * N * sy / sm; }
        Ptire += -(Fx * sx + Fy * sy); Fbx += Fx; Fby += Fy; Mzt += xi * Fy - yi * Fx;
        const Trr = R.tire.crr * N * rw * Math.tanh(w * rw / 0.02);
        Tg[k] += -Fx * rw - Trr; Prr += Trr * w;
        if (dg) { (dg.wheels || (dg.wheels = []))[i] = { N, slip: sig, mu, Fx, Fy }; }
      }
      for (let k = 0; k < c.ng; k++) {
        const g = gs[k], w = s[c.iG + k];
        let Tout = 0;
        if (g.motors) {
          const Tm = g.motors * dm.Ke * I[k];
          Tout = Tm * w >= 0 ? dm.eta * dm.G * Tm : dm.G * Tm / dm.etab;
          Pgear += Tm * dm.G * w - Tout * w;
        }
        ds[c.iG + k] = (Tout + Tg[k]) / g.J;
      }
      // ---- skids
      let Pskid = 0;
      for (let j = 0; j < c.ns; j++) {
        const sk = R.skids[j], i = c.nw + j, N = c.N[i], xi = c.dx[i], yi = c.dy[i];
        const vcx = vbx - r * yi, vcy = vby + r * xi, vm = Math.sqrt(vcx * vcx + vcy * vcy);
        const mub = sk.muk + (sk.mus - sk.muk) * Math.exp(-((vm / 0.01) ** 2));
        const den = Math.sqrt(vm * vm + 0.005 * 0.005);
        const Fx = -mub * N * vcx / den, Fy = -mub * N * vcy / den;
        Pskid += -(Fx * vcx + Fy * vcy); Fbx += Fx; Fby += Fy; Mzt += xi * Fy - yi * Fx;
      }
      // ---- walls and the target (world frame), about the COG
      let Pwall = 0, Ptg = 0, fwx = 0, fwy = 0;
      const acc = [0, 0, 0];
      const H = 0.5 * o.arena, nearWall = o.arena > 0 && (Math.abs(s[0]) > H - this.reachR || Math.abs(s[1]) > H - this.reachR);
      const nearT = T && Math.hypot(T.x - s[0], T.y - s[1]) < this.reachR + 0.5 * Math.hypot(T.a, T.b);
      if (nearWall || nearT) {
        const WO = this.worldOutline(s), TP = nearT ? this.targetPoly(T) : null;
        const pts = WO.pts.concat(WO.weapon);
        for (const [px, py] of pts) {
          const rx = px - s[0], ry = py - s[1], vx = s[3] - r * ry, vy = s[4] + r * rx;
          if (nearWall) {
            acc[0] = 0; acc[1] = 0; acc[2] = 0;
            wallForces(px, py, vx, vy, H, this.A, acc);
            fwx += acc[0]; fwy += acc[1]; Mzt += rx * acc[1] - ry * acc[0]; Pwall += acc[2];
          }
          if (nearT) {                                       // a robot point inside the target box
            const hit = insideConvex(px, py, TP);
            if (hit) {
              const [d, nx, ny] = hit, tx = T.vx - T.r * (py - T.y), ty = T.vy + T.r * (px - T.x);
              const rvx = vx - tx, rvy = vy - ty, vn = rvx * nx + rvy * ny, vt = -rvx * ny + rvy * nx;
              let Nn = this.A.k * d - this.A.c * 0.5 * vn; if (Nn < 0) Nn = 0;
              const Ft = -0.3 * Nn * Math.tanh(vt / 0.02);
              const fx = Nn * nx - Ft * ny, fy = Nn * ny + Ft * nx;     // on the robot, out of the box
              fwx += fx; fwy += fy; Mzt += rx * fy - ry * fx;
              dT.fx -= fx; dT.fy -= fy; dT.mz -= (px - T.x) * fy - (py - T.y) * fx;
              Ptg += -(fx * rvx + fy * rvy);
            }
          }
        }
        if (nearT) {                                         // target corners inside the robot outline
          for (const [px, py] of TP) {
            const hit = insideConvex(px, py, WO.pts);
            if (!hit) continue;
            const [d, nx, ny] = hit, rx = px - s[0], ry = py - s[1];
            const vx = s[3] - r * ry, vy = s[4] + r * rx, tx = T.vx - T.r * (py - T.y), ty = T.vy + T.r * (px - T.x);
            const rvx = tx - vx, rvy = ty - vy, vn = rvx * nx + rvy * ny, vt = -rvx * ny + rvy * nx;
            let Nn = this.A.k * d - this.A.c * 0.5 * vn; if (Nn < 0) Nn = 0;
            const Ft = -0.3 * Nn * Math.tanh(vt / 0.02);
            const fx = Nn * nx - Ft * ny, fy = Nn * ny + Ft * nx;       // on the target, out of the robot
            dT.fx += fx; dT.fy += fy; dT.mz += (px - T.x) * fy - (py - T.y) * fx;
            fwx -= fx; fwy -= fy; Mzt -= rx * fy - ry * fx;
            Ptg += -(fx * rvx + fy * rvy);
          }
        }
        Fbx += cs * fwx + sn * fwy; Fby += -sn * fwx + cs * fwy;
      }
      const axb = Fbx / m, ayb = Fby / m;
      ds[0] = s[3]; ds[1] = s[4]; ds[2] = r;
      ds[3] = cs * axb - sn * ayb; ds[4] = sn * axb + cs * ayb;
      ds[5] = Mzt / R.Izz;
      ds[8] = (axb - s[8]) / R.tau; ds[9] = (ayb - s[9]) / R.tau;
      if (W) ds[c.iW] = wI;
      const E = c.iE, e = c.E;
      ds[E + e.term] = Pterm; ds[E + e.cu] = Pcu; ds[E + e.gear] = Pgear; ds[E + e.tire] = Ptire; ds[E + e.skid] = Pskid;
      ds[E + e.rr] = Prr; ds[E + e.wall] = Pwall; ds[E + e.wdrag] = Pwdrag; ds[E + e.bat] = R.battery.R * Ib * Ib;
      ds[E + e.target] = Ptg;
      if (dg) {
        dg.N = Array.from(c.N); dg.I = Array.from(I); dg.IW = IW; dg.vbus = vbus; dg.Ib = Ib; dg.tip = tip;
        dg.ax = axb; dg.ay = ayb; dg.My = My; dg.Mx = Mx;
      }
    }

    // the target's own floor friction and walls (world), added to the robot's push on it (dT.fx, fy, mz)
    targetDeriv(T, dT, out) {
      const o = this.opts, g = T.m * G0;
      let fx = dT.fx, fy = dT.fy, mz = dT.mz;
      // floor friction at four corners (a quarter of the weight each)
      for (const [px, py] of this.targetPoly(T)) {
        const vx = T.vx - T.r * (py - T.y), vy = T.vy + T.r * (px - T.x), v = Math.hypot(vx, vy);
        const f = T.mu * g / 4 / Math.sqrt(v * v + 0.005 * 0.005);
        fx -= f * vx; fy -= f * vy; mz += (px - T.x) * (-f * vy) - (py - T.y) * (-f * vx);
        if (o.arena > 0 && (Math.abs(px) > 0.5 * o.arena || Math.abs(py) > 0.5 * o.arena)) {
          const acc = this.tacc; acc[0] = acc[1] = acc[2] = 0;
          wallForces(px, py, vx, vy, 0.5 * o.arena, this.TA, acc);
          fx += acc[0]; fy += acc[1]; mz += (px - T.x) * acc[1] - (py - T.y) * acc[0];
        }
      }
      out[0] = T.vx; out[1] = T.vy; out[2] = T.r; out[3] = fx / T.m; out[4] = fy / T.m; out[5] = mz / T.I;
    }

    // one RK4 step: u = {L, R, W} (drive sides -1..1, weapon 0..1)
    step(u) {
      const h = this.opts.h, c = this.c, s = this.s, [k1, k2, k3, k4] = this.k, tmp = this.tmp;
      this.uL = u.L; this.uR = u.R; this.uW = u.W;
      const T = this.tg;
      const tstate = q => ({ x: q[0], y: q[1], psi: q[2], vx: q[3], vy: q[4], r: q[5], m: T.m, I: T.I, a: T.a, b: T.b, mu: T.mu });
      let tq = T ? Float64Array.from([T.x, T.y, T.psi, T.vx, T.vy, T.r]) : null;
      const kt = T ? this.tk : null, tt = this.tt;
      const ev = (q, qT, kk, kT, dg) => {
        const dT = { fx: 0, fy: 0, mz: 0 };
        const TT = qT ? tstate(qT) : null;
        this.deriv(q, TT, u, kk, dT, dg);
        if (TT) this.targetDeriv(TT, dT, kT);
      };
      ev(s, tq, k1, kt && kt[0], this.dg);
      for (let i = 0; i < c.NS; i++) tmp[i] = s[i] + 0.5 * h * k1[i];
      if (T) for (let i = 0; i < 6; i++) tt[i] = tq[i] + 0.5 * h * kt[0][i];
      ev(tmp, T ? tt : null, k2, kt && kt[1], null);
      for (let i = 0; i < c.NS; i++) tmp[i] = s[i] + 0.5 * h * k2[i];
      if (T) for (let i = 0; i < 6; i++) tt[i] = tq[i] + 0.5 * h * kt[1][i];
      ev(tmp, T ? tt : null, k3, kt && kt[2], null);
      for (let i = 0; i < c.NS; i++) tmp[i] = s[i] + h * k3[i];
      if (T) for (let i = 0; i < 6; i++) tt[i] = tq[i] + h * kt[2][i];
      ev(tmp, T ? tt : null, k4, kt && kt[3], null);
      for (let i = 0; i < c.NS; i++) s[i] += h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
      if (T) {
        for (let i = 0; i < 6; i++) tq[i] += h / 6 * (kt[0][i] + 2 * kt[1][i] + 2 * kt[2][i] + kt[3][i]);
        [T.x, T.y, T.psi, T.vx, T.vy, T.r] = tq;
      }
      if (c.weapon) { this.wangle += s[c.iW] * h; if (s[c.iW] < 0 && c.weapon) s[c.iW] = Math.max(s[c.iW], -1e-9); }
      this.charge += (this.dg.Ib || 0) * h;
      this.t += h;
      if (T && c.weapon) this.weaponHit();
    }

    // a weapon hit on the target: an impulse along the tooth's motion, once per tooth
    weaponHit() {
      const c = this.c, W = c.weapon, s = this.s, T = this.tg, R = this.R;
      const ww = s[c.iW]; if (ww < 1) return;
      const cs = Math.cos(s[2]), sn = Math.sin(s[2]);
      const wx = s[0] + cs * c.wdx - sn * c.wdy, wy = s[1] + sn * c.wdx + cs * c.wdy;   // weapon centre
      const poly = this.targetPoly(T);
      // the target point nearest the weapon centre, and whether it is inside the weapon's reach
      let best = null;
      const reach = W.type === "horizontal" ? W.radius : W.radius;
      for (let i = 0; i < 4; i++) {
        const a = poly[i], b = poly[(i + 1) % 4], ex = b[0] - a[0], ey = b[1] - a[1];
        const tpar = Math.max(0, Math.min(1, ((wx - a[0]) * ex + (wy - a[1]) * ey) / (ex * ex + ey * ey)));
        const qx = a[0] + tpar * ex, qy = a[1] + tpar * ey, d = Math.hypot(qx - wx, qy - wy);
        if (!best || d < best.d) best = { d, qx, qy };
      }
      const inside = insideConvex(wx, wy, poly);
      if (!inside && best.d > reach) return;
      if (W.type !== "horizontal") {                       // a vertical weapon reaches out in front only
        const fx = (best.qx - wx) * cs + (best.qy - wy) * sn;
        if (fx < 0.3 * reach) return;
      }
      const period = 2 * Math.PI / Math.max(W.teeth, 1);
      if (this.wangle - this.lastBite < period) return;
      // tooth velocity at the contact (weapon spin + the robot's own motion) against the target point
      const rx = best.qx - wx, ry = best.qy - wy, rc = Math.max(Math.hypot(rx, ry), 0.3 * W.radius);
      let tdx, tdy;
      if (W.type === "horizontal") { tdx = -W.dir * ry / Math.hypot(rx, ry || 1e-9); tdy = W.dir * rx / Math.hypot(rx, ry || 1e-9); }
      else { tdx = cs; tdy = sn; }                         // vertical: its horizontal push is along the robot's heading
      const vtip = ww * rc * (W.type === "horizontal" ? 1 : W.flingShare);
      const rbx = best.qx - s[0], rby = best.qy - s[1];
      const vrx = s[3] - s[5] * rby, vry = s[4] + s[5] * rbx;
      const tvx = T.vx - T.r * (best.qy - T.y), tvy = T.vy + T.r * (best.qx - T.x);
      const vrel = vtip + (vrx - tvx) * tdx + (vry - tvy) * tdy;
      if (vrel <= 0) return;
      // effective mass: the blade at the tooth (I / r^2), the target at that point, the robot behind the bearing
      const rtx = best.qx - T.x, rty = best.qy - T.y, ct = rtx * tdy - rty * tdx;
      const invT = 1 / T.m + ct * ct / T.I;
      const cr = rbx * tdy - rby * tdx, invR = 1 / R.m + cr * cr / R.Izz;
      const invB = rc * rc / W.I;
      const J = (1 + W.bite_e) * vrel / (invT + invB + invR);
      // impulses: target pushed along the tooth, the blade slowed, the robot kicked back through the bearing
      T.vx += J * tdx / T.m; T.vy += J * tdy / T.m; T.r += J * ct / T.I;
      const E0 = 0.5 * W.I * ww * ww;
      s[c.iW] = Math.max(0, ww - J * rc / W.I);
      s[3] -= J * tdx / R.m; s[4] -= J * tdy / R.m; s[5] -= J * cr / R.Izz;
      this.lastBite = this.wangle;
      const dE = E0 - 0.5 * W.I * s[c.iW] ** 2;
      this.hits.push({ t: this.t, J, dE, x: best.qx, y: best.qy, vtip: ww * rc });
      if (this.hits.length > 50) this.hits.shift();
      s[c.iE + c.E.target] += 0;                            // the hit's energy is booked by the ledger as a jump (see ledger())
      this.hitEnergy = (this.hitEnergy || 0) + dE;
    }

    get state() {
      const s = this.s, c = this.c, R = this.R, cs = Math.cos(s[2]), sn = Math.sin(s[2]);
      return {
        t: this.t, x: s[0] - (cs * R.cog.x - sn * R.cog.y), y: s[1] - (sn * R.cog.x + cs * R.cog.y), xcog: s[0], ycog: s[1],
        psi: s[2], vx: s[3], vy: s[4], speed: Math.hypot(s[3], s[4]), vfwd: cs * s[3] + sn * s[4], r: s[5],
        groups: c.groups.map((g, k) => s[c.iG + k]), ww: c.weapon ? s[c.iW] : 0, wangle: this.wangle,
        uL: this.uL, uR: this.uR, uW: this.uW, mAh: this.charge / 3.6, target: this.tg, ...this.dg,
      };
    }
    kinetic() {
      const s = this.s, c = this.c, R = this.R;
      let ke = 0.5 * R.m * (s[3] ** 2 + s[4] ** 2) + 0.5 * R.Izz * s[5] ** 2;
      c.groups.forEach((g, k) => { ke += 0.5 * g.J * s[c.iG + k] ** 2; });
      if (c.weapon) ke += 0.5 * c.weapon.I * s[c.iW] ** 2;
      if (this.tg) { const T = this.tg; ke += 0.5 * T.m * (T.vx ** 2 + T.vy ** 2) + 0.5 * T.I * T.r ** 2; }
      return ke;
    }
    energies() { const c = this.c, o = {}; for (const k in c.E) o[k] = this.s[c.iE + c.E[k]]; return o; }
  }

  const api = { Sim, compile, shareLoads, tireMu, motorCurrent, solve3 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.RDS = root.RDS || {}; root.RDS.planar = api; }
})(typeof window !== "undefined" ? window : globalThis);

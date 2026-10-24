/* RoborDriveSim drawing: the arena from above (2D canvas), the robot as built (outline, wheels, skids, weapon,
 * COG), the target, the path, hits. Also the small top view in the setup screen. */
(function (root) {
  "use strict";
  const C = {
    bg: "#090c12", floor: "#1d2129", grid: "#262b35", grid5: "#323947", wall: "#9aa6b8", ink: "#e8edf4", ink2: "#9aa6b8",
    ink3: "#5d6878", red: "#e5383b", redd: "#7a1517", amber: "#f2a541", teal: "#2dd4bf", blue: "#4ea8de",
    chassis: "#0f1116", top: "#e9e6e1", wheel: "#15171c", tread: "#3a3f4a", skid: "#c0c7d2", cog: "#f2a541", target: "#59606d",
  };

  function view(ctx, w, h, arena, cam) {
    // world metres -> pixels: the arena fits the canvas (or the camera follows the robot)
    const pad = 24, span = cam && cam.follow ? cam.span : Math.max(arena, 1.2);
    const k = Math.min(w - 2 * pad, h - 2 * pad) / span;
    const cx = cam && cam.follow ? cam.x : 0, cy = cam && cam.follow ? cam.y : 0;
    return { k, X: x => w / 2 + (x - cx) * k, Y: y => h / 2 - (y - cy) * k };
  }

  function drawArena(ctx, V, arena, w, h) {
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
    if (arena <= 0) {
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
      for (let x = -20; x <= 20; x += 0.3048) { ctx.beginPath(); ctx.moveTo(V.X(x), 0); ctx.lineTo(V.X(x), h); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, V.Y(x)); ctx.lineTo(w, V.Y(x)); ctx.stroke(); }
      return;
    }
    const H = arena / 2;
    ctx.fillStyle = C.floor; ctx.fillRect(V.X(-H), V.Y(H), arena * V.k, arena * V.k);
    // one-foot grid (the floor's plywood is painted, the lines are only to judge distance)
    ctx.lineWidth = 1;
    for (let i = 1; i * 0.3048 < arena; i++) {
      const v = -H + i * 0.3048;
      ctx.strokeStyle = i % 4 === 0 ? C.grid5 : C.grid;
      ctx.beginPath(); ctx.moveTo(V.X(v), V.Y(H)); ctx.lineTo(V.X(v), V.Y(-H)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(V.X(-H), V.Y(v)); ctx.lineTo(V.X(H), V.Y(v)); ctx.stroke();
    }
    // the skirt (a wooden edge strip) and the walls
    ctx.strokeStyle = "#3b3226"; ctx.lineWidth = Math.max(2, 0.03 * V.k);
    ctx.strokeRect(V.X(-H) + ctx.lineWidth / 2, V.Y(H) + ctx.lineWidth / 2, arena * V.k - ctx.lineWidth, arena * V.k - ctx.lineWidth);
    ctx.strokeStyle = C.wall; ctx.lineWidth = 3; ctx.strokeRect(V.X(-H), V.Y(H), arena * V.k, arena * V.k);
    ctx.fillStyle = C.ink3; ctx.font = "11px 'IBM Plex Mono', monospace";
    ctx.fillText(`${(arena / 0.3048).toFixed(0)} ft x ${(arena / 0.3048).toFixed(0)} ft  ·  grid 1 ft`, V.X(-H) + 6, V.Y(-H) - 6);
  }

  function poly(ctx, V, pts) { ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(V.X(x), V.Y(y)) : ctx.moveTo(V.X(x), V.Y(y))); ctx.closePath(); }

  // the robot in the world: S is a setup (mm), st the sim state, R the built robot
  function drawRobot(ctx, V, S, R, st, opts) {
    const cs = Math.cos(st.psi), sn = Math.sin(st.psi);
    const tr = (x, y) => [st.x + (cs * x - sn * y) / 1000, st.y + (sn * x + cs * y) / 1000];   // setup mm -> world m
    const W = S.weapon || {};
    const wheels = st.wheels || [];
    // shadow
    ctx.save(); ctx.globalAlpha = 0.35; ctx.fillStyle = "#000"; poly(ctx, { X: x => V.X(x) + 3, Y: y => V.Y(y) + 4 }, S.body.pts.map(p => tr(p[0], p[1]))); ctx.fill(); ctx.restore();
    // weapon under the chassis (an undercutter) or over (others)
    const drawWeapon = () => {
      if (!W.type || W.type === "none") return;
      const [cx, cy] = tr(W.x, W.y), r = W.d / 2000, k = V.k;
      if (W.type === "horizontal") {
        const fast = Math.abs(st.ww) > 60;
        ctx.save(); ctx.translate(V.X(cx), V.Y(cy)); ctx.rotate(-(st.psi + (W.dir || 1) * st.wangle));
        if (fast) {                                    // a blur disc, brighter with speed
          const f = Math.min(1, Math.abs(st.ww) / 1300);
          ctx.fillStyle = `rgba(200,208,220,${0.12 + 0.25 * f})`; ctx.beginPath(); ctx.arc(0, 0, r * k, 0, 7); ctx.fill();
          ctx.strokeStyle = `rgba(229,56,59,${0.3 + 0.6 * f})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, r * k, 0, 7); ctx.stroke();
        }
        ctx.globalAlpha = fast ? 0.45 : 1;
        ctx.fillStyle = "#b9c0cb"; ctx.strokeStyle = "#5d6878"; ctx.lineWidth = 1;
        if (W.shape === "bar") { const t = Math.max((W.blade_w || 30) / 2000 * k, 2); ctx.beginPath(); ctx.rect(-r * k, -t, 2 * r * k, 2 * t); ctx.fill(); ctx.stroke(); }
        else { ctx.beginPath(); ctx.arc(0, 0, r * k, 0, 7); if (W.shape === "ring") { ctx.arc(0, 0, r * k * 0.82, 0, 7, true); } ctx.fill(); ctx.stroke(); }
        ctx.globalAlpha = 1;
        // the teeth
        const n = W.teeth || 2;
        for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; ctx.fillStyle = C.red; ctx.beginPath(); ctx.arc(Math.cos(a) * r * k * 0.95, Math.sin(a) * r * k * 0.95, Math.max(2.5, 0.006 * k), 0, 7); ctx.fill(); }
        ctx.restore();
      } else {
        const t = (W.thick || 10) / 2;
        const pts = [[W.x - W.d / 2, W.y - t], [W.x + W.d / 2, W.y - t], [W.x + W.d / 2, W.y + t], [W.x - W.d / 2, W.y + t]].map(p => tr(p[0], p[1]));
        const f = Math.min(1, Math.abs(st.ww) / 900);
        poly(ctx, V, pts); ctx.fillStyle = `rgb(${150 + 90 * f},${160 - 100 * f},${170 - 110 * f})`; ctx.fill();
        ctx.strokeStyle = "#5d6878"; ctx.lineWidth = 1; ctx.stroke();
        // stripes that move with the spin (slowed so they read)
        const ph = ((st.wangle * 0.02) % 1 + 1) % 1;
        ctx.strokeStyle = "rgba(10,12,16,0.55)"; ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) { const u = W.x - W.d / 2 + ((i + ph) / 6) * W.d; const a = tr(u, W.y - t), b = tr(u, W.y + t); ctx.beginPath(); ctx.moveTo(V.X(a[0]), V.Y(a[1])); ctx.lineTo(V.X(b[0]), V.Y(b[1])); ctx.stroke(); }
      }
    };
    if (W.type === "horizontal" && W.under !== false) drawWeapon();
    // wheels
    S.wheels.forEach((q, i) => {
      const L = q.d / 2, ww2 = (q.w || 16) / 2;
      const pts = [[q.x - L, q.y - ww2], [q.x + L, q.y - ww2], [q.x + L, q.y + ww2], [q.x - L, q.y + ww2]].map(p => tr(p[0], p[1]));
      poly(ctx, V, pts); ctx.fillStyle = C.wheel; ctx.fill();
      const ld = wheels[i];
      const slip = ld ? ld.slip : 0, lifted = ld && ld.N <= 1e-6;
      ctx.strokeStyle = lifted ? C.amber : (slip > 0.25 ? C.red : C.tread); ctx.lineWidth = lifted ? 2 : 1.4; ctx.stroke();
      // tread marks rolling with the wheel
      const g = R && st.groups ? st.groups[R._wg ? R._wg[i] : i] || 0 : 0;
      const ph = ((g * (q.d / 2000) / 0.012 * 0.02) % 1 + 1) % 1;
      ctx.strokeStyle = "rgba(120,128,140,0.5)"; ctx.lineWidth = 1;
      for (let j = 0; j < 4; j++) { const u = q.x - L + ((j + ph) / 4) * 2 * L; const a = tr(u, q.y - ww2), b = tr(u, q.y + ww2); ctx.beginPath(); ctx.moveTo(V.X(a[0]), V.Y(a[1])); ctx.lineTo(V.X(b[0]), V.Y(b[1])); ctx.stroke(); }
    });
    // chassis
    poly(ctx, V, S.body.pts.map(p => tr(p[0], p[1])));
    ctx.fillStyle = S.color || C.chassis; ctx.fill(); ctx.strokeStyle = S.edge || "#2a2f3a"; ctx.lineWidth = 1.5; ctx.stroke();
    if (S.topPlate !== false) {                          // a lighter top plate, inset
      const cxm = S.body.pts.reduce((a, p) => a + p[0], 0) / S.body.pts.length, cym = S.body.pts.reduce((a, p) => a + p[1], 0) / S.body.pts.length;
      poly(ctx, V, S.body.pts.map(p => tr(cxm + 0.78 * (p[0] - cxm), cym + 0.78 * (p[1] - cym))));
      ctx.fillStyle = S.top || C.top; ctx.globalAlpha = 0.92; ctx.fill(); ctx.globalAlpha = 1;
      // the forward arrow
      const a = tr(cxm + 10, cym), b = tr(cxm + 32, cym);
      ctx.strokeStyle = C.red; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(V.X(a[0]), V.Y(a[1])); ctx.lineTo(V.X(b[0]), V.Y(b[1])); ctx.stroke();
      const h1 = tr(cxm + 24, cym + 6), h2 = tr(cxm + 24, cym - 6);
      ctx.beginPath(); ctx.moveTo(V.X(h1[0]), V.Y(h1[1])); ctx.lineTo(V.X(b[0]), V.Y(b[1])); ctx.lineTo(V.X(h2[0]), V.Y(h2[1])); ctx.stroke();
    }
    if (W.type !== "horizontal" || W.under === false) drawWeapon();
    // skids and the COG
    (S.skids || []).forEach((q, i) => {
      const [x, y] = tr(q.x, q.y), ld = (st.N || [])[S.wheels.length + i];
      ctx.fillStyle = ld !== undefined && ld <= 1e-6 ? C.amber : C.skid; ctx.beginPath(); ctx.arc(V.X(x), V.Y(y), Math.max(2.5, 0.005 * V.k), 0, 7); ctx.fill();
    });
    if (opts && opts.cog) {
      const [x, y] = tr(S.cog.x, S.cog.y), r = Math.max(4, 0.008 * V.k);
      ctx.save(); ctx.translate(V.X(x), V.Y(y));
      ctx.fillStyle = "#111"; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
      ctx.fillStyle = C.cog; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, 0, Math.PI / 2); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, Math.PI, 1.5 * Math.PI); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = C.cog; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.stroke(); ctx.restore();
    }
  }

  function drawTarget(ctx, V, T) {
    if (!T) return;
    const cs = Math.cos(T.psi), sn = Math.sin(T.psi), a = T.a / 2, b = T.b / 2;
    const pts = [[-a, -b], [a, -b], [a, b], [-a, b]].map(([x, y]) => [T.x + cs * x - sn * y, T.y + sn * x + cs * y]);
    poly(ctx, V, pts); ctx.fillStyle = C.target; ctx.fill(); ctx.strokeStyle = "#8a93a3"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = "#cfd5de"; ctx.font = "10px 'IBM Plex Mono', monospace"; ctx.textAlign = "center";
    ctx.fillText("target", V.X(T.x), V.Y(T.y) + 3); ctx.textAlign = "left";
  }

  function drawTrail(ctx, V, trail, vmax) {
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1], b = trail[i], f = Math.min(1, b[2] / Math.max(vmax, 0.1));
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.3) continue;       // a jump (reset): no line across the arena
      ctx.strokeStyle = `rgba(${78 + 160 * f},${168 - 110 * f},${222 - 160 * f},${0.15 + 0.5 * (i / trail.length)})`;
      ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(V.X(a[0]), V.Y(a[1])); ctx.lineTo(V.X(b[0]), V.Y(b[1])); ctx.stroke();
    }
  }

  function drawHits(ctx, V, hits, t) {
    for (const hh of hits) {
      const age = t - hh.t; if (age > 1.2) continue;
      const f = 1 - age / 1.2;
      ctx.strokeStyle = `rgba(242,165,65,${f})`; ctx.lineWidth = 2;
      for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4 + hh.t * 13, r0 = 6 + 30 * (1 - f), r1 = r0 + 10 * f;
        ctx.beginPath(); ctx.moveTo(V.X(hh.x) + Math.cos(a) * r0, V.Y(hh.y) + Math.sin(a) * r0); ctx.lineTo(V.X(hh.x) + Math.cos(a) * r1, V.Y(hh.y) + Math.sin(a) * r1); ctx.stroke(); }
      ctx.fillStyle = `rgba(255,236,200,${f})`; ctx.font = "bold 14px 'IBM Plex Mono', monospace";
      ctx.fillText(`${hh.dE.toFixed(0)} J`, V.X(hh.x) + 10, V.Y(hh.y) - 10 - 20 * (1 - f));
    }
  }

  // the setup screen's top view: the robot alone, big, with dimensions and labels
  function drawSetupView(cv, S, R) {
    const ctx = cv.getContext("2d"), w = cv.width, h = cv.height;
    ctx.fillStyle = "#0d1118"; ctx.fillRect(0, 0, w, h);
    const xs = [], ys = [];
    S.body.pts.forEach(p => { xs.push(p[0]); ys.push(p[1]); });
    S.wheels.forEach(q => { xs.push(q.x - q.d / 2, q.x + q.d / 2); ys.push(q.y - 10, q.y + 10); });
    (S.skids || []).forEach(q => { xs.push(q.x); ys.push(q.y); });
    const W = S.weapon || {};
    if (W.type && W.type !== "none") { xs.push(W.x - W.d / 2, W.x + W.d / 2); ys.push(W.y - (W.type === "horizontal" ? W.d / 2 : (W.thick || 10) / 2), W.y + (W.type === "horizontal" ? W.d / 2 : (W.thick || 10) / 2)); }
    xs.push(0); ys.push(0);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const k = Math.min((h - 50) / (x1 - x0 || 1), (w - 50) / (y1 - y0 || 1)) * 1000;
    const mx = (x0 + x1) / 2000, my = (y0 + y1) / 2000;
    // forward is up: setup x (forward) -> screen up, setup y (left) -> screen left
    const sw = { X: y => w / 2 - (y / 1000 - my) * k, Y: x => h / 2 - (x / 1000 - mx) * k };
    for (let v = -400; v <= 400; v += 10) {
      ctx.strokeStyle = v % 50 === 0 ? "#1f2733" : "#141a23";
      ctx.beginPath(); ctx.moveTo(sw.X(v), 0); ctx.lineTo(sw.X(v), h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, sw.Y(v)); ctx.lineTo(w, sw.Y(v)); ctx.stroke();
    }
    const st = { x: 0, y: 0, psi: 0, ww: 0, wangle: 0.4, wheels: [], N: [], groups: [] };
    st.psi = Math.PI / 2;
    const Vf = { k, X: x => w / 2 + (x + my) * k, Y: y => h / 2 - (y - mx) * k };
    drawRobot(ctx, Vf, S, R, st, { cog: true });
    const W2 = S.weapon || {};
    if (W2.type === "horizontal") {                       // the blade's reach
      ctx.strokeStyle = "rgba(229,56,59,0.8)"; ctx.setLineDash([10, 8]); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(Vf.X(-W2.y / 1000), Vf.Y(W2.x / 1000), W2.d / 2000 * k, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    }
    const F = Math.max(11, Math.round(w / 52));
    ctx.font = `${F}px 'IBM Plex Mono', monospace`;
    S.wheels.forEach((q, i) => { ctx.fillStyle = "#9aa6b8"; ctx.fillText(`W${i + 1}`, Vf.X(-q.y / 1000) + (q.y > 0 ? -2.6 * F : 0.8 * F), Vf.Y(q.x / 1000) + F / 3); });
    (S.skids || []).forEach((q, i) => { ctx.fillStyle = "#c0c7d2"; ctx.fillText(`S${i + 1}`, Vf.X(-q.y / 1000) + 0.6 * F, Vf.Y(q.x / 1000) - 0.4 * F); });
    // origin
    ctx.strokeStyle = "#4ea8de"; ctx.lineWidth = 1.5; const ox = Vf.X(0), oy = Vf.Y(0);
    ctx.beginPath(); ctx.moveTo(ox - 8, oy); ctx.lineTo(ox + 8, oy); ctx.moveTo(ox, oy - 8); ctx.lineTo(ox, oy + 8); ctx.stroke();
    ctx.fillStyle = "#4ea8de"; ctx.fillText("0,0", ox + 0.6 * F, oy + 1.4 * F);
    // labels
    ctx.fillStyle = "#9aa6b8"; ctx.fillText("forward ↑   x forward, y left, mm from 0,0   grid 10 mm", 0.8 * F, 1.5 * F);
    ctx.fillStyle = C.cog; const g = [Vf.X(-S.cog.y / 1000), Vf.Y(S.cog.x / 1000)]; ctx.fillText("COG", g[0] + 0.9 * F, g[1] - 0.7 * F);
  }

  const api = { C, view, drawArena, drawRobot, drawTarget, drawTrail, drawHits, drawSetupView, poly };
  root.RDS = root.RDS || {}; root.RDS.render = api;
})(typeof window !== "undefined" ? window : globalThis);

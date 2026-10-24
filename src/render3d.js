/* RoborDriveSim 3D view (three.js): the arena, the robot built from its setup, the target, the path, hits, and the
 * cameras: chase (behind the robot), top (above it), arena (the whole cage) and orbit (drag to turn around it). */
(function (root) {
  "use strict";
  const T = root.THREE;
  const COL = { bg: 0x07090d, floor: 0x262a31, grid: 0x343a45, grid4: 0x4a5262, wall: 0x9fb3c8, skirt: 0x4a3a28,
                chassis: 0x101216, top: 0xe9e6e1, wheel: 0x15171c, tire: 0x23262d, metal: 0xb9c0cb, red: 0xe5383b, cog: 0xf2a541,
                target: 0x5d6470, skid: 0xc0c7d2 };

  class View {
    constructor(canvas) {
      this.r = new T.WebGLRenderer({ canvas, antialias: true });
      this.r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.r.shadowMap.enabled = true; this.r.shadowMap.type = T.PCFSoftShadowMap;
      this.scene = new T.Scene(); this.scene.background = new T.Color(COL.bg);
      this.cam = new T.PerspectiveCamera(55, 1, 0.005, 60); this.cam.up.set(0, 0, 1);
      const hemi = new T.HemisphereLight(0xdfe8f5, 0x20242c, 0.75); this.scene.add(hemi);
      const sun = new T.DirectionalLight(0xffffff, 0.9); sun.position.set(-1.5, -2.2, 4); sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048); const sc = sun.shadow.camera; sc.left = sc.bottom = -3; sc.right = sc.top = 3; sc.near = 0.5; sc.far = 10;
      this.sun = sun; this.scene.add(sun); this.scene.add(sun.target);
      this.mode = "chase"; this.dist = 0.9; this.orbit = { az: -2.2, el: 0.5 }; this.camYaw = null;
      this.trailMax = 600; this.trail = []; this.sparks = [];
      this._drag(canvas);
    }
    _drag(cv) {
      let down = null;
      cv.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY, this.orbit.az, this.orbit.el]; cv.setPointerCapture(e.pointerId); });
      cv.addEventListener("pointermove", e => {
        if (!down) return;
        if (this.mode !== "orbit") { this.mode = "orbit"; this.onMode && this.onMode(this.mode); }
        this.orbit.az = down[2] - (e.clientX - down[0]) * 0.008; this.orbit.el = Math.max(0.05, Math.min(1.5, down[3] + (e.clientY - down[1]) * 0.006));
      });
      cv.addEventListener("pointerup", () => { down = null; });
      cv.addEventListener("wheel", e => { e.preventDefault(); this.dist = Math.max(0.2, Math.min(6, this.dist * Math.exp(e.deltaY * 0.0012))); }, { passive: false });
    }
    resize(w, h) { this.r.setSize(w, h, false); this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); }

    // ---------------------------------------------------------------- arena
    arena(size, ceiling) {
      if (this.arenaG) this.scene.remove(this.arenaG);
      const g = new T.Group(); this.arenaG = g; this.size = size;
      const S = size > 0 ? size : 8;
      const floor = new T.Mesh(new T.PlaneGeometry(S, S), new T.MeshStandardMaterial({ color: COL.floor, roughness: 0.95 }));
      floor.receiveShadow = true; g.add(floor);
      // one-foot grid
      const pts = [], pts4 = [], H = S / 2, ft = 0.3048;
      for (let i = 0; i * ft <= S + 1e-9; i++) {
        const v = -H + i * ft, arr = i % 4 === 0 ? pts4 : pts;
        arr.push(v, -H, 0.0005, v, H, 0.0005, -H, v, 0.0005, H, v, 0.0005);
      }
      for (const [arr, c] of [[pts, COL.grid], [pts4, COL.grid4]]) {
        const geo = new T.BufferGeometry(); geo.setAttribute("position", new T.Float32BufferAttribute(arr, 3));
        g.add(new T.LineSegments(geo, new T.LineBasicMaterial({ color: c })));
      }
      if (size > 0) {
        // skirt strip and see-through walls (lexan); the camera sees through them
        const skirt = new T.MeshStandardMaterial({ color: COL.skirt, roughness: 0.9 });
        const wallM = new T.MeshPhysicalMaterial({ color: COL.wall, transparent: true, opacity: 0.12, roughness: 0.1, depthWrite: false, side: T.DoubleSide });
        const edgeM = new T.LineBasicMaterial({ color: COL.wall, transparent: true, opacity: 0.6 });
        const wh = ceiling > 0 ? ceiling : 0.6;
        for (const [x, y, w, d] of [[0, H, S, 0.02], [0, -H, S, 0.02], [H, 0, 0.02, S], [-H, 0, 0.02, S]]) {
          const sk = new T.Mesh(new T.BoxGeometry(w + 0.04, d + 0.04, 0.012), skirt); sk.position.set(x, y, 0.006); sk.receiveShadow = true; g.add(sk);
          const wall = new T.Mesh(new T.BoxGeometry(w, d, wh), wallM); wall.position.set(x, y, wh / 2); g.add(wall);
          const eg = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(w, d, wh)), edgeM); eg.position.copy(wall.position); g.add(eg);
        }
      }
      this.scene.add(g);
    }

    // ---------------------------------------------------------------- robot
    robot(S, R) {
      if (this.robotG) this.scene.remove(this.robotG);
      const g = new T.Group(); this.robotG = g;
      const mm = v => v / 1000;
      const z0 = mm(S.body.z0 !== undefined ? S.body.z0 : 5), z1 = mm(S.body.z1 !== undefined ? S.body.z1 : 40);
      const shape = new T.Shape(S.body.pts.map(p => new T.Vector2(mm(p[0]), mm(p[1]))));
      const body = new T.Mesh(new T.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0015, bevelSegments: 1 }),
                              new T.MeshStandardMaterial({ color: S.color || COL.chassis, roughness: 0.6, metalness: 0.2 }));
      body.position.z = z0; body.castShadow = true; body.receiveShadow = true; g.add(body);
      // top plate
      const cx = S.body.pts.reduce((a, p) => a + p[0], 0) / S.body.pts.length, cy = S.body.pts.reduce((a, p) => a + p[1], 0) / S.body.pts.length;
      const inset = new T.Shape(S.body.pts.map(p => new T.Vector2(mm(cx + 0.86 * (p[0] - cx)), mm(cy + 0.86 * (p[1] - cy)))));
      const top = new T.Mesh(new T.ShapeGeometry(inset), new T.MeshStandardMaterial({ color: S.top || COL.top, roughness: 0.8 }));
      top.position.z = z1 + 0.0016; g.add(top);
      // the forward arrow on the top
      const arrow = new T.Mesh(new T.ShapeGeometry(new T.Shape([new T.Vector2(mm(cx + 32), mm(cy)), new T.Vector2(mm(cx + 6), mm(cy + 12)), new T.Vector2(mm(cx + 6), mm(cy - 12))])),
                               new T.MeshBasicMaterial({ color: COL.red }));
      arrow.position.z = z1 + 0.0019; g.add(arrow);
      // wheels (cylinder axis is y in three.js, as the axle)
      this.wheelMeshes = S.wheels.map(q => {
        const r = mm(q.d / 2), w = mm(q.w || 16), wg = new T.Group();
        const tread = this._treadTex();
        const tire = new T.Mesh(new T.CylinderGeometry(r, r, w, 32, 1, false), [new T.MeshStandardMaterial({ map: tread, roughness: 0.9 }),
          new T.MeshStandardMaterial({ color: COL.wheel, roughness: 0.7 }), new T.MeshStandardMaterial({ color: COL.wheel, roughness: 0.7 })]);
        tire.castShadow = true; wg.add(tire);
        const hub = new T.Mesh(new T.CylinderGeometry(r * 0.45, r * 0.45, w * 1.04, 16), new T.MeshStandardMaterial({ color: q.driven ? 0x3a3f4a : 0x5d6878, metalness: 0.5, roughness: 0.4 }));
        wg.add(hub);
        // a spoke so turning shows
        const spoke = new T.Mesh(new T.BoxGeometry(r * 1.6, w * 1.06, r * 0.18), new T.MeshStandardMaterial({ color: COL.red }));
        wg.add(spoke);
        wg.position.set(mm(q.x), mm(q.y), r); g.add(wg);
        return { g: wg, tire, angle: 0 };
      });
      // skids
      for (const q of S.skids || []) {
        const m = new T.Mesh(new T.SphereGeometry(0.0045, 12, 8), new T.MeshStandardMaterial({ color: COL.skid, metalness: 0.8, roughness: 0.3 }));
        m.position.set(mm(q.x), mm(q.y), 0.0045 + mm(q.gap || 0)); g.add(m);
      }
      // weapon
      const W = S.weapon || {};
      this.weapon = null;
      if (W.type && W.type !== "none") {
        const wg = new T.Group(), spin = new T.Group(), r = mm(W.d / 2), t = mm(W.thick || 8);
        const metal = new T.MeshStandardMaterial({ color: COL.metal, metalness: 0.85, roughness: 0.28 });
        const teethM = new T.MeshStandardMaterial({ color: COL.red, metalness: 0.4, roughness: 0.4 });
        let part;
        const n = W.teeth || 2;
        if (W.type === "horizontal") {
          if (W.shape === "bar") part = new T.Mesh(new T.BoxGeometry(2 * r, mm(W.blade_w || 30), t), metal);
          else if (W.shape === "ring" || W.shape === "tube") {
            part = new T.Mesh(new T.CylinderGeometry(r, r, t, 48, 1, true), new T.MeshStandardMaterial({ color: COL.metal, metalness: 0.85, roughness: 0.28, side: T.DoubleSide }));
            part.rotation.x = Math.PI / 2;
          } else { part = new T.Mesh(new T.CylinderGeometry(r, r, t, 48), metal); part.rotation.x = Math.PI / 2; }
          for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n, tooth = new T.Mesh(new T.BoxGeometry(0.012, 0.012, t * 1.15), teethM); tooth.position.set(Math.cos(a) * r * 0.97, Math.sin(a) * r * 0.97, 0); spin.add(tooth); }
        } else {
          part = new T.Mesh(new T.CylinderGeometry(r, r, t, 48), metal);       // axis y: across the robot
          for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n, tooth = new T.Mesh(new T.BoxGeometry(0.014, t * 1.1, 0.014), teethM); tooth.position.set(Math.cos(a) * r, 0, Math.sin(a) * r); spin.add(tooth); }
        }
        part.castShadow = true; spin.add(part);
        // a blur disc when it is fast
        const blur = new T.Mesh(new T.CylinderGeometry(r * 1.02, r * 1.02, Math.max(t * 0.6, 0.002), 48), new T.MeshBasicMaterial({ color: 0xffb0a0, transparent: true, opacity: 0, depthWrite: false }));
        if (W.type === "horizontal") blur.rotation.x = Math.PI / 2;
        wg.add(spin); wg.add(blur);
        wg.position.set(mm(W.x), mm(W.y), mm(W.z !== undefined ? W.z : 15)); g.add(wg);
        this.weapon = { g: wg, spin, blur, type: W.type, dir: W.dir || 1, angle: 0 };
      }
      // COG marker
      const cog = new T.Mesh(new T.SphereGeometry(0.004, 12, 8), new T.MeshBasicMaterial({ color: COL.cog, depthTest: false }));
      cog.position.set(mm(S.cog.x), mm(S.cog.y), mm(S.cog.h)); cog.renderOrder = 5; g.add(cog); this.cogM = cog;
      g.traverse(o => { if (o.isMesh) o.castShadow = true; });
      this.scene.add(g);
    }
    _treadTex() {
      const c = document.createElement("canvas"); c.width = 128; c.height = 16; const x = c.getContext("2d");
      x.fillStyle = "#1d2026"; x.fillRect(0, 0, 128, 16); x.fillStyle = "#3b404b"; for (let i = 0; i < 16; i++) x.fillRect(i * 8, 0, 3, 16);
      const t = new T.CanvasTexture(c); t.wrapS = T.RepeatWrapping; return t;
    }

    // ---------------------------------------------------------------- target, path, hits
    target(tg) {
      if (!tg) { if (this.targetM) { this.scene.remove(this.targetM); this.targetM = null; } return; }
      if (!this.targetM || this.targetM.userData.key !== [tg.a, tg.b, tg.c].join()) {
        if (this.targetM) this.scene.remove(this.targetM);
        const m = new T.Mesh(new T.BoxGeometry(tg.a, tg.b, tg.c), new T.MeshStandardMaterial({ color: COL.target, roughness: 0.7, metalness: 0.2 }));
        const e = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(tg.a, tg.b, tg.c)), new T.LineBasicMaterial({ color: 0x9aa3b3 }));
        m.add(e); m.castShadow = true; m.receiveShadow = true; m.userData.key = [tg.a, tg.b, tg.c].join();
        this.targetM = m; this.scene.add(m);
      }
      this.targetM.position.set(...tg.p); this.targetM.quaternion.set(tg.q[1], tg.q[2], tg.q[3], tg.q[0]);
    }
    path(trail, vmax) {
      if (!this.pathL) {
        const geo = new T.BufferGeometry();
        geo.setAttribute("position", new T.BufferAttribute(new Float32Array(this.trailMax * 3), 3));
        geo.setAttribute("color", new T.BufferAttribute(new Float32Array(this.trailMax * 3), 3));
        this.pathL = new T.Line(geo, new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
        this.pathL.frustumCulled = false; this.scene.add(this.pathL);
      }
      const P = this.pathL.geometry.attributes.position.array, C = this.pathL.geometry.attributes.color.array;
      const n = Math.min(trail.length, this.trailMax);
      for (let i = 0; i < n; i++) {
        const t = trail[trail.length - n + i], f = Math.min(1, t[2] / Math.max(vmax, 0.1));
        P[3 * i] = t[0]; P[3 * i + 1] = t[1]; P[3 * i + 2] = 0.002;
        C[3 * i] = 0.3 + 0.6 * f; C[3 * i + 1] = 0.66 - 0.4 * f; C[3 * i + 2] = 0.87 - 0.6 * f;
      }
      this.pathL.geometry.setDrawRange(0, n);
      this.pathL.geometry.attributes.position.needsUpdate = true; this.pathL.geometry.attributes.color.needsUpdate = true;
    }
    spark(x, y, z) {
      const geo = new T.BufferGeometry(), N = 40, pos = new Float32Array(N * 3), vel = [];
      for (let i = 0; i < N; i++) { pos[3 * i] = x; pos[3 * i + 1] = y; pos[3 * i + 2] = z; vel.push([(Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, Math.random() * 2.5]); }
      geo.setAttribute("position", new T.BufferAttribute(pos, 3));
      const pts = new T.Points(geo, new T.PointsMaterial({ color: 0xffc46a, size: 0.012, transparent: true, opacity: 1 }));
      this.scene.add(pts); this.sparks.push({ pts, vel, age: 0 });
    }

    // ---------------------------------------------------------------- each frame
    update(st, R, dtSim, dtReal) {
      const g = this.robotG; if (!g) return;
      g.position.set(st.x, st.y, st.z); g.quaternion.set(st.q[1], st.q[2], st.q[3], st.q[0]);
      // wheels: their own spin plus the chassis (drawn at the true rate up to what a screen can show)
      (this.wheelMeshes || []).forEach((w, i) => {
        const k = R._wg ? R._wg[i] : i, om = st.groups[k] || 0;
        w.angle += om * dtSim;
        w.g.rotation.y = w.angle;
        const ld = st.wheels[i]; w.tire.material[0].emissive = new T.Color(ld && ld.slip > 0.3 ? 0x5a1010 : 0x000000);
      });
      if (this.weapon) {
        const W = this.weapon, rps = st.ww / (2 * Math.PI);
        // a screen shows about 8 turns a second: faster than that it is drawn turning slower, with a blur disc
        const shown = Math.min(rps, 8) * 2 * Math.PI;
        W.angle += shown * dtReal * W.dir;
        if (W.type === "horizontal") W.spin.rotation.z = W.angle; else W.spin.rotation.y = -W.angle;
        const f = Math.min(1, Math.max(0, (rps - 8) / 120));
        W.blur.material.opacity = 0.32 * f; W.spin.children.forEach(c => { if (c.material) { c.material.transparent = true; c.material.opacity = 1 - 0.55 * f; } });
      }
      for (const s of this.sparks) {
        s.age += dtReal; const a = s.pts.geometry.attributes.position.array;
        for (let i = 0; i < s.vel.length; i++) { s.vel[i][2] -= 9.8 * dtReal * 0.3; a[3 * i] += s.vel[i][0] * dtReal * 0.3; a[3 * i + 1] += s.vel[i][1] * dtReal * 0.3; a[3 * i + 2] = Math.max(0.001, a[3 * i + 2] + s.vel[i][2] * dtReal * 0.3); }
        s.pts.geometry.attributes.position.needsUpdate = true; s.pts.material.opacity = Math.max(0, 1 - s.age / 0.9);
      }
      this.sparks = this.sparks.filter(s => { if (s.age > 0.9) { this.scene.remove(s.pts); return false; } return true; });
      this.camera(st, dtReal);
      this.sun.position.set(st.xcog - 1.5, st.ycog - 2.2, 4); this.sun.target.position.set(st.xcog, st.ycog, 0);
    }
    camera(st, dt) {
      const c = this.cam, tgt = new T.Vector3(st.xcog, st.ycog, Math.max(st.zcog, 0.02));
      if (this.mode === "arena") {
        const S = this.size > 0 ? this.size : 3;
        c.position.set(-0.05 * S, -0.95 * S, 0.85 * S); c.lookAt(0, -0.05 * S, 0); return;
      }
      if (this.mode === "top") { c.position.set(tgt.x, tgt.y - 0.001, tgt.z + this.dist * 1.6); c.lookAt(tgt); return; }
      if (this.mode === "orbit") {
        const o = this.orbit, d = this.dist;
        c.position.set(tgt.x + d * Math.cos(o.el) * Math.cos(o.az), tgt.y + d * Math.cos(o.el) * Math.sin(o.az), tgt.z + d * Math.sin(o.el)); c.lookAt(tgt); return;
      }
      // chase: behind the heading, easing round (so a spin does not whip the view)
      const want = st.psi;
      if (this.camYaw === null) this.camYaw = want;
      let d = want - this.camYaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      this.camYaw += d * Math.min(1, dt * 3.5);
      const D = this.dist, back = D * 0.92, up = D * 0.42;
      let px = tgt.x - back * Math.cos(this.camYaw), py = tgt.y - back * Math.sin(this.camYaw);
      // stay inside the cage so the walls do not block the view
      if (this.size > 0) { const H = this.size / 2 - 0.05; px = Math.max(-H, Math.min(H, px)); py = Math.max(-H, Math.min(H, py)); }
      c.position.set(px, py, tgt.z + up); c.lookAt(tgt.x, tgt.y, tgt.z + 0.02);
    }
    render() { this.r.render(this.scene, this.cam); }
    project(x, y, z, w, h) { const v = new T.Vector3(x, y, z).project(this.cam); return [(v.x + 1) / 2 * w, (1 - v.y) / 2 * h, v.z < 1]; }
  }
  root.RDS = root.RDS || {}; root.RDS.View = View;
})(typeof window !== "undefined" ? window : globalThis);

"""Writes src/motors.js from tools/motor_catalog.json (Repeat Robotics and Just 'Cuz Robotics, read off their stores
on 2026-10-24). Each preset gets what the simulator needs; where the vendor gives no number, it is estimated by a
stated rule and marked so in the label and in `src`:

  brushed:   kv and R from the free speed and stall current at 12 V (Ke = V / free motor speed, R = V / I_stall);
             gearbox efficiency from the stall torque (eta = T_stall / (G Ke I_stall)), capped at 0.92
  brushless: R as published (Just 'Cuz), else scaled from Flapjack's Compact 1806 (2300 KV, 0.15 ohm) as
             R kv^2 inversely proportional to the stator volume (about +/- 2x); rotor inertia likewise from the 1806
             (8e-7 kg m^2) as (stator diameter + 6 mm)^4 x height
  gearbox:   0.82 up to 30:1, 0.75 at about 50:1, 0.65 past 100:1 (estimates)
  tangent:   a motor pressing on the wheel: the ratio is wheel diameter / roller diameter (the motor shaft)
Run: python tools/build_motors.py
"""
import json, math, os, re
HERE = os.path.dirname(os.path.abspath(__file__))
D = json.load(open(os.path.join(HERE, "motor_catalog.json")))
STATOR = {  # stator diameter x height, mm (from the size name; can-size names converted, estimates)
    "1106": (11, 6), "1406": (14, 6), "1604": (16, 4), "1806": (18, 6), "2004": (20, 4), "2006": (20, 6), "2207.5": (22, 7.5),
    "2305": (23, 5), "2306": (23, 6), "2306.5": (23, 6.5), "2812": (28, 12), "2822": (22, 10), "2830": (22, 14), "2836": (22, 18),
    "3536": (28, 18), "3520": (28, 10), "2222": (22, 22), "~28x12mm": (28, 12), "~22x6mm": (22, 6), "~40x12mm": (40, 12),
}
A_RKV2 = 0.15 * 2300 ** 2 * (18 ** 2 * 6)        # R kv^2 x stator volume, from the 1806
def stator(rec):
    s = str(rec.get("stator") or "")
    for k in sorted(STATOR, key=len, reverse=True):
        if k in s: return STATOR[k]
    m = re.search(r"(\d{4})", rec["name"]); return STATOR.get(m.group(1)) if m else None
def num(x):
    m = re.search(r"[\d.]+", str(x)); return float(m.group()) if m else None
def at12(field):                                    # the value quoted at 12 V
    m = re.search(r"([\d.]+)\s*(?:A|rpm)?[^;]*?@\s*12", str(field)); return float(m.group(1)) if m else num(field)
def torque_Nm(t):
    t = str(t); v = num(t)
    if v is None: return None
    if "kg" in t: return v * 0.0980665
    if "g·cm" in t or "g cm" in t: return v * 9.80665e-5
    if "ozf" in t or "oz" in t: return v * 0.00706155
    if "Nm" in t: return v
    return None
def gear(g):
    v = num(g); return v if v and v > 1 else None

drive, weapon = [], []
for r in D:
    name, vend = r["name"], ("Repeat" if r["vendor"].startswith("Repeat") else "Just 'Cuz")
    low = name.lower()
    if "gearbox only" in low or "gearbox (no motor)" in low or "(no motor)" in low or "replacement" in low or "motor only" in low:
        continue                                      # parts: their ratios are in the gearmotors
    if r["use"] == "drive":
        G = gear(r["gear"]); tangent = "tangent" in low or (G is None and r["kv"])
        if "brushed" in str(r["stator"]).lower() or (r["kv"] is None and G):
            rpm = at12(r["rpm_out"]); I = at12(r["I_max_A"]); T = torque_Nm(r["torque"])
            if not (rpm and I and G): continue
            Ke = 12.0 / (rpm * G * 2 * math.pi / 60); R = 12.0 / I; kv = 60 / (2 * math.pi * Ke)
            eta = min(0.92, T / (G * Ke * I)) if T else 0.7
            drive.append(dict(vendor=vend, name=name, kv=round(kv), R=round(R, 3), G=G, eta=round(eta, 2), Jrot=3e-7,
                              src="brushed: kv and R from free speed and stall current at 12 V" + ("; efficiency from stall torque" if T else "; efficiency estimated"), url=r["url"], mass_g=r["mass_g"], free_rpm_12V=rpm))
            continue
        kv = r["kv"]; st = stator(r)
        if not kv: continue
        if r["R_ohm"]: R, rs = r["R_ohm"], "R published"
        else:
            R = A_RKV2 / (kv ** 2 * (st[0] ** 2 * st[1])) if st else 0.15 * (2300 / kv) ** 2; rs = "R estimated (about +/- 2x)"
        J = 8e-7 * ((st[0] + 6) / 24) ** 4 * (st[1] / 6) if st else 8e-7
        if tangent:
            m = re.search(r"(\d+(?:\.\d+)?)\s*mm", str(r.get("shaft_mm") or "")) ; td = r.get("shaft_mm") if isinstance(r.get("shaft_mm"), (int, float)) else (float(m.group(1)) if m else 5)
            drive.append(dict(vendor=vend, name=name, kv=kv, R=round(R, 4), G=1, eta=0.85, Jrot=J, tangent_d=td, src=rs + "; tangent: ratio = wheel / roller diameter", url=r["url"], mass_g=r["mass_g"]))
        else:
            eta = 0.82 if G <= 30 else (0.75 if G <= 60 else 0.65)
            drive.append(dict(vendor=vend, name=name, kv=kv, R=round(R, 4), G=G, eta=eta, Jrot=J, src=rs + "; gearbox efficiency estimated", url=r["url"], mass_g=r["mass_g"]))
    else:
        kv = r["kv"]; st = stator(r)
        if not kv: continue
        if r["R_ohm"]: R, rs = r["R_ohm"], "R published"
        elif "RDY-5022" in str(r.get("stator")) and kv == 1700: R, rs = 0.151, "R published for the RDY-MINI-5022 1700 KV (same internals)"
        else: R = A_RKV2 / (kv ** 2 * (st[0] ** 2 * st[1])) if st else 0.05; rs = "R estimated (about +/- 2x)"
        weapon.append(dict(vendor=vend, name=name, kv=kv, R=round(R, 4), src=rs, url=r["url"], mass_g=r["mass_g"]))

def key(p): return re.sub(r"[^a-z0-9]+", "_", (p["vendor"][:3] + "_" + p["name"]).lower()).strip("_")[:48]
def label(p, kind):
    est = " (R est.)" if "R estimated" in p["src"] else ""
    if kind == "drive":
        ratio = "tangent" if p.get("tangent_d") else f"{p['G']:g}:1"
        return f"{p['name']} · {p['kv']} KV · {ratio}{est}"
    return f"{p['name']} · {p['kv']} KV{est}"
out = {"drive": {}, "weapon": {}}
for kind, L in (("drive", drive), ("weapon", weapon)):
    for p in L:
        k = key(p); p["label"] = label(p, kind); p["group"] = p["vendor"]; out[kind][k] = p
js = ("/* Motor presets from the Repeat Robotics and Just 'Cuz Robotics stores (read 2026-10-24), written by\n"
      " * tools/build_motors.py from tools/motor_catalog.json. Values not published are estimated by the rules in that\n"
      " * script; each preset's `src` says which. Do not edit by hand: rerun the script. */\n"
      "(function (root) {\n  \"use strict\";\n  const M = " + json.dumps(out, indent=1) + ";\n"
      "  if (typeof module !== \"undefined\" && module.exports) module.exports = M;\n"
      "  else { root.RDS = root.RDS || {}; root.RDS.motors = M; }\n})(typeof window !== \"undefined\" ? window : globalThis);\n")
open(os.path.join(HERE, "..", "src", "motors.js"), "w").write(js)
print(len(out["drive"]), "drive,", len(out["weapon"]), "weapon presets")
for k, p in list(out["drive"].items()) + list(out["weapon"].items()): print(f"  {p['label']}  R={p['R']}  {p.get('eta','')}")

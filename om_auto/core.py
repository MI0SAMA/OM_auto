"""Geometry, reproducible sampling, and descriptive electrical statistics."""

from collections import Counter, defaultdict
from math import pi, sqrt
import random
import statistics


STATUSES = {"valid", "no_response", "breakdown", "leakage", "test_error"}


def pad_area(shape, width_um=None, height_um=None, diameter_um=None):
    if shape == "circle" and diameter_um and diameter_um > 0:
        return pi * (diameter_um / 2) ** 2
    if shape == "square" and width_um and width_um > 0:
        return width_um * (height_um or width_um)
    if shape == "other" and width_um and height_um and width_um > 0 and height_um > 0:
        return width_um * height_um
    return None


def geometry_groups(pads, tolerance=0.08):
    """Cluster by shape and both dimensions; never group unknown sizes."""
    if not 0 <= tolerance < 0.5:
        raise ValueError("尺寸容差须在 0 到 0.5 之间")
    groups = []
    for pad in sorted(pads, key=lambda p: (p["shape"], p.get("diameter_um") or p.get("width_um") or 0,
                                             p.get("height_um") or 0, p["pad_id"])):
        shape = pad["shape"]
        dims = ((pad.get("diameter_um"),) if shape == "circle" else
                (pad.get("width_um"), pad.get("height_um") or pad.get("width_um")))
        if any(v is None or v <= 0 for v in dims):
            continue
        group = next((g for g in groups if g["shape"] == shape and
                      all(abs(a - b) <= tolerance * b for a, b in zip(dims, g["dimensions_um"]))), None)
        if group is None:
            group = {"id": f"G{len(groups)+1:03d}", "shape": shape,
                     "dimensions_um": dims, "pads": [], "regions": set(), "units": set()}
            groups.append(group)
        group["pads"].append(pad)
        group["regions"].add(pad["region_id"])
        group["units"].add((pad["region_id"], pad["layout_unit_id"]))
    return [{"id": g["id"], "shape": g["shape"], "dimensions_um": list(g["dimensions_um"]),
             "pad_ids": [p["pad_id"] for p in g["pads"]], "total": len(g["pads"]),
             "available": sum(not p.get("tested") and p.get("usable", True) for p in g["pads"]),
             "tested": sum(bool(p.get("tested")) for p in g["pads"]),
             "regions": sorted(g["regions"]), "unit_count": len(g["units"])} for g in groups]


def stratified_sample(pads, group_pad_ids, regions, count, seed, include_layout_only=False):
    """Balanced region allocation, then spread over distinct units and positions."""
    if count < 1 or not regions:
        raise ValueError("须选择区域和正整数测点数")
    regions = sorted(set(regions))
    ids = set(group_pad_ids)
    pool = {r: [p for p in pads if p["pad_id"] in ids and p["region_id"] == r
                and p.get("usable", True) and not p.get("tested")
                and (include_layout_only or p.get("area_confidence") != "layout_only")]
            for r in regions}
    missing = [r for r in regions if not pool[r]]
    if missing:
        raise ValueError("所选区域没有可用 Pad: " + ", ".join(missing))
    if count > sum(map(len, pool.values())):
        raise ValueError("可用 Pad 不足；所选区域合计只有 %d 个" % sum(map(len, pool.values())))
    rng = random.Random(seed)
    allocation = {r: 0 for r in regions}
    for _ in range(count):
        eligible = [r for r in regions if allocation[r] < len(pool[r])]
        r = min(eligible, key=lambda x: (allocation[x], rng.random()))
        allocation[r] += 1
    selected = []
    for r in regions:
        remaining = pool[r][:]
        chosen = []
        while len(chosen) < allocation[r]:
            used_units = {p["layout_unit_id"] for p in chosen}
            unused = [p for p in remaining if p["layout_unit_id"] not in used_units]
            options = unused or remaining
            if chosen:
                if all(p.get("x") is not None and p.get("y") is not None for p in options + chosen):
                    point = lambda p: (p["x"], p["y"])
                elif all(p.get("unit_row") is not None and p.get("unit_col") is not None for p in options + chosen):
                    point = lambda p: (p["unit_col"], p["unit_row"])
                else:
                    point = None
            else:
                point = None
            if point:
                distances = [(min((point(p)[0]-point(q)[0])**2 + (point(p)[1]-point(q)[1])**2
                                  for q in chosen), p) for p in options]
                best = max(d for d, _ in distances)
                options = [p for d, p in distances if d == best]
            pick = rng.choice(sorted(options, key=lambda p: p["pad_id"]))
            chosen.append(pick)
            remaining.remove(pick)
        selected.extend(chosen)
    return selected, allocation


def wilson(successes, total, z=1.959963984540054):
    if total == 0:
        return None
    p = successes / total
    denom = 1 + z*z/total
    center = (p + z*z/(2*total)) / denom
    half = z * sqrt(p*(1-p)/total + z*z/(4*total*total)) / denom
    return [max(0, center-half), min(1, center+half)]


def _metric(values):
    if not values:
        return None
    mean = statistics.mean(values)
    return {"n": len(values), "mean": mean, "median": statistics.median(values),
            "sd": statistics.stdev(values) if len(values) > 1 else None,
            "min": min(values), "max": max(values),
            "cv": statistics.stdev(values)/abs(mean) if len(values) > 1 and mean != 0 else None}


def summarize(pads, measurements, regions=None):
    allowed = set(regions or [p["region_id"] for p in pads])
    pad_map = {p["pad_id"]: p for p in pads if p["region_id"] in allowed}
    rows = [m for m in measurements if m["pad_id"] in pad_map]
    counts = Counter(m["status"] for m in rows)
    valid = [m for m in rows if m["status"] == "valid" and m.get("reviewed", True)]
    by_region = {}
    for r in sorted(allowed):
        subset = [m for m in rows if pad_map[m["pad_id"]]["region_id"] == r]
        good = sum(m["status"] == "valid" and m.get("reviewed", True) for m in subset)
        by_region[r] = {"tested": len(subset), "valid": good, "rate": good/len(subset) if subset else None,
                        "pr": _metric([m["pr_uc_cm2"] for m in subset if m["status"] == "valid" and
                                       m.get("reviewed", True) and m.get("pr_uc_cm2") is not None])}
    note = "Wilson 区间假设独立同分布；空间聚集和同单元相关性可能使其偏窄。"
    if len(allowed) < len({p["region_id"] for p in pads}):
        note += " 当前仅代表所选区域，不代表整片样品。"
    return {"scope_regions": sorted(allowed), "tested": len(rows), "valid": len(valid),
            "valid_rate": len(valid)/len(rows) if rows else None,
            "valid_rate_ci95": wilson(len(valid), len(rows)), "status_counts": dict(counts),
            "breakdown_rate": counts["breakdown"]/len(rows) if rows else None,
            "pr_uc_cm2": _metric([m["pr_uc_cm2"] for m in valid if m.get("pr_uc_cm2") is not None]),
            "ec_mv_cm": _metric([m["ec_mv_cm"] for m in valid if m.get("ec_mv_cm") is not None]),
            "by_region": by_region, "note": note}

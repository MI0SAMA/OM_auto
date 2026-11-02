"""Create reproducible or manually adjusted sampling plans."""
import json

from .core import geometry_groups, stratified_sample
from .store import pads, rows, touch_sample


def create_plan(db, payload):
    if not rows(db, "SELECT sample_id FROM samples WHERE sample_id=? AND deleted_at IS NULL",
                (payload["sample_id"],)):
        raise ValueError("样品不存在或已删除")
    pp = pads(db, payload["sample_id"])
    mode = payload.get("mode", "geometry" if payload.get("group_id") else "region")
    if mode not in {"region", "geometry"}:
        raise ValueError("选点模式无效")
    regions = payload.get("regions")
    if not isinstance(regions, list) or any(not isinstance(r, str) for r in regions):
        raise ValueError("区域须为区域 ID 列表")
    include_layout_only = payload.get("include_layout_only", False)
    if not isinstance(include_layout_only, bool):
        raise ValueError("include_layout_only 须为布尔值")
    if mode == "geometry":
        groups = geometry_groups(pp, float(payload.get("tolerance", .08)))
        group = next((g for g in groups if g["id"] == payload.get("group_id")), None)
        if not group:
            raise ValueError("几何组不存在")
        group_id, candidate_ids = group["id"], group["pad_ids"]
    else:
        group_id, candidate_ids = "REGION_ALL", [p["pad_id"] for p in pp]
    manual_ids = payload.get("pad_ids")
    if manual_ids is not None:
        if (not isinstance(manual_ids, list) or not manual_ids or
                any(not isinstance(pad_id, str) for pad_id in manual_ids) or
                len(set(manual_ids)) != len(manual_ids)):
            raise ValueError("手动选点清单须包含不重复的 Pad ID")
        allowed = set(candidate_ids)
        by_id = {p["pad_id"]: p for p in pp}
        selected = []
        for pad_id in manual_ids:
            p = by_id.get(pad_id)
            if (p is None or pad_id not in allowed or p["region_id"] not in regions or
                    not p["usable"] or p["tested"] or
                    (p.get("area_confidence") == "layout_only" and not include_layout_only)):
                raise ValueError("手动选点包含不符合当前区域、规格或可用状态的 Pad: " + pad_id)
            selected.append(p)
        allocation = {r: sum(p["region_id"] == r for p in selected) for r in sorted(set(regions))}
        purpose = "manual_adjusted"
    else:
        selected, allocation = stratified_sample(pp, candidate_ids, regions,
                                                  int(payload["count"]), int(payload["seed"]),
                                                  include_layout_only=include_layout_only)
        purpose = payload.get("purpose", "probability")
    cur = db.execute("""INSERT INTO plans(sample_id,group_id,regions_json,count,seed,allocation_json,pad_ids_json,purpose,mode,include_layout_only)
                        VALUES(?,?,?,?,?,?,?,?,?,?)""",
                     (payload["sample_id"], group_id, json.dumps(regions),
                      len(selected), int(payload["seed"]), json.dumps(allocation),
                      json.dumps([p["pad_id"] for p in selected]), purpose,
                      mode, int(include_layout_only)))
    touch_sample(db, payload["sample_id"])
    db.commit()
    return {"plan_id": cur.lastrowid, "allocation": allocation, "pads": selected,
                      "mode": mode, "include_layout_only": include_layout_only}


def delete_plan(db, sample_id, plan_id):
    if isinstance(plan_id, bool) or not isinstance(plan_id, (int, str)) or not str(plan_id).isdigit():
        raise ValueError("方案 ID 须为整数") from None
    plan_id = int(plan_id)
    if plan_id < 1:
        raise ValueError("方案 ID 须为正整数")
    with db:
        deleted = db.execute("""DELETE FROM plans WHERE plan_id=? AND sample_id=?
                                AND EXISTS (SELECT 1 FROM samples
                                            WHERE sample_id=? AND deleted_at IS NULL)""",
                             (plan_id, sample_id, sample_id)).rowcount
        if not deleted:
            raise ValueError("方案不存在或不属于当前样品")
        touch_sample(db, sample_id)
    return {"deleted": plan_id}

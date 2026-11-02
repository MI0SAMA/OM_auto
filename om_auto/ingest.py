"""CSV/Excel decoding and validated Pad/measurement imports."""
import base64
import csv
from io import BytesIO, StringIO
import json
import math

import pandas as pd

from .core import STATUSES, pad_area
from .store import invalidate_region_review, pads, rows, touch_sample


PAD_FIELDS = ["pad_id", "sample_id", "region_id", "layout_type_id", "layout_unit_id",
              "unit_row", "unit_col", "pad_local_id", "pad_row", "pad_col", "shape",
              "width_um", "height_um", "diameter_um", "x", "y", "usable", "exclusion_reason",
              "area_source", "area_confidence", "image_id"]
PAD_DB_FIELDS = [field for field in PAD_FIELDS if field not in {"layout_type_id", "unit_row", "unit_col"}]
MEAS_FIELDS = ["sample_id", "pad_id", "measured_at", "protocol_id", "pulse_v", "pulse_width_us",
               "interval_us", "status", "reviewed", "pr_uc_cm2", "ec_mv_cm", "breakdown_v",
               "max_voltage_v", "leakage_a_cm2", "invalid_reasons", "raw_path"]
NUMERIC_PAD = {"width_um", "height_um", "diameter_um", "x", "y",
               "unit_row", "unit_col", "pad_row", "pad_col"}
NUMERIC_MEAS = {"pulse_v", "pulse_width_us", "interval_us", "pr_uc_cm2", "ec_mv_cm",
                "breakdown_v", "max_voltage_v", "leakage_a_cm2"}


def clean(row, fields, numeric):
    out = {}
    for key in fields:
        val = row.get(key)
        if val is None or (isinstance(val, float) and pd.isna(val)) or val == "":
            out[key] = None
        elif key in numeric:
            out[key] = float(val)
            if not math.isfinite(out[key]):
                raise ValueError(f"{key} 必须是有限数值")
        else:
            out[key] = str(val).strip()
    return out


def import_pads(db, sample_id, records):
    if not records:
        raise ValueError("没有 Pad 记录")
    if not rows(db, "SELECT sample_id FROM samples WHERE sample_id=? AND deleted_at IS NULL", (sample_id,)):
        raise ValueError("样品不存在")
    seen = set()
    prepared = []
    existing_layouts = {r["region_id"]: r["layout_type_id"] for r in
                        rows(db, "SELECT region_id,layout_type_id FROM regions WHERE sample_id=?", (sample_id,))}
    existing_units = {(u["region_id"], u["layout_unit_id"]): (u["unit_row"], u["unit_col"]) for u in
                      rows(db, "SELECT region_id,layout_unit_id,unit_row,unit_col FROM layout_units WHERE sample_id=?",
                           (sample_id,))}
    occupied_grid = {(p["region_id"], p["layout_unit_id"], p["pad_row"], p["pad_col"]) for p in
                     rows(db, """SELECT region_id,layout_unit_id,pad_row,pad_col FROM pads
                                 WHERE sample_id=? AND pad_row IS NOT NULL AND pad_col IS NOT NULL""",
                          (sample_id,))}
    batch_layouts = {}
    batch_units = {}
    for row in records:
        p = clean(row, PAD_FIELDS, NUMERIC_PAD)
        p["sample_id"] = sample_id
        p["layout_type_id"] = p["layout_type_id"] or "L1"
        for field in ("pad_id", "region_id", "layout_unit_id", "pad_local_id", "shape"):
            if not p[field]:
                raise ValueError(f"Pad 缺少 {field}")
        if p["pad_id"] in seen:
            raise ValueError(f"本批次重复 Pad ID: {p['pad_id']}")
        seen.add(p["pad_id"])
        if p["shape"] not in {"circle", "square", "other"}:
            raise ValueError("shape 仅支持 circle/square/other")
        for key in ("unit_row", "unit_col", "pad_row", "pad_col"):
            value = p[key]
            if value is not None:
                if value <= 0 or not value.is_integer():
                    raise ValueError(f"{key} 必须是正整数")
                p[key] = int(value)
        if (p["unit_row"] is None) != (p["unit_col"] is None):
            raise ValueError("重复版图的 unit_row/unit_col 必须同时填写")
        if (p["pad_row"] is None) != (p["pad_col"] is None):
            raise ValueError("Pad 的 pad_row/pad_col 必须同时填写")
        if p["pad_row"] is not None:
            grid_key = (p["region_id"], p["layout_unit_id"], p["pad_row"], p["pad_col"])
            if grid_key in occupied_grid:
                raise ValueError(f"Pad 行列位置重复: {p['region_id']}/{p['layout_unit_id']}"
                                 f" 第 {p['pad_row']} 行第 {p['pad_col']} 列")
            occupied_grid.add(grid_key)
        region = p["region_id"]
        previous_layout = batch_layouts.get(region, existing_layouts.get(region, "unknown"))
        if previous_layout not in {"unknown", p["layout_type_id"]}:
            raise ValueError(f"区域 {region} 已指定版图类型 {previous_layout}，不能混入 {p['layout_type_id']}")
        batch_layouts[region] = p["layout_type_id"]
        unit_key = (region, p["layout_unit_id"])
        old_position = batch_units.get(unit_key, existing_units.get(unit_key, (None, None)))
        new_position = (p["unit_row"], p["unit_col"])
        if old_position[0] is not None and new_position[0] is not None and old_position != new_position:
            raise ValueError(f"重复版图 {region}/{p['layout_unit_id']} 行列位置冲突")
        batch_units[unit_key] = new_position if new_position[0] is not None else old_position
        if any(p[k] is not None and p[k] <= 0 for k in ("width_um", "height_um", "diameter_um")):
            raise ValueError("尺寸必须大于零")
        p["usable"] = 1 if p["usable"] is None or str(p["usable"]).lower() in {"1", "true", "yes"} else 0
        if not p["usable"] and not p["exclusion_reason"]:
            raise ValueError(f"不可用 Pad {p['pad_id']} 必须填写 exclusion_reason")
        p["area_um2"] = pad_area(p["shape"], p["width_um"], p["height_um"], p["diameter_um"])
        prepared.append(p)
    with db:
        for region, layout in batch_layouts.items():
            db.execute("INSERT OR IGNORE INTO regions(sample_id,region_id,layout_type_id) VALUES(?,?,?)",
                       (sample_id, region, layout))
            db.execute("""UPDATE regions SET layout_type_id=?
                          WHERE sample_id=? AND region_id=? AND layout_type_id='unknown'""",
                       (layout, sample_id, region))
        for (region, unit), (unit_row, unit_col) in batch_units.items():
            db.execute("""INSERT OR IGNORE INTO layout_units
                          (sample_id,region_id,layout_unit_id,unit_row,unit_col) VALUES(?,?,?,?,?)""",
                       (sample_id, region, unit, unit_row, unit_col))
            if unit_row is not None:
                db.execute("""UPDATE layout_units SET unit_row=COALESCE(unit_row,?),unit_col=COALESCE(unit_col,?)
                              WHERE sample_id=? AND region_id=? AND layout_unit_id=?""",
                           (unit_row, unit_col, sample_id, region, unit))
        for p in prepared:
            names = PAD_DB_FIELDS + ["area_um2"]
            db.execute(f"INSERT INTO pads ({','.join(names)}) VALUES ({','.join('?' for _ in names)})",
                       [p[k] for k in names])
        for region in batch_layouts:
            invalidate_region_review(db, sample_id, region)
    return len(prepared)


def import_measurements(db, sample_id, records):
    if not records:
        raise ValueError("没有测试记录")
    if not rows(db, "SELECT sample_id FROM samples WHERE sample_id=? AND deleted_at IS NULL", (sample_id,)):
        raise ValueError("样品不存在或已删除")
    known = {p["pad_id"] for p in pads(db, sample_id)}
    seen = set()
    prepared = []
    for row in records:
        m = clean(row, MEAS_FIELDS, NUMERIC_MEAS)
        m["sample_id"] = sample_id
        if m["pad_id"] not in known:
            raise ValueError(f"未知 Pad ID: {m['pad_id']}；历史数据不可自动配位")
        if m["pad_id"] in seen:
            raise ValueError(f"本批次重复 Pad ID: {m['pad_id']}")
        seen.add(m["pad_id"])
        if m["status"] not in STATUSES:
            raise ValueError(f"非法 status: {m['status']}")
        if m["status"] != "valid" and (m["pr_uc_cm2"] is not None or m["ec_mv_cm"] is not None):
            raise ValueError(f"无效 Pad {m['pad_id']} 不应填写 Pr/Ec")
        if m["status"] == "valid" and (m["pr_uc_cm2"] is None or m["ec_mv_cm"] is None):
            raise ValueError(f"有效 Pad {m['pad_id']} 缺少 Pr/Ec")
        m["reviewed"] = 1 if m["reviewed"] is None or str(m["reviewed"]).lower() in {"1", "true", "yes"} else 0
        m["original_json"] = json.dumps(row, ensure_ascii=False, default=str)
        prepared.append(m)
    with db:
        for m in prepared:
            names = MEAS_FIELDS + ["original_json"]
            db.execute(f"INSERT INTO measurements ({','.join(names)}) VALUES ({','.join('?' for _ in names)})",
                       [m[k] for k in names])
        touch_sample(db, sample_id)
    return len(prepared)


def decode_table(payload):
    raw = base64.b64decode(payload["data"])
    filename = payload.get("filename", "data.csv").lower()
    if filename.endswith(".csv"):
        df = pd.read_csv(BytesIO(raw), dtype=str, keep_default_na=False)
    elif filename.endswith((".xlsx", ".xlsm")):
        df = pd.read_excel(BytesIO(raw), dtype=str, keep_default_na=False)
    else:
        raise ValueError("仅支持 CSV 或 XLSX")
    return df.to_dict("records")


def csv_bytes(records, fields):
    stream = StringIO()
    writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(records)
    return stream.getvalue().encode("utf-8-sig")

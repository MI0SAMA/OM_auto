"""Small dependency-light JSON API and browser UI."""
import base64
import csv
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO, StringIO
import json
import math
import os
from pathlib import Path
import sqlite3
from urllib.parse import parse_qs, urlparse
import uuid

import pandas as pd
from PIL import Image

from .core import STATUSES, geometry_groups, pad_area, stratified_sample, summarize
from .store import (archive_sample, candidate_edits, connect, delete_candidate_edit,
                    delete_region_box, measurements, pads, region_boxes, restore_sample,
                    rows, sample_counts, save_candidate_edit, save_region_box, structure)
from .vision import apply_candidate_edits, inspect_image, candidates
from .lattice import complete_layout
from .calibration import read_scale_bar

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("OM_AUTO_DATA", ROOT / "data"))
DB_PATH = DATA / "om_auto.sqlite3"
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


class Handler(BaseHTTPRequestHandler):
    def send(self, obj, status=200, content_type="application/json; charset=utf-8", headers=None):
        data = json.dumps(obj, ensure_ascii=False).encode() if content_type.startswith("application/json") else obj
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        if parsed.path == "/":
            return self.send((ROOT / "static" / "index.html").read_bytes(), content_type="text/html; charset=utf-8")
        if parsed.path == "/app.js":
            return self.send((ROOT / "static" / "app.js").read_bytes(), content_type="text/javascript; charset=utf-8")
        if parsed.path == "/primary.js":
            return self.send((ROOT / "static" / "primary.js").read_bytes(), content_type="text/javascript; charset=utf-8")
        if parsed.path == "/style.css":
            return self.send((ROOT / "static" / "style.css").read_bytes(), content_type="text/css; charset=utf-8")
        if parsed.path in {"/templates/pads.csv", "/templates/measurements.csv"}:
            return self.send((ROOT / parsed.path.lstrip("/")).read_bytes(),
                             content_type="text/csv; charset=utf-8")
        try:
            with connect(DB_PATH) as db:
                if parsed.path == "/api/samples":
                    return self.send(rows(db, "SELECT * FROM samples WHERE deleted_at IS NULL ORDER BY sample_id"))
                if parsed.path == "/api/deleted-samples":
                    return self.send(rows(db, "SELECT sample_id,deleted_at FROM samples WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"))
                if parsed.path == "/api/sample-counts":
                    return self.send(sample_counts(db, q["sample_id"]))
                if parsed.path == "/api/templates":
                    return self.send(rows(db, "SELECT name,created_at FROM templates ORDER BY name"))
                if parsed.path == "/api/pads":
                    return self.send(pads(db, q["sample_id"]))
                if parsed.path == "/api/structure":
                    return self.send(structure(db, q["sample_id"]))
                if parsed.path == "/api/groups":
                    return self.send(geometry_groups(pads(db, q["sample_id"]), float(q.get("tolerance", .08))))
                if parsed.path == "/api/measurements":
                    return self.send(measurements(db, q["sample_id"]))
                if parsed.path == "/api/summary":
                    pp = pads(db, q["sample_id"])
                    all_regions = {p["region_id"] for p in pp}
                    if q.get("group_id"):
                        group = next((g for g in geometry_groups(pp) if g["id"] == q["group_id"]), None)
                        if not group:
                            raise ValueError("几何组不存在")
                        selected = set(group["pad_ids"])
                        pp = [p for p in pp if p["pad_id"] in selected]
                    result = summarize(pp, measurements(db, q["sample_id"]),
                                       q.get("regions", "").split(",") if q.get("regions") else None)
                    if {p["region_id"] for p in pp} < all_regions:
                        result["note"] += " 该规格未覆盖样品全部区域，结论不可外推至整片。"
                    if not q.get("group_id"):
                        result["note"] += " 当前混合了不同几何规格，Pr/Ec 不宜直接解释为单一规格性能。"
                    return self.send(result)
                if parsed.path == "/api/plans":
                    items = rows(db, "SELECT * FROM plans WHERE sample_id=? ORDER BY plan_id DESC", (q["sample_id"],))
                    for item in items:
                        for key in ("regions_json", "allocation_json", "pad_ids_json"):
                            item[key[:-5]] = json.loads(item.pop(key))
                        item["include_layout_only"] = bool(item["include_layout_only"])
                    return self.send(items)
                if parsed.path == "/api/task.csv":
                    plan = rows(db, "SELECT * FROM plans WHERE plan_id=?", (int(q["plan_id"]),))
                    if not plan:
                        raise ValueError("计划不存在")
                    plan = plan[0]
                    selected = set(json.loads(plan["pad_ids_json"]))
                    output = [dict(p, plan_id=plan["plan_id"], seed=plan["seed"], purpose=plan["purpose"])
                              for p in pads(db, plan["sample_id"]) if p["pad_id"] in selected]
                    fields = ["plan_id", "seed", "purpose", "pad_id", "sample_id", "region_id",
                              "layout_type_id", "layout_unit_id", "unit_row", "unit_col",
                              "pad_local_id", "pad_row", "pad_col", "shape", "x", "y", "area_um2"]
                    return self.send(csv_bytes(output, fields), content_type="text/csv; charset=utf-8",
                                     headers={"Content-Disposition": f"attachment; filename=plan_{plan['plan_id']}.csv"})
                if parsed.path == "/api/image":
                    image = rows(db, "SELECT * FROM images WHERE image_id=?", (q["image_id"],))
                    if not image:
                        raise ValueError("图像不存在")
                    file = Path(image[0]["file_path"])
                    mime = "image/png" if file.suffix.lower() == ".png" else "image/jpeg"
                    return self.send(file.read_bytes(), content_type=mime)
                if parsed.path == "/api/scale-bar":
                    image = rows(db, "SELECT * FROM images WHERE image_id=?", (q["image_id"],))
                    if not image:
                        raise ValueError("图像不存在")
                    with Image.open(image[0]["file_path"]) as source:
                        scale = read_scale_bar(source)
                    return self.send({"found": scale is not None, **(scale or {})})
                if parsed.path == "/api/images":
                    return self.send(rows(db, """SELECT image_id,sample_id,width_px,height_px,role,original_name,created_at
                                                FROM images WHERE sample_id=? ORDER BY (role='primary') DESC,created_at,image_id""", (q["sample_id"],)))
                if parsed.path == "/api/region-boxes":
                    return self.send(region_boxes(db, q["sample_id"], q["image_id"]))
                if parsed.path == "/api/candidate-edits":
                    return self.send(candidate_edits(db, q["sample_id"], q["image_id"]))
            self.send({"error": "未找到接口"}, 404)
        except (ValueError, KeyError, sqlite3.Error) as exc:
            self.send({"error": str(exc)}, 400)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 30_000_000:
                raise ValueError("请求超过 30 MB")
            payload = json.loads(self.rfile.read(length))
            with connect(DB_PATH) as db:
                if self.path == "/api/samples":
                    if not str(payload.get("sample_id", "")).strip():
                        raise ValueError("样品 ID 不能为空")
                    existing_sample = rows(db, "SELECT deleted_at FROM samples WHERE sample_id=?",
                                           (str(payload["sample_id"]).strip(),))
                    if existing_sample:
                        raise ValueError("样品 ID 已存在；若已删除，请从“已删除样品”恢复")
                    db.execute("INSERT INTO samples(sample_id,recipe_id,notes) VALUES(?,?,?)",
                               (str(payload["sample_id"]).strip(), payload.get("recipe_id"), payload.get("notes")))
                    db.commit()
                    return self.send({"ok": True})
                if self.path == "/api/delete-sample":
                    return self.send(archive_sample(db, str(payload["sample_id"])))
                if self.path == "/api/restore-sample":
                    return self.send(restore_sample(db, str(payload["sample_id"])))
                if self.path == "/api/region-boxes":
                    return self.send(save_region_box(db, payload["sample_id"], payload["image_id"],
                                                     payload["region_id"], payload["box"]))
                if self.path == "/api/delete-region-box":
                    return self.send(delete_region_box(db, payload["sample_id"], payload["image_id"],
                                                       payload["region_id"]))
                if self.path == "/api/candidate-edits":
                    return self.send(save_candidate_edit(db, payload["sample_id"], payload["image_id"],
                                                         payload["region_id"], payload["action"],
                                                         payload["x"], payload["y"],
                                                         payload["width_px"], payload["height_px"]))
                if self.path == "/api/delete-candidate-edit":
                    return self.send(delete_candidate_edit(db, payload["sample_id"],
                                                           payload["image_id"], payload["edit_id"]))
                if self.path == "/api/pads":
                    return self.send({"imported": import_pads(db, payload["sample_id"], payload["rows"])})
                if self.path == "/api/measurements":
                    return self.send({"imported": import_measurements(db, payload["sample_id"], payload["rows"])})
                if self.path in {"/api/import-pads", "/api/import-measurements"}:
                    records = decode_table(payload)
                    count = (import_pads(db, payload["sample_id"], records) if self.path.endswith("pads") else
                             import_measurements(db, payload["sample_id"], records))
                    return self.send({"imported": count})
                if self.path == "/api/templates":
                    source = pads(db, payload["sample_id"])
                    template = [{k: p[k] for k in PAD_FIELDS if k not in {"sample_id", "pad_id"}} for p in source]
                    db.execute("INSERT INTO templates(name,pads_json) VALUES(?,?)",
                               (payload["name"], json.dumps(template, ensure_ascii=False)))
                    db.commit()
                    return self.send({"saved": len(template)})
                if self.path == "/api/delete-template":
                    name = str(payload.get("name", "")).strip()
                    if not name:
                        raise ValueError("请先选择版图模板")
                    deleted = db.execute("DELETE FROM templates WHERE name=?", (name,)).rowcount
                    if not deleted:
                        raise ValueError("模板不存在或已删除")
                    db.commit()
                    return self.send({"deleted": name})
                if self.path == "/api/apply-template":
                    template = rows(db, "SELECT pads_json FROM templates WHERE name=?", (payload["name"],))
                    if not template:
                        raise ValueError("模板不存在")
                    records = json.loads(template[0]["pads_json"])
                    for p in records:
                        parts = [payload["sample_id"], p["region_id"]]
                        if p.get("layout_type_id") not in (None, "unknown"):
                            parts.append(p["layout_type_id"])
                        p["pad_id"] = ":".join(parts + [p["layout_unit_id"], p["pad_local_id"]])
                    return self.send({"imported": import_pads(db, payload["sample_id"], records)})
                if self.path == "/api/plans":
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
                    db.commit()
                    return self.send({"plan_id": cur.lastrowid, "allocation": allocation, "pads": selected,
                                      "mode": mode, "include_layout_only": include_layout_only})
                if self.path == "/api/image":
                    sample_id = payload["sample_id"]
                    if not rows(db, "SELECT sample_id FROM samples WHERE sample_id=? AND deleted_at IS NULL", (sample_id,)):
                        raise ValueError("样品不存在")
                    data = base64.b64decode(payload["data"])
                    width, height = inspect_image(data)
                    suffix = Path(payload.get("filename", "image.png")).suffix.lower()
                    if suffix not in {".png", ".jpg", ".jpeg"}:
                        raise ValueError("图像仅支持 PNG/JPEG")
                    image_id = uuid.uuid4().hex
                    role = "primary" if Path(payload.get("filename", "")).stem.upper() == "ZHENGPIAN" else "supplement"
                    folder = DATA / "images"
                    folder.mkdir(parents=True, exist_ok=True)
                    path = folder / (image_id + suffix)
                    path.write_bytes(data)
                    if role == "primary":
                        db.execute("UPDATE images SET role='supplement' WHERE sample_id=?", (sample_id,))
                    db.execute("""INSERT INTO images(image_id,sample_id,file_path,width_px,height_px,role,original_name)
                                  VALUES(?,?,?,?,?,?,?)""",
                               (image_id, sample_id, str(path), width, height, role,
                                Path(payload.get("filename", "image" )).name))
                    db.commit()
                    return self.send({"image_id": image_id, "width_px": width, "height_px": height, "role": role})
                if self.path == "/api/set-primary":
                    image = rows(db, """SELECT i.image_id FROM images i JOIN samples s ON s.sample_id=i.sample_id
                                        WHERE i.image_id=? AND i.sample_id=? AND s.deleted_at IS NULL""",
                                 (payload["image_id"], payload["sample_id"]))
                    if not image:
                        raise ValueError("图像不属于当前样品")
                    with db:
                        db.execute("UPDATE images SET role='supplement' WHERE sample_id=?", (payload["sample_id"],))
                        db.execute("UPDATE images SET role='primary' WHERE image_id=?", (payload["image_id"],))
                    return self.send({"ok": True})
                if self.path == "/api/detect":
                    image = rows(db, "SELECT * FROM images WHERE image_id=?", (payload["image_id"],))
                    if not image:
                        raise ValueError("图像不存在")
                    source = Path(image[0]["file_path"]).read_bytes()
                    min_size = float(payload.get("min_size", 20))
                    max_size = float(payload.get("max_size", 500))
                    polarity = payload.get("polarity", "light")
                    if min_size <= 0 or max_size <= min_size or polarity not in {"light", "dark"}:
                        raise ValueError("候选检测参数无效")
                    bounds = (0, 0, image[0]["width_px"], image[0]["height_px"])
                    if payload.get("bbox"):
                        x1,y1,x2,y2 = (int(v) for v in payload["bbox"])
                        if not (0 <= x1 < x2 <= image[0]["width_px"] and
                                0 <= y1 < y2 <= image[0]["height_px"]):
                            raise ValueError("检测框超出图片范围")
                        bounds = (x1, y1, x2, y2)
                    x1, y1, x2, y2 = bounds
                    source_image = Image.open(BytesIO(source))
                    proposals = []
                    if x2 - x1 <= 2000 and y2 - y1 <= 2000:
                        crop = source_image.crop(bounds)
                        stream = BytesIO(); crop.save(stream, format="PNG")
                        result = candidates(stream.getvalue(), min_size, max_size, polarity)
                        for p in result["candidates"]:
                            p["x"] += x1
                            p["y"] += y1
                        proposals = result["candidates"]
                    else:
                        # Tiling retains small pads when a large ROI would be
                        # downsampled too heavily. Overlap preserves edge pads.
                        core = 1800
                        margin = min(600, max(100, int(max_size * 4)))
                        for top in range(y1, y2, core):
                            for left in range(x1, x2, core):
                                right = min(left + core, x2)
                                bottom = min(top + core, y2)
                                tile_box = (max(x1, left-margin), max(y1, top-margin),
                                            min(x2, right+margin), min(y2, bottom+margin))
                                stream = BytesIO()
                                source_image.crop(tile_box).save(stream, format="PNG")
                                tile = candidates(stream.getvalue(), min_size, max_size, polarity)
                                for p in tile["candidates"]:
                                    p["x"] += tile_box[0]
                                    p["y"] += tile_box[1]
                                    if left <= p["x"] < right and top <= p["y"] < bottom:
                                        proposals.append(p)
                                if len(proposals) > 20_000:
                                    raise ValueError("候选超过 20000 个；请缩小检测区域或收紧像素尺寸范围")
                        proposals.sort(key=lambda p: (p["y"], p["x"]))
                        result = {"warning": "阵列支持度仅用于优先核验，孤立 Pad 仍可能是真实点；形状须人工核验，尺寸为像素。"}
                    result["candidates"] = proposals
                    if payload.get("region_id"):
                        region_id = str(payload["region_id"])
                        saved_box = next((b for b in region_boxes(db, image[0]["sample_id"],
                                                                     payload["image_id"])
                                          if b["region_id"] == region_id), None)
                        if not saved_box or bounds != (saved_box["x1"], saved_box["y1"],
                                                      saved_box["x2"], saved_box["y2"]):
                            raise ValueError("区域框已变化，请刷新后重新识别")
                        local = [dict(p, x=p["x"]-x1, y=p["y"]-y1) for p in proposals]
                        local, lattice = complete_layout(source_image.crop(bounds), local, polarity)
                        proposals = [dict(p, x=round(p["x"]+x1, 1),
                                          y=round(p["y"]+y1, 1)) for p in local]
                        result["lattice"] = lattice
                        edits = [e for e in candidate_edits(db, image[0]["sample_id"],
                                                             payload["image_id"])
                                 if e["region_id"] == region_id]
                        result["candidates"] = apply_candidate_edits(proposals, edits)
                        if lattice["applied"]:
                            result["warning"] = "已按重复版图生成完整行列格点；紫色点有局部图像信号，灰色点仅由布局推断，均须人工核验。"
                    result["width_px"] = image[0]["width_px"]
                    result["height_px"] = image[0]["height_px"]
                    result["bbox"] = payload.get("bbox")
                    return self.send(result)
            self.send({"error": "未找到接口"}, 404)
        except (ValueError, KeyError, sqlite3.Error, TypeError, OSError) as exc:
            self.send({"error": str(exc)}, 400)


def run(host="127.0.0.1", port=8765):
    DATA.mkdir(parents=True, exist_ok=True)
    with connect(DB_PATH):
        pass
    print(f"OM Auto: http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()

"""Small dependency-light JSON API and browser UI."""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import sqlite3
from urllib.parse import parse_qs, urlparse
import uuid

from PIL import Image, ImageOps

from .core import geometry_groups, summarize
from .store import (archive_sample, candidate_edits, connect, delete_candidate_edit,
                    delete_region_box, measurements, pads, region_boxes, restore_sample,
                    rows, sample_counts, sample_overview, save_candidate_edit,
                    save_region_box, set_region_review, structure, touch_sample)
from .vision import inspect_image
from .calibration import read_scale_bar
from .ingest import PAD_FIELDS, csv_bytes, decode_table, import_measurements, import_pads
from .detection import detect_candidates
from .planning import create_plan, delete_plan

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("OM_AUTO_DATA", ROOT / "data"))
DB_PATH = DATA / "om_auto.sqlite3"
STATIC_SCRIPTS = {
    "app.js", "state.js", "om_helpers.js", "sampling.js", "pad_map.js",
    "om_view.js", "controller.js", "workspace.js", "om_actions.js",
}


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
        if parsed.path.lstrip("/") in STATIC_SCRIPTS and parsed.path.count("/") == 1:
            return self.send((ROOT / "static" / parsed.path.lstrip("/")).read_bytes(),
                             content_type="text/javascript; charset=utf-8")
        if parsed.path == "/style.css":
            return self.send((ROOT / "static" / "style.css").read_bytes(), content_type="text/css; charset=utf-8")
        if parsed.path == "/favicon.svg":
            return self.send((ROOT / "static" / "favicon.svg").read_bytes(), content_type="image/svg+xml")
        if parsed.path in {"/templates/pads.csv", "/templates/measurements.csv"}:
            return self.send((ROOT / parsed.path.lstrip("/")).read_bytes(),
                             content_type="text/csv; charset=utf-8")
        try:
            with connect(DB_PATH) as db:
                if parsed.path == "/api/samples":
                    return self.send(rows(db, "SELECT * FROM samples WHERE deleted_at IS NULL ORDER BY sample_id"))
                if parsed.path == "/api/sample-overview":
                    return self.send(sample_overview(db, q.get("q", ""), q.get("scope", "active"),
                                                     q.get("page", 1), q.get("page_size", 25)))
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
                    db.execute("""INSERT INTO samples(sample_id,recipe_id,notes,created_at,updated_at)
                                  VALUES(?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)""",
                               (str(payload["sample_id"]).strip(), payload.get("recipe_id"), payload.get("notes")))
                    db.commit()
                    return self.send({"ok": True})
                if self.path == "/api/delete-sample":
                    return self.send(archive_sample(db, str(payload["sample_id"])))
                if self.path == "/api/restore-sample":
                    return self.send(restore_sample(db, str(payload["sample_id"])))
                if self.path == "/api/region-review":
                    return self.send(set_region_review(db, payload["sample_id"],
                                                       payload["region_id"], payload["confirmed"]))
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
                    return self.send(create_plan(db, payload))
                if self.path == "/api/delete-plan":
                    return self.send(delete_plan(db, payload["sample_id"], payload["plan_id"]))
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
                    if role == "primary":
                        db.execute("UPDATE regions SET reviewed_at=NULL WHERE sample_id=?", (sample_id,))
                    touch_sample(db, sample_id)
                    db.commit()
                    return self.send({"image_id": image_id, "width_px": width, "height_px": height, "role": role})
                if self.path == "/api/rotate-image":
                    sample_id = payload["sample_id"]
                    source = rows(db, """SELECT i.* FROM images i JOIN samples s ON s.sample_id=i.sample_id
                                      WHERE i.image_id=? AND i.sample_id=? AND i.role='primary'
                                      AND s.deleted_at IS NULL""", (payload["image_id"], sample_id))
                    if not source:
                        raise ValueError("请选择当前样品的整片主图")
                    angle = float(payload["angle_deg"])
                    if not math.isfinite(angle) or abs(angle) < .05 or abs(angle) > 180:
                        raise ValueError("旋转角度须在 -180° 到 180° 之间，且不为 0")
                    original = source[0]
                    radians = math.radians(angle)
                    estimated_width = abs(original["width_px"] * math.cos(radians)) + abs(original["height_px"] * math.sin(radians))
                    estimated_height = abs(original["width_px"] * math.sin(radians)) + abs(original["height_px"] * math.cos(radians))
                    if estimated_width * estimated_height > 160_000_000:
                        raise ValueError("旋转后图像预计超过 1.6 亿像素；请减小角度或先缩小原图")
                    image_id = uuid.uuid4().hex
                    suffix = Path(original["file_path"]).suffix.lower()
                    if suffix not in {".png", ".jpg", ".jpeg"}:
                        suffix = ".jpg"
                    folder = DATA / "images"
                    folder.mkdir(parents=True, exist_ok=True)
                    path = folder / (image_id + suffix)
                    try:
                        with Image.open(original["file_path"]) as image:
                            corrected = ImageOps.exif_transpose(image).convert("RGB").rotate(
                                -angle, resample=Image.Resampling.BICUBIC, expand=True,
                                fillcolor=(240, 240, 240))
                            width, height = corrected.size
                            if width * height > 160_000_000:
                                raise ValueError("旋转后图像超过 1.6 亿像素；请减小角度或先缩小原图")
                            if suffix == ".png":
                                corrected.save(path, format="PNG")
                            else:
                                corrected.convert("RGB").save(path, format="JPEG", quality=92)
                            corrected.close()
                        name = f"{Path(original['original_name'] or 'ZHENGPIAN').stem}_旋转{angle:g}度{suffix}"
                        with db:
                            db.execute("UPDATE images SET role='supplement' WHERE sample_id=?", (sample_id,))
                            db.execute("""INSERT INTO images(image_id,sample_id,file_path,width_px,height_px,role,original_name)
                                          VALUES(?,?,?,?,?,'primary',?)""",
                                       (image_id, sample_id, str(path), width, height, name))
                            db.execute("UPDATE regions SET reviewed_at=NULL WHERE sample_id=?", (sample_id,))
                            touch_sample(db, sample_id)
                    except Exception:
                        path.unlink(missing_ok=True)
                        raise
                    return self.send({"image_id": image_id, "width_px": width, "height_px": height,
                                      "role": "primary", "original_name": name})
                if self.path == "/api/set-primary":
                    image = rows(db, """SELECT i.image_id,i.role FROM images i JOIN samples s ON s.sample_id=i.sample_id
                                        WHERE i.image_id=? AND i.sample_id=? AND s.deleted_at IS NULL""",
                                 (payload["image_id"], payload["sample_id"]))
                    if not image:
                        raise ValueError("图像不属于当前样品")
                    if image[0]["role"] == "primary":
                        return self.send({"ok": True})
                    with db:
                        db.execute("UPDATE images SET role='supplement' WHERE sample_id=?", (payload["sample_id"],))
                        db.execute("UPDATE images SET role='primary' WHERE image_id=?", (payload["image_id"],))
                        db.execute("UPDATE regions SET reviewed_at=NULL WHERE sample_id=?", (payload["sample_id"],))
                        touch_sample(db, payload["sample_id"])
                    return self.send({"ok": True})
                if self.path == "/api/detect":
                    return self.send(detect_candidates(db, payload))
            self.send({"error": "未找到接口"}, 404)
        except (ValueError, KeyError, sqlite3.Error, TypeError, OSError) as exc:
            self.send({"error": str(exc)}, 400)


def run(host="127.0.0.1", port=8765):
    DATA.mkdir(parents=True, exist_ok=True)
    with connect(DB_PATH):
        pass
    print(f"OM Auto: http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()

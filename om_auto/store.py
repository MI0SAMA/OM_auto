import json
import math
import sqlite3
from pathlib import Path


SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS samples (
 sample_id TEXT PRIMARY KEY, recipe_id TEXT, notes TEXT, image_path TEXT,
 deleted_at TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS regions (
 sample_id TEXT NOT NULL REFERENCES samples(sample_id), region_id TEXT NOT NULL,
 layout_type_id TEXT NOT NULL DEFAULT 'unknown', reviewed_at TEXT,
 PRIMARY KEY(sample_id,region_id));
CREATE TABLE IF NOT EXISTS layout_units (
 sample_id TEXT NOT NULL, region_id TEXT NOT NULL, layout_unit_id TEXT NOT NULL,
 unit_row INTEGER, unit_col INTEGER,
 PRIMARY KEY(sample_id,region_id,layout_unit_id),
 FOREIGN KEY(sample_id,region_id) REFERENCES regions(sample_id,region_id));
CREATE TABLE IF NOT EXISTS pads (
 pad_id TEXT PRIMARY KEY, sample_id TEXT NOT NULL REFERENCES samples(sample_id),
 region_id TEXT NOT NULL, layout_unit_id TEXT NOT NULL, pad_local_id TEXT NOT NULL,
 pad_row INTEGER, pad_col INTEGER,
 shape TEXT NOT NULL, width_um REAL, height_um REAL, diameter_um REAL, area_um2 REAL,
 x REAL, y REAL, usable INTEGER NOT NULL DEFAULT 1, exclusion_reason TEXT,
 area_source TEXT, area_confidence TEXT, image_id TEXT,
 UNIQUE(sample_id,region_id,layout_unit_id,pad_local_id));
CREATE TABLE IF NOT EXISTS measurements (
 measurement_id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id TEXT NOT NULL,
 pad_id TEXT NOT NULL REFERENCES pads(pad_id), measured_at TEXT, protocol_id TEXT,
 pulse_v REAL, pulse_width_us REAL, interval_us REAL, status TEXT NOT NULL,
 reviewed INTEGER NOT NULL DEFAULT 1, pr_uc_cm2 REAL, ec_mv_cm REAL,
 breakdown_v REAL, max_voltage_v REAL, leakage_a_cm2 REAL,
 invalid_reasons TEXT, raw_path TEXT, original_json TEXT NOT NULL,
 imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(pad_id,measured_at,protocol_id));
CREATE TABLE IF NOT EXISTS plans (
 plan_id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, group_id TEXT NOT NULL,
 regions_json TEXT NOT NULL, count INTEGER NOT NULL, seed INTEGER NOT NULL,
 allocation_json TEXT NOT NULL, pad_ids_json TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'probability',
 mode TEXT NOT NULL DEFAULT 'geometry', include_layout_only INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS templates (
 name TEXT PRIMARY KEY, pads_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS images (
 image_id TEXT PRIMARY KEY, sample_id TEXT NOT NULL, file_path TEXT NOT NULL,
 width_px INTEGER NOT NULL, height_px INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'supplement',
 original_name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS region_boxes (
 sample_id TEXT NOT NULL REFERENCES samples(sample_id),
 image_id TEXT NOT NULL REFERENCES images(image_id),
 region_id TEXT NOT NULL,
 x1 INTEGER NOT NULL, y1 INTEGER NOT NULL, x2 INTEGER NOT NULL, y2 INTEGER NOT NULL,
 PRIMARY KEY(sample_id,image_id,region_id));
CREATE TABLE IF NOT EXISTS candidate_edits (
 edit_id INTEGER PRIMARY KEY AUTOINCREMENT,
 sample_id TEXT NOT NULL REFERENCES samples(sample_id),
 image_id TEXT NOT NULL REFERENCES images(image_id),
 region_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('add','remove')),
 x REAL NOT NULL, y REAL NOT NULL, width_px REAL NOT NULL, height_px REAL NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
"""


def connect(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(SCHEMA)
    existing = {r[1] for r in db.execute("PRAGMA table_info(images)")}
    if "role" not in existing:
        db.execute("ALTER TABLE images ADD COLUMN role TEXT NOT NULL DEFAULT 'supplement'")
    if "original_name" not in existing:
        db.execute("ALTER TABLE images ADD COLUMN original_name TEXT")
    sample_columns = {r[1] for r in db.execute("PRAGMA table_info(samples)")}
    if "deleted_at" not in sample_columns:
        db.execute("ALTER TABLE samples ADD COLUMN deleted_at TEXT")
    for column in ("created_at", "updated_at"):
        if column not in sample_columns:
            db.execute(f"ALTER TABLE samples ADD COLUMN {column} TEXT")
    region_columns = {r[1] for r in db.execute("PRAGMA table_info(regions)")}
    if "reviewed_at" not in region_columns:
        db.execute("ALTER TABLE regions ADD COLUMN reviewed_at TEXT")
    pad_columns = {r[1] for r in db.execute("PRAGMA table_info(pads)")}
    if "pad_row" not in pad_columns:
        db.execute("ALTER TABLE pads ADD COLUMN pad_row INTEGER")
    if "pad_col" not in pad_columns:
        db.execute("ALTER TABLE pads ADD COLUMN pad_col INTEGER")
    plan_columns = {r[1] for r in db.execute("PRAGMA table_info(plans)")}
    if "mode" not in plan_columns:
        db.execute("ALTER TABLE plans ADD COLUMN mode TEXT NOT NULL DEFAULT 'geometry'")
    if "include_layout_only" not in plan_columns:
        db.execute("ALTER TABLE plans ADD COLUMN include_layout_only INTEGER NOT NULL DEFAULT 0")
    db.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_pad_grid_location ON pads
                  (sample_id,region_id,layout_unit_id,pad_row,pad_col)
                  WHERE pad_row IS NOT NULL AND pad_col IS NOT NULL""")
    db.execute("""INSERT OR IGNORE INTO regions(sample_id,region_id,layout_type_id)
                  SELECT DISTINCT sample_id,region_id,'unknown' FROM pads""")
    db.execute("""INSERT OR IGNORE INTO layout_units(sample_id,region_id,layout_unit_id)
                  SELECT DISTINCT sample_id,region_id,layout_unit_id FROM pads""")
    db.commit()
    return db


def rows(db, sql, params=()):
    return [dict(r) for r in db.execute(sql, params)]


def touch_sample(db, sample_id):
    db.execute("UPDATE samples SET updated_at=CURRENT_TIMESTAMP WHERE sample_id=?", (sample_id,))


def invalidate_region_review(db, sample_id, region_id):
    db.execute("UPDATE regions SET reviewed_at=NULL WHERE sample_id=? AND region_id=?",
               (sample_id, region_id))
    touch_sample(db, sample_id)


def set_region_review(db, sample_id, region_id, confirmed):
    if not isinstance(confirmed, bool):
        raise ValueError("confirmed 须为布尔值")
    region = rows(db, """SELECT r.region_id, count(p.pad_id) AS pad_count
                         FROM regions r JOIN samples s ON s.sample_id=r.sample_id
                         LEFT JOIN pads p ON p.sample_id=r.sample_id AND p.region_id=r.region_id
                         WHERE r.sample_id=? AND r.region_id=? AND s.deleted_at IS NULL
                         GROUP BY r.region_id""", (sample_id, region_id))
    if not region:
        raise ValueError("区域不存在或样品已删除")
    if confirmed and not region[0]["pad_count"]:
        raise ValueError("请先保存该区域的 Pad，再确认核对完成")
    with db:
        db.execute("""UPDATE regions SET reviewed_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END
                      WHERE sample_id=? AND region_id=?""", (int(confirmed), sample_id, region_id))
        touch_sample(db, sample_id)
    return {"region_id": region_id, "confirmed": confirmed}


def sample_overview(db, query="", scope="active", page=1, page_size=25):
    if scope not in {"active", "deleted"}:
        raise ValueError("scope 仅支持 active/deleted")
    try:
        page, page_size = int(page), int(page_size)
    except (TypeError, ValueError):
        raise ValueError("分页参数须为整数") from None
    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("分页参数超出范围")
    keyword = "%" + str(query).strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    where = "s.deleted_at IS " + ("NOT NULL" if scope == "deleted" else "NULL")
    where += " AND (s.sample_id LIKE ? ESCAPE '\\' OR COALESCE(s.recipe_id,'') LIKE ? ESCAPE '\\')"
    total = db.execute("SELECT count(*) FROM samples s WHERE " + where, (keyword, keyword)).fetchone()[0]
    items = rows(db, """SELECT s.sample_id,s.recipe_id,s.notes,s.deleted_at,
                          NULLIF(MAX(COALESCE(s.updated_at,''),COALESCE(s.created_at,''),
                            COALESCE((SELECT max(i.created_at) FROM images i WHERE i.sample_id=s.sample_id),''),
                            COALESCE((SELECT max(p.created_at) FROM plans p WHERE p.sample_id=s.sample_id),''),
                            COALESCE((SELECT max(m.imported_at) FROM measurements m WHERE m.sample_id=s.sample_id),'')),
                            '') AS last_activity_at,
                          (SELECT count(*) FROM images i WHERE i.sample_id=s.sample_id) AS image_count,
                          (SELECT count(*) FROM regions r WHERE r.sample_id=s.sample_id) AS region_count,
                          (SELECT count(*) FROM regions r WHERE r.sample_id=s.sample_id AND r.reviewed_at IS NOT NULL) AS confirmed_region_count,
                          (SELECT count(*) FROM pads p WHERE p.sample_id=s.sample_id) AS pad_count,
                          (SELECT count(*) FROM plans p WHERE p.sample_id=s.sample_id) AS plan_count,
                          (SELECT count(*) FROM measurements m WHERE m.sample_id=s.sample_id) AS measurement_count
                          FROM samples s WHERE """ + where + " ORDER BY last_activity_at DESC, s.sample_id LIMIT ? OFFSET ?",
                 (keyword, keyword, page_size, (page - 1) * page_size))
    return {"items": items, "total": total, "page": page, "page_size": page_size}


def region_boxes(db, sample_id, image_id):
    return rows(db, """SELECT region_id,x1,y1,x2,y2 FROM region_boxes
                       WHERE sample_id=? AND image_id=? ORDER BY region_id""",
                (sample_id, image_id))


def save_region_box(db, sample_id, image_id, region_id, box):
    region_id = str(region_id).strip()
    if not region_id or len(region_id) > 64 or ":" in region_id:
        raise ValueError("区域 ID 须为 1–64 个字符，且不能包含冒号")
    image = rows(db, """SELECT i.width_px,i.height_px FROM images i
                        JOIN samples s ON s.sample_id=i.sample_id
                        WHERE i.image_id=? AND i.sample_id=? AND s.deleted_at IS NULL""",
                 (image_id, sample_id))
    if not image:
        raise ValueError("图片不属于当前样品")
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        raise ValueError("区域框须提供四个坐标")
    try:
        coords = [int(value) for value in box]
    except (TypeError, ValueError):
        raise ValueError("区域框坐标须为整数") from None
    x1, y1, x2, y2 = coords
    if not (0 <= x1 < x2 <= image[0]["width_px"] and
            0 <= y1 < y2 <= image[0]["height_px"] and
            x2 - x1 >= 30 and y2 - y1 >= 30):
        raise ValueError("区域框超出图片范围或尺寸小于 30 px")
    if rows(db, """SELECT region_id FROM region_boxes
                  WHERE sample_id=? AND image_id=? AND region_id=?""",
            (sample_id, image_id, region_id)):
        raise ValueError(f"区域 {region_id} 已有框；请先删除旧框再重新绘制")
    with db:
        db.execute("""INSERT OR IGNORE INTO regions(sample_id,region_id,layout_type_id)
                      VALUES(?,?,'unknown')""", (sample_id, region_id))
        db.execute("""INSERT INTO region_boxes(sample_id,image_id,region_id,x1,y1,x2,y2)
                      VALUES(?,?,?,?,?,?,?)""", (sample_id, image_id, region_id, *coords))
        invalidate_region_review(db, sample_id, region_id)
    return {"region_id": region_id, "box": coords}


def delete_region_box(db, sample_id, image_id, region_id):
    with db:
        changed = db.execute("""DELETE FROM region_boxes
                                WHERE sample_id=? AND image_id=? AND region_id=?""",
                             (sample_id, image_id, region_id)).rowcount
        if changed:
            db.execute("""DELETE FROM candidate_edits
                          WHERE sample_id=? AND image_id=? AND region_id=?""",
                       (sample_id, image_id, region_id))
            invalidate_region_review(db, sample_id, region_id)
    if not changed:
        raise ValueError("区域框不存在")
    return {"ok": True}


def candidate_edits(db, sample_id, image_id):
    return rows(db, """SELECT edit_id,region_id,action,x,y,width_px,height_px,created_at
                       FROM candidate_edits WHERE sample_id=? AND image_id=? ORDER BY edit_id""",
                (sample_id, image_id))


def save_candidate_edit(db, sample_id, image_id, region_id, action, x, y, width_px, height_px):
    if action not in {"add", "remove"}:
        raise ValueError("候选修正类型无效")
    box = rows(db, """SELECT b.x1,b.y1,b.x2,b.y2 FROM region_boxes b
                      JOIN samples s ON s.sample_id=b.sample_id
                      WHERE b.sample_id=? AND b.image_id=? AND b.region_id=?
                      AND s.deleted_at IS NULL""", (sample_id, image_id, region_id))
    if not box:
        raise ValueError("候选修正需要有效区域框")
    try:
        x, y, width_px, height_px = map(float, (x, y, width_px, height_px))
    except (TypeError, ValueError):
        raise ValueError("候选坐标和尺寸须为数字") from None
    if (not all(math.isfinite(v) for v in (x, y, width_px, height_px)) or
            width_px <= 0 or height_px <= 0 or
            not (box[0]["x1"] <= x < box[0]["x2"] and box[0]["y1"] <= y < box[0]["y2"])):
        raise ValueError("候选中心须在区域框内，尺寸须大于零")
    with db:
        cur = db.execute("""INSERT INTO candidate_edits
                            (sample_id,image_id,region_id,action,x,y,width_px,height_px)
                            VALUES(?,?,?,?,?,?,?,?)""",
                         (sample_id, image_id, region_id, action, x, y, width_px, height_px))
        invalidate_region_review(db, sample_id, region_id)
    return rows(db, """SELECT edit_id,region_id,action,x,y,width_px,height_px,created_at
                       FROM candidate_edits WHERE edit_id=?""", (cur.lastrowid,))[0]


def delete_candidate_edit(db, sample_id, image_id, edit_id):
    with db:
        edit = rows(db, """SELECT region_id FROM candidate_edits
                           WHERE sample_id=? AND image_id=? AND edit_id=?""",
                    (sample_id, image_id, int(edit_id)))
        changed = db.execute("""DELETE FROM candidate_edits
                                WHERE sample_id=? AND image_id=? AND edit_id=?""",
                             (sample_id, image_id, int(edit_id))).rowcount
        if changed:
            invalidate_region_review(db, sample_id, edit[0]["region_id"])
    if not changed:
        raise ValueError("候选修正不存在")
    return {"ok": True}


def pads(db, sample_id):
    data = rows(db, """SELECT p.*, r.layout_type_id, u.unit_row, u.unit_col,
                       EXISTS(SELECT 1 FROM measurements m WHERE m.pad_id=p.pad_id) AS tested
                       FROM pads p LEFT JOIN regions r ON r.sample_id=p.sample_id AND r.region_id=p.region_id
                       LEFT JOIN layout_units u ON u.sample_id=p.sample_id AND u.region_id=p.region_id
                                                AND u.layout_unit_id=p.layout_unit_id
                       WHERE p.sample_id=? ORDER BY p.region_id,p.layout_unit_id,p.pad_row,p.pad_col,p.pad_id""", (sample_id,))
    for p in data:
        p["usable"] = bool(p["usable"])
        p["tested"] = bool(p["tested"])
    return data


def structure(db, sample_id):
    region_rows = rows(db, """SELECT r.region_id,r.layout_type_id,r.reviewed_at,
                              count(DISTINCT u.layout_unit_id) AS unit_count,
                              count(DISTINCT p.pad_id) AS pad_count
                              FROM regions r LEFT JOIN layout_units u ON u.sample_id=r.sample_id AND u.region_id=r.region_id
                              LEFT JOIN pads p ON p.sample_id=r.sample_id AND p.region_id=r.region_id
                              WHERE r.sample_id=? GROUP BY r.region_id,r.layout_type_id,r.reviewed_at ORDER BY r.region_id""", (sample_id,))
    units = rows(db, """SELECT u.region_id,u.layout_unit_id,u.unit_row,u.unit_col,
                        count(p.pad_id) AS pad_count
                        FROM layout_units u LEFT JOIN pads p ON p.sample_id=u.sample_id AND p.region_id=u.region_id
                                            AND p.layout_unit_id=u.layout_unit_id
                        WHERE u.sample_id=? GROUP BY u.region_id,u.layout_unit_id,u.unit_row,u.unit_col
                        ORDER BY u.region_id,u.unit_row,u.unit_col,u.layout_unit_id""", (sample_id,))
    for region in region_rows:
        region["units"] = [u for u in units if u["region_id"] == region["region_id"]]
    return region_rows


def measurements(db, sample_id):
    data = rows(db, """SELECT m.* FROM measurements m JOIN pads p ON p.pad_id=m.pad_id
                       WHERE p.sample_id=? ORDER BY m.measurement_id""", (sample_id,))
    # Latest reviewed record per pad is used for descriptive summaries.
    latest = {m["pad_id"]: m for m in data}
    for m in latest.values():
        m["reviewed"] = bool(m["reviewed"])
    return list(latest.values())


def sample_counts(db, sample_id):
    sample = rows(db, "SELECT sample_id,deleted_at FROM samples WHERE sample_id=?", (sample_id,))
    if not sample:
        raise ValueError("样品不存在")
    return {"sample_id": sample_id, "deleted_at": sample[0]["deleted_at"],
            "pads": db.execute("SELECT count(*) FROM pads WHERE sample_id=?", (sample_id,)).fetchone()[0],
            "measurements": db.execute("SELECT count(*) FROM measurements WHERE sample_id=?", (sample_id,)).fetchone()[0],
            "plans": db.execute("SELECT count(*) FROM plans WHERE sample_id=?", (sample_id,)).fetchone()[0],
            "images": db.execute("SELECT count(*) FROM images WHERE sample_id=?", (sample_id,)).fetchone()[0]}


def archive_sample(db, sample_id):
    with db:
        changed = db.execute("""UPDATE samples SET deleted_at=CURRENT_TIMESTAMP
                                WHERE sample_id=? AND deleted_at IS NULL""", (sample_id,)).rowcount
        if changed:
            touch_sample(db, sample_id)
    if not changed:
        raise ValueError("样品不存在或已删除")
    return sample_counts(db, sample_id)


def restore_sample(db, sample_id):
    with db:
        changed = db.execute("""UPDATE samples SET deleted_at=NULL
                                WHERE sample_id=? AND deleted_at IS NOT NULL""", (sample_id,)).rowcount
        if changed:
            touch_sample(db, sample_id)
    if not changed:
        raise ValueError("样品不存在或未删除")
    return sample_counts(db, sample_id)

"""Image candidate detection and region-grid completion."""
from pathlib import Path

from PIL import Image

from .lattice import complete_layout
from .store import candidate_edits, invalidate_region_review, region_boxes, rows
from .vision import apply_candidate_edits, candidates


def detect_candidates(db, payload):
    image = rows(db, "SELECT * FROM images WHERE image_id=?", (payload["image_id"],))
    if not image:
        raise ValueError("图像不存在")
    source_path = Path(image[0]["file_path"])
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
    with Image.open(source_path) as source_image:
        proposals = []
        if x2 - x1 <= 2000 and y2 - y1 <= 2000:
            crop = source_image.crop(bounds)
            result = candidates(crop, min_size, max_size, polarity)
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
                    tile = candidates(source_image.crop(tile_box), min_size, max_size, polarity)
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
            with db:
                invalidate_region_review(db, image[0]["sample_id"], region_id)
    result["width_px"] = image[0]["width_px"]
    result["height_px"] = image[0]["height_px"]
    result["bbox"] = payload.get("bbox")
    return result

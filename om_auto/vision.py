"""Conservative OM candidate proposals; every candidate needs human confirmation."""
from io import BytesIO
import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree


def apply_candidate_edits(proposals, edits):
    """Apply saved corrections in whole-image pixel coordinates."""
    removed = [edit for edit in edits if edit["action"] == "remove"]
    added = [edit for edit in edits if edit["action"] == "add"]

    def near(point, edit):
        radius = max(4, .35 * min(point["width_px"], point["height_px"],
                                 edit["width_px"], edit["height_px"]))
        return (point["x"] - edit["x"]) ** 2 + (point["y"] - edit["y"]) ** 2 <= radius ** 2

    output = [p for p in proposals if not any(near(p, e) for e in removed + added)]
    for edit in added:
        output.append({"x": edit["x"], "y": edit["y"],
                       "width_px": edit["width_px"], "height_px": edit["height_px"],
                       "shape_guess": "other", "fill": None,
                       "grid_support": None, "confidence": "manual",
                       "edit_id": edit["edit_id"]})
    return sorted(output, key=lambda p: (p["y"], p["x"]))


def inspect_image(data):
    image = Image.open(BytesIO(data))
    image.verify()
    image = Image.open(BytesIO(data))
    if image.width * image.height > 100_000_000:
        raise ValueError(f"图像为 {image.width}×{image.height} 像素，超过 1 亿像素上限")
    return image.width, image.height


def candidates(data, min_size=20, max_size=500, polarity="light"):
    if min_size <= 0 or max_size <= min_size:
        raise ValueError("候选尺寸范围无效")
    if polarity not in {"light", "dark"}:
        raise ValueError("极性仅支持 light/dark")
    image = (data if isinstance(data, Image.Image) else Image.open(BytesIO(data))).convert("L")
    factor = max(1, max(image.size) / 1800)
    small = image.resize((max(1, round(image.width/factor)), max(1, round(image.height/factor))))
    arr = np.asarray(small, dtype=np.float32)
    found = []
    cell_size = max(4., max_size * .3)
    buckets = {}
    # The background varies over tens of pixels. Estimate it on a quarter-size
    # image, then interpolate back; filtering every full-resolution pixel with
    # sigma 45/95 dominates runtime on small servers.
    coarse = arr[::4, ::4]
    for sigma in (45, 95):
        blurred = ndimage.gaussian_filter(coarse, sigma=sigma / 4)
        background = np.asarray(Image.fromarray(blurred).resize(
            (arr.shape[1], arr.shape[0]), Image.Resampling.BILINEAR))
        contrast = arr - background
        mask = contrast > 5 if polarity == "light" else contrast < -5
        mask = ndimage.binary_opening(mask, iterations=1)
        labeled, _ = ndimage.label(mask)
        for label_id, box in enumerate(ndimage.find_objects(labeled), 1):
            if box is None:
                continue
            h = box[0].stop-box[0].start
            w = box[1].stop-box[1].start
            original_w, original_h = w*factor, h*factor
            if min(original_w, original_h) < min_size or max(original_w, original_h) > max_size:
                continue
            if box[0].start == 0 or box[1].start == 0 or box[0].stop == arr.shape[0] or box[1].stop == arr.shape[1]:
                continue
            area = int((labeled[box] == label_id).sum())
            fill = area/(w*h)
            ratio = min(w,h)/max(w,h)
            if ratio < 0.72 or fill < 0.48:
                continue
            x, y = (box[1].start+w/2)*factor, (box[0].start+h/2)*factor
            bx, by = int(x // cell_size), int(y // cell_size)
            nearby = (found[i] for gx in range(bx-1, bx+2) for gy in range(by-1, by+2)
                      for i in buckets.get((gx, gy), ()))
            if any(abs(x-p["x"]) < min(original_w,p["width_px"])*.3 and
                   abs(y-p["y"]) < min(original_h,p["height_px"])*.3 for p in nearby):
                continue
            shape = ("square" if fill >= 0.83 else
                     "circle" if ratio >= .8 and .50 <= fill < .83 else "other")
            found.append({"x": round(x, 1), "y": round(y, 1),
                          "width_px": round(original_w, 1), "height_px": round(original_h, 1),
                          "shape_guess": shape, "fill": round(fill, 3)})
            buckets.setdefault((bx, by), []).append(len(found) - 1)
    if len(found) > 20_000:
        raise ValueError("候选超过 20000 个；请缩小检测区域或收紧像素尺寸范围")
    # Repeated pads form rows and columns. Keep isolated spots available for
    # review, but distinguish them from candidates supported by the layout.
    if found:
        centers = np.array([(p["x"], p["y"]) for p in found])
        tree = cKDTree(centers)
        for index, pad in enumerate(found):
            diameter = min(pad["width_px"], pad["height_px"])
            support = 0
            for neighbor in tree.query_ball_point(centers[index], 3.4 * diameter):
                if neighbor == index:
                    continue
                other = found[neighbor]
                other_diameter = min(other["width_px"], other["height_px"])
                dx = abs(other["x"] - pad["x"])
                dy = abs(other["y"] - pad["y"])
                same_size = .7 * diameter <= other_diameter <= 1.4 * diameter
                aligned = ((1.5 * diameter <= dx <= 3.4 * diameter and dy <= .6 * diameter)
                           or (1.5 * diameter <= dy <= 3.4 * diameter and dx <= .6 * diameter))
                if same_size and aligned:
                    support += 1
            pad["grid_support"] = support
            pad["confidence"] = "high" if support >= 2 else "review"
    return {"width_px": image.width, "height_px": image.height,
            "candidates": sorted(found, key=lambda p: (p["y"], p["x"])),
            "warning": "阵列支持度仅用于优先核验，孤立 Pad 仍可能是真实点；形状须人工核验，尺寸为像素。"}

"""Read a microscope scale annotation without assuming image magnification."""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage


FONT_PATHS = (
    "/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


def _groups(values):
    groups = []
    for value in values:
        if not groups or value > groups[-1][-1] + 1:
            groups.append([int(value)])
        else:
            groups[-1].append(int(value))
    return groups


def _digit_templates():
    templates = []
    for path in FONT_PATHS:
        if not Path(path).is_file():
            continue
        font = ImageFont.truetype(path, 120)
        for digit in "0123456789":
            canvas = Image.new("L", (150, 150))
            ImageDraw.Draw(canvas).text((0, 0), digit, font=font, fill=255)
            crop = canvas.crop(canvas.getbbox())
            mask = np.asarray(crop.resize((32, 48), Image.Resampling.NEAREST)) > 127
            templates.append((digit, mask))
    return templates


def _read_label(rgb, bar_box, bar_height):
    x1, y1, x2, y2 = bar_box
    height, width = rgb.shape[:2]
    left = max(0, x1 - 2 * (x2 - x1))
    right = min(width, x2 + 2 * (x2 - x1))
    top = min(height, y2 + max(5, int(.08 * bar_height)))
    bottom = min(height, y2 + max(100, int(3.1 * bar_height)))
    if top >= bottom:
        return None
    sub = rgb[top:bottom, left:right]
    red, green, blue = sub[:, :, 0], sub[:, :, 1], sub[:, :, 2]
    orange = ((red > 130) & (green > 35) & (green < 190) &
              (blue < 100) & (red > 1.5 * green))
    labels, count = ndimage.label(orange)
    components = []
    for index, slices in enumerate(ndimage.find_objects(labels), 1):
        if slices is None:
            continue
        ys, xs = slices
        pixels = int(np.count_nonzero(labels[slices] == index))
        if pixels < max(10, int(.002 * (x2-x1) * bar_height)):
            continue
        if ys.stop-ys.start < max(8, .5 * bar_height):
            continue
        components.append((xs.start + left, ys.start + top, labels[slices] == index))
    if len(components) < 3:
        return None
    first_y = min(item[1] for item in components)
    digit_parts = sorted((item for item in components
                          if abs(item[1] - first_y) <= max(4, .1 * bar_height)),
                         key=lambda item: item[0])
    if not 2 <= len(digit_parts) <= 5:
        return None
    templates = _digit_templates()
    if not templates:
        return None
    digits = []
    for _, _, mask in digit_parts:
        target = np.asarray(Image.fromarray(mask).resize((32, 48), Image.Resampling.NEAREST), bool)
        ranked = sorted(((float(np.mean(target == template)), digit)
                         for digit, template in templates), reverse=True)
        best_score, best_digit = ranked[0]
        runner_up = max((score for score, digit in ranked if digit != best_digit), default=0)
        if best_score < .80 or best_score - runner_up < .07:
            return None
        digits.append(best_digit)
    if digits[0] == "0":
        return None
    # A second orange component to the right is expected for the µm suffix.
    if not any(x > digit_parts[-1][0] + digit_parts[-1][2].shape[1]
               for x, _, _ in components):
        return None
    value = int("".join(digits))
    return value if 1 <= value <= 100000 else None


def read_scale_bar(image: Image.Image):
    """Return a calibrated µm/px value only when bar and text both agree."""
    width, height = image.size
    region = (0, int(.7 * height), int(.35 * width), height)
    rgb = np.asarray(image.convert("RGB").crop(region))
    red, green, blue = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    bar_pixels = ((red > 180) & (green < 65) & (blue < 75) &
                  (red > 2.3 * green))
    labels, count = ndimage.label(bar_pixels)
    bars = []
    for index, slices in enumerate(ndimage.find_objects(labels), 1):
        if slices is None:
            continue
        ys, xs = slices
        bar_width, bar_height = xs.stop-xs.start, ys.stop-ys.start
        pixels = int(np.count_nonzero(labels[slices] == index))
        if bar_width >= 30 and bar_height >= 5 and pixels >= 100:
            bars.append((pixels, index, slices))
    if not bars:
        return None
    _, index, slices = max(bars)
    ys, xs = slices
    bar_mask = labels[slices] == index
    bar_height = ys.stop-ys.start
    bar_width = xs.stop-xs.start
    if bar_height > .3 * bar_width:
        projection = bar_mask.sum(axis=0)
        stripes = _groups(np.where(projection > .45 * projection.max())[0])
        if len(stripes) not in (2, 4):
            return None
        centers = [float(np.mean(stripe)) for stripe in stripes]
        length_px = (centers[2] + centers[3] - centers[0] - centers[1]) / 2 if len(stripes) == 4 else centers[1] - centers[0]
    else:
        length_px = float(bar_width-1)
    if length_px < 15:
        return None
    label_um = _read_label(rgb, (xs.start, ys.start, xs.stop, ys.stop), bar_height)
    if label_um is None:
        return None
    box = (xs.start, ys.start+region[1], xs.stop, ys.stop+region[1])
    return {"label_um": label_um, "bar_length_px": round(length_px, 1),
            "um_per_px": round(label_um / length_px, 6),
            "bar_box": list(box), "source": "image_scale_bar"}

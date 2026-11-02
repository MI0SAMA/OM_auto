"""Propose faint pads from a repeated, locally fitted OM grid."""
import numpy as np
from PIL import Image
from scipy import ndimage, signal
from scipy.spatial import cKDTree


def _estimate_pitch(points, diameter):
    tree = cKDTree(points)
    steps = []
    for index, center in enumerate(points):
        for other in tree.query_ball_point(center, 4 * diameter):
            if other <= index:
                continue
            dx, dy = abs(points[other] - center)
            if .5 * diameter < dx < 4 * diameter and dy < .5 * diameter:
                steps.append(dx)
            if .5 * diameter < dy < 4 * diameter and dx < .5 * diameter:
                steps.append(dy)
    if len(steps) < 50:
        return None
    hist = np.histogram(steps, bins=np.arange(0, 4 * diameter + 2, 1))[0]
    smooth = ndimage.gaussian_filter1d(hist.astype(float), 2)
    peaks, _ = signal.find_peaks(smooth, distance=max(5, int(.8 * diameter)))
    peaks = [p for p in peaks if 1.4 * diameter <= p <= 3.8 * diameter]
    return int(max(peaks, key=lambda p: smooth[p])) if peaks else None


def _segments(values, length, pitch):
    hist = np.bincount(values.astype(int), minlength=length).astype(float)
    wide = ndimage.gaussian_filter1d(hist, max(10, .52 * pitch))
    mask = wide > max(.12, wide.max() * .24)
    starts = np.where(mask & ~np.r_[False, mask[:-1]])[0]
    ends = np.where(mask & ~np.r_[mask[1:], False])[0]
    segments = []
    for start, end in zip(starts, ends):
        if segments and start - segments[-1][1] < .75 * pitch:
            segments[-1] = (segments[-1][0], int(end))
        else:
            segments.append((int(start), int(end)))
    return [(a, b) for a, b in segments if b - a > 2 * pitch]


def _merge_fragments(segments, block_width):
    merged = []
    for start, end in segments:
        if merged and start - merged[-1][0] < .85 * block_width:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


def _fit_lines(values, length, start_hint, count, pitch):
    if not len(values):
        return None
    hist = np.bincount(values.astype(int), minlength=length).astype(float)
    smooth = ndimage.gaussian_filter1d(hist, 3)
    best_score, best = -1, None
    steps = np.arange(pitch - max(1, .035 * pitch),
                      pitch + max(1, .035 * pitch) + .01, .25)
    starts = np.arange(max(0, start_hint + .2 * pitch),
                       min(length, start_hint + 1.3 * pitch) + .01, 1)
    for step in steps:
        for start in starts:
            lines = start + np.arange(count) * step
            if lines[-1] >= length:
                continue
            score = smooth[np.rint(lines).astype(int)].sum()
            if score > best_score:
                best_score, best = score, lines
    return best


def _spot_score(gray, x, y, center_mask, ring_mask, radius, sign):
    x, y = int(round(x)), int(round(y))
    if x < radius or y < radius or x + radius >= gray.shape[1] or y + radius >= gray.shape[0]:
        return None
    window = gray[y-radius:y+radius+1, x-radius:x+radius+1]
    return float(sign * (window[center_mask].mean() - window[ring_mask].mean()))


def complete_lattice(image: Image.Image, proposals, polarity="light"):
    """Return proposals plus image-supported missing sites; retain all originals."""
    result = [dict(p) for p in proposals]
    high = [p for p in result if p.get("confidence") == "high"]
    if len(high) < 80:
        return result, {"applied": False, "inferred": 0, "blocks": 0}
    diameter = float(np.median([min(p["width_px"], p["height_px"]) for p in high]))
    # Small half-pitch rows can bridge the whitespace between repeated units.
    # Fit the unit boundaries from the main-pad population, then add small rows.
    large_high = [p for p in high if min(p["width_px"], p["height_px"]) >= .7 * diameter]
    if len(large_high) < 80:
        return result, {"applied": False, "inferred": 0, "blocks": 0}
    points = np.array([(p["x"], p["y"]) for p in large_high], dtype=float)
    pitch = _estimate_pitch(points, diameter)
    if not pitch:
        return result, {"applied": False, "inferred": 0, "blocks": 0}
    x_segments = _segments(points[:, 0], image.width, pitch)
    y_segments = _segments(points[:, 1], image.height, pitch)
    if not x_segments or not y_segments:
        return result, {"applied": False, "inferred": 0, "blocks": 0}
    longest_x = max(b-a for a, b in x_segments)
    longest_y = max(b-a for a, b in y_segments)
    longest = max(longest_x, longest_y)
    widths = [b-a for a, b in x_segments + y_segments if b-a > .7 * longest]
    block_width = float(np.median(widths))
    count = round((block_width - 1.35 * pitch) / pitch) + 1
    if (not 6 <= count <= 18 or abs(longest_x - longest_y) > .25 * block_width):
        return result, {"applied": False, "inferred": 0, "blocks": 0}
    x_segments = _merge_fragments(x_segments, block_width)
    y_segments = _merge_fragments(y_segments, block_width)
    if len(x_segments) * len(y_segments) > 25:
        return result, {"applied": False, "inferred": 0, "blocks": 0}

    gray = np.asarray(image.convert("L"), dtype=np.float32)
    sign = 1 if polarity == "light" else -1

    def masks(size):
        radius = max(10, int(round(.95 * size)))
        yy, xx = np.ogrid[-radius:radius+1, -radius:radius+1]
        distance = np.sqrt(xx*xx + yy*yy)
        return radius, distance <= max(2, .25 * size), (distance >= .6 * size) & (distance <= .95 * size)

    radius, center_mask, ring_mask = masks(diameter)
    candidate_points = np.array([(p["x"], p["y"]) for p in result])
    candidate_tree = cKDTree(candidate_points)
    units = []
    large_sites = []
    matched_cells = 0
    inferred_cells = 0
    for unit_row, (y_start, _) in enumerate(y_segments, 1):
        for unit_col, (x_start, _) in enumerate(x_segments, 1):
            local = points[(points[:, 0] > x_start - 20) &
                           (points[:, 0] < x_start + block_width + 20) &
                           (points[:, 1] > y_start - 20) &
                           (points[:, 1] < y_start + block_width + 20)]
            if len(local) < 30:
                continue
            x_lines = _fit_lines(local[:, 0], image.width, x_start, count, pitch)
            y_lines = _fit_lines(local[:, 1], image.height, y_start, count, pitch)
            if x_lines is None or y_lines is None:
                continue
            sites = np.array([(x, y) for y in y_lines for x in x_lines])
            distances, indices = candidate_tree.query(sites)
            matched = distances < .35 * pitch
            if matched.mean() < .55:
                continue
            scores = [_spot_score(gray, x, y, center_mask, ring_mask, radius, sign)
                      for x, y in sites]
            reference = [score for score, is_matched in zip(scores, matched)
                         if is_matched and score is not None]
            if len(reference) < 30:
                continue
            threshold = max(4, float(np.quantile(reference, .1)) - 1)
            block_high = [p for p in large_high if x_start-20 < p["x"] < x_start+block_width+20 and
                          y_start-20 < p["y"] < y_start+block_width+20]
            size = float(np.median([min(p["width_px"], p["height_px"]) for p in block_high]))
            shape = "circle" if sum(p["shape_guess"] == "circle" for p in block_high) > len(block_high) * .5 else "other"
            unit_id = f"U{(unit_row-1)*len(x_segments)+unit_col}"
            unit = {"unit_row": unit_row, "unit_col": unit_col, "layout_unit_id": unit_id,
                    "x_lines": x_lines, "y_lines": y_lines, "large_size": size,
                    "shape": shape, "small_sites": [], "small_scores": []}
            units.append(unit)
            for site_index, ((x, y), is_matched, index, score) in enumerate(zip(sites, matched, indices, scores)):
                if is_matched:
                    confidence = "high"
                    matched_cells += 1
                elif score is not None and score >= threshold:
                    confidence = "grid_inferred"
                    inferred_cells += 1
                else:
                    confidence = "layout_only"
                observed = result[int(index)] if is_matched else None
                large_sites.append({"x": round(float(x), 1), "y": round(float(y), 1),
                                    "width_px": round(size, 1), "height_px": round(size, 1),
                                    "shape_guess": shape, "fill": observed.get("fill") if observed else None,
                                    "grid_support": observed.get("grid_support") if observed else None,
                                    "confidence": confidence, "pad_class": "large",
                                    "layout_unit_id": unit_id, "unit_row": unit_row, "unit_col": unit_col,
                                    "pad_row": site_index // count + 1, "pad_col": site_index % count + 1,
                                    "signal_score": round(score, 2) if score is not None else None})
    if not units:
        return result, {"applied": False, "inferred": 0, "blocks": 0}

    # Some layouts have two half-pitch rows above the main array; others have
    # them below. Require a repeated image signal before completing either.
    small_radius, small_center, small_ring = masks(diameter * .48)
    def small_grid(unit, position):
        xs = unit["x_lines"][0] - pitch / 4 + np.arange(count * 2) * pitch / 2
        ys = (unit["y_lines"][0] - 7 * pitch / 6 + np.arange(2) * pitch / 2
              if position == "top" else
              unit["y_lines"][-1] + 2 * pitch / 3 + np.arange(2) * pitch / 2)
        sites = np.array([(x, y) for y in ys for x in xs])
        scores = [_spot_score(gray, x, y, small_center, small_ring, small_radius, sign)
                  for x, y in sites]
        return sites, scores

    patterns = {}
    for position in ("top", "bottom"):
        probes = [small_grid(unit, position) for unit in units]
        valid = [score for _, scores in probes for score in scores if score is not None]
        patterns[position] = bool(len(valid) >= len(units) * count and
                                  np.median(valid) > 1.5 and
                                  np.mean(np.array(valid) > 1.5) > .5)
    if patterns["top"]:
        for site in large_sites:
            site["pad_row"] += 2

    def refine_top_grid(unit, sites):
        """Align faint rows to their own contrast rather than the main pitch."""
        row_width = count * 2
        base_x = sites[0, 0]
        base_ys = (sites[0, 1], sites[row_width, 1])
        best = (-np.inf, 0, (0, 0))
        for dx in range(-7, 8):
            row_best = []
            for y in base_ys:
                alternatives = []
                for dy in range(-8, 9):
                    scores = [_spot_score(gray, base_x + dx + col * pitch / 2,
                                          y + dy, small_center, small_ring,
                                          small_radius, sign)
                              for col in range(row_width)]
                    valid = [s for s in scores if s is not None]
                    alternatives.append((float(np.mean(valid)) if valid else -np.inf, dy))
                row_best.append(max(alternatives))
            total = sum(score for score, _ in row_best)
            if total > best[0]:
                best = (total, dx, tuple(dy for _, dy in row_best))
        _, dx, shifts = best
        aligned = sites.copy()
        aligned[:, 0] += dx
        aligned[:row_width, 1] += shifts[0]
        aligned[row_width:, 1] += shifts[1]
        scores = [_spot_score(gray, x, y, small_center, small_ring,
                              small_radius, sign) for x, y in aligned]
        return aligned, scores

    small_sites = []
    for position in ("top", "bottom"):
        if not patterns[position]:
            continue
        for unit in units:
            sites, scores = small_grid(unit, position)
            if position == "top":
                sites, scores = refine_top_grid(unit, sites)
            size = unit["large_size"] * .48
            small_raw = [p for p in result
                         if min(p["width_px"], p["height_px"]) < .7 * unit["large_size"] and
                         unit["x_lines"][0]-pitch < p["x"] < unit["x_lines"][-1]+pitch and
                         sites[0, 1]-pitch/2 < p["y"] < sites[-1, 1]+pitch/2]
            if len(small_raw) >= 3:
                size = float(np.clip(np.median([min(p["width_px"], p["height_px"]) for p in small_raw]),
                                     .3 * unit["large_size"], .7 * unit["large_size"]))
            tree = cKDTree([(p["x"], p["y"]) for p in small_raw]) if small_raw else None
            distances = tree.query(sites)[0] if tree else np.full(len(sites), np.inf)
            for site_index, ((x, y), score, distance) in enumerate(zip(sites, scores, distances)):
                if distance < max(4, .28 * pitch / 2):
                    confidence = "high"
                    matched_cells += 1
                elif score is not None and score >= 2:
                    confidence = "grid_inferred"
                    inferred_cells += 1
                else:
                    confidence = "layout_only"
                small_sites.append({"x": round(float(x), 1), "y": round(float(y), 1),
                                    "width_px": round(size, 1), "height_px": round(size, 1),
                                    "shape_guess": "square" if position == "top" else unit["shape"], "fill": None,
                                    "grid_support": None, "confidence": confidence,
                                    "pad_class": "small", "layout_unit_id": unit["layout_unit_id"],
                                    "unit_row": unit["unit_row"], "unit_col": unit["unit_col"],
                                    "pad_row": (1 if position == "top" else count +
                                                (2 if patterns["top"] else 0) + 1) +
                                               site_index // (count * 2),
                                    "pad_col": site_index % (count * 2) + 1,
                                    "signal_score": round(score, 2) if score is not None else None})

    # Some repeated blocks have two narrow columns on the left. Their rows
    # have half the pitch of the main 12x12 grid. Require raw candidates at
    # the predicted sites in several blocks before completing this pattern.
    side_sites = []
    side_size = None
    raw_side = [p for p in result if min(p["width_px"], p["height_px"]) < .7 * diameter]
    if raw_side:
        side_tree = cKDTree([(p["x"], p["y"]) for p in raw_side])
        side_probes = []
        for unit in units:
            x0, y0 = unit["x_lines"][0], unit["y_lines"][0]
            sites = np.array([(x0 - 1.1 * pitch + col * pitch / 2,
                               y0 - pitch / 4 + row * pitch / 2)
                              for row in range(2 * count) for col in range(2)])
            distances, indices = side_tree.query(sites)
            matched = distances < .18 * pitch
            side_probes.append((unit, sites, matched, indices))
        supported = [int(matched.sum()) for _, _, matched, _ in side_probes]
        side_pattern = (sum(supported) >= 4 * count and
                        sum(hits >= max(6, count // 2) for hits in supported) >= 3)
        if side_pattern:
            observed_sizes = [min(raw_side[int(index)]["width_px"], raw_side[int(index)]["height_px"])
                              for _, _, matched, indices in side_probes
                              for hit, index in zip(matched, indices) if hit]
            side_size = float(np.median(observed_sizes))
            side_radius, side_center, side_ring = masks(side_size)
            for unit, sites, matched, indices in side_probes:
                # Let visible tiny pads refine the phase of each block. Sparse
                # blocks keep the phase inherited from their main array.
                if matched.sum() >= 6:
                    observed = np.array([(raw_side[int(index)]["x"], raw_side[int(index)]["y"])
                                         for hit, index in zip(matched, indices) if hit])
                    residual = np.median(observed - sites[matched], axis=0)
                    sites += np.clip(residual, -.15 * pitch, .15 * pitch)
                distances, indices = side_tree.query(sites)
                matched = distances < .18 * pitch
                scores = [_spot_score(gray, x, y, side_center, side_ring, side_radius, sign)
                          for x, y in sites]
                reference = [score for score, hit in zip(scores, matched) if hit and score is not None]
                threshold = max(1.5, float(np.quantile(reference, .1)) - .5) if len(reference) >= 5 else 2.
                for site_index, ((x, y), hit, index, score) in enumerate(zip(sites, matched, indices, scores)):
                    if hit:
                        confidence = "high"
                        matched_cells += 1
                    elif score is not None and score >= threshold:
                        confidence = "grid_inferred"
                        inferred_cells += 1
                    else:
                        confidence = "layout_only"
                    side_sites.append({"x": round(float(x), 1), "y": round(float(y), 1),
                                       "width_px": round(side_size, 1), "height_px": round(side_size, 1),
                                       "shape_guess": "square", "fill": None, "grid_support": None,
                                       "confidence": confidence, "pad_class": "tiny",
                                       "layout_unit_id": unit["layout_unit_id"],
                                       "unit_row": unit["unit_row"], "unit_col": unit["unit_col"],
                                       "pad_row": site_index // 2 + 1, "pad_col": site_index % 2 + 1,
                                       "signal_score": round(score, 2) if score is not None else None})
            for site in large_sites + small_sites:
                site["pad_col"] += 2

    output = sorted(large_sites + small_sites + side_sites, key=lambda p: (p["y"], p["x"]))
    big_size = round(float(np.median([unit["large_size"] for unit in units])), 1)
    small_size = round(float(np.median([p["width_px"] for p in small_sites + side_sites])), 1) if small_sites or side_sites else None
    total = len(output)
    return output, {"applied": True, "inferred": inferred_cells, "blocks": len(units),
                    "unit_rows": len(y_segments), "unit_cols": len(x_segments),
                    "pitch_px": pitch, "large_rows": count, "large_cols": count,
                    "small_rows": 2 * count if side_sites else 2 * sum(patterns.values()),
                    "small_cols": 2 if side_sites else count * 2 if any(patterns.values()) else 0,
                    "small_position": ("left" if side_sites else
                                       "both" if all(patterns.values()) else
                                       "top" if patterns["top"] else
                                       "bottom" if patterns["bottom"] else None),
                    "top_small_rows": 2 if patterns["top"] else 0,
                    "bottom_small_rows": 2 if patterns["bottom"] else 0,
                    "left_small_rows": 2 * count if side_sites else 0,
                    "left_small_cols": 2 if side_sites else 0,
                    "shape_guess": "circle" if sum(u["shape"] == "circle" for u in units) > len(units)/2 else "other",
                    "large_size_px": big_size, "small_size_px": small_size,
                    "cells_per_block": count * count + 2 * count * 2 * sum(patterns.values()) +
                                       (4 * count if side_sites else 0),
                    "matched_cells": matched_cells, "candidate_cells": total,
                    "layout_only": sum(p["confidence"] == "layout_only" for p in output)}


def complete_graded_rows(image: Image.Image, proposals, polarity="light"):
    """Fit repeated bands whose pairs of rows have progressively larger pads."""
    original = [dict(p) for p in proposals]
    high = [p for p in original if p.get("confidence") == "high"]
    if len(high) < 150:
        return original, {"applied": False, "inferred": 0, "blocks": 0}
    large = [p for p in high if min(p["width_px"], p["height_px"]) >= 45]
    if len(large) < 80:
        return original, {"applied": False, "inferred": 0, "blocks": 0}
    hist = np.bincount(np.rint([p["y"] for p in large]).astype(int), minlength=image.height).astype(float)
    smooth = ndimage.gaussian_filter1d(hist, 8)
    peaks, properties = signal.find_peaks(smooth, distance=55, prominence=max(.1, .22*smooth.max()))
    peaks = np.array([p for p in peaks if smooth[p] > .25*smooth.max()])
    if len(peaks) != 8:
        return original, {"applied": False, "inferred": 0, "blocks": 0}
    pairs = peaks.reshape(4, 2)
    intra = np.diff(pairs, axis=1).ravel()
    band_steps = np.diff(pairs[:, 0])
    if not (np.all((65 < intra) & (intra < 140)) and
            np.all((450 < band_steps) & (band_steps < 750)) and
            np.std(band_steps) < .08*np.mean(band_steps)):
        return original, {"applied": False, "inferred": 0, "blocks": 0}

    # The largest pair can be at either end of each repeated band. Derive the
    # remaining six rows from the first band, then share their offsets.
    all_hist = np.bincount(np.rint([p["y"] for p in original]).astype(int), minlength=image.height).astype(float)
    all_smooth = ndimage.gaussian_filter1d(all_hist, 7)
    all_peaks, _ = signal.find_peaks(all_smooth, distance=27, prominence=max(.07, .13*all_smooth.max()))
    first_large = int(pairs[0, 0])
    before = [int(y) for y in all_peaks if first_large-410 < y < first_large-30]
    next_band = int(pairs[1, 0])
    after = [int(y) for y in all_peaks if pairs[0, 1]+30 < y < next_band-30]
    if len(before) >= 6:
        row_centers = before[-6:] + [first_large, int(pairs[0, 1])]
        classes = ("tiny", "small", "medium", "large")
        nominal = (12, 23, 34, 58)
    elif len(after) >= 6:
        row_centers = [first_large, int(pairs[0, 1])] + after[:6]
        classes = ("large", "medium", "small", "tiny")
        nominal = (58, 34, 23, 12)
    else:
        return original, {"applied": False, "inferred": 0, "blocks": 0}
    offsets = np.array(row_centers, dtype=float) - first_large
    if not (np.all(np.diff(offsets) > 25) and np.all(np.diff(offsets) < 115)):
        return original, {"applied": False, "inferred": 0, "blocks": 0}

    # This layout has four horizontal groups per band.  The gaps between
    # groups are real; treating all columns as one uniform grid shifts the
    # middle columns and can lose the last column at the right edge.
    columns_per_group = {"tiny": 24, "small": 12, "medium": 8, "large": 5}
    large_rows = [
        sorted(p["x"] for p in large if abs(p["y"] - row_y) < 14)
        for row_y in peaks
    ]
    complete_large_rows = [xs for xs in large_rows if len(xs) == 20]
    if len(complete_large_rows) < 2:
        return original, {"applied": False, "inferred": 0, "blocks": 0}
    large_first = float(np.median([xs[0] for xs in complete_large_rows]))
    large_step = float(np.median([
        b - a for xs in complete_large_rows for a, b in zip(xs, xs[1:])
    ]))
    group_step = 5 * large_step
    large_size = float(np.median([min(p["width_px"], p["height_px"]) for p in large]))
    gray = np.asarray(image.convert("L"), dtype=np.float32)
    sign = 1 if polarity == "light" else -1
    output = []
    groups = []
    matched_count = inferred_count = 0
    for group, (kind, nominal_size) in enumerate(zip(classes, nominal)):
        row_offsets = offsets[group*2:group*2+2]
        row_centers = [float(anchor + offset) for anchor in pairs[:, 0] for offset in row_offsets]
        nearby = [p for p in high if any(abs(p["y"]-row_y) < 14 for row_y in row_centers)
                  and .7*nominal_size < min(p["width_px"], p["height_px"]) < 1.35*nominal_size]
        if len(nearby) < 25:
            return original, {"applied": False, "inferred": 0, "blocks": 0}
        size = float(np.median([min(p["width_px"], p["height_px"]) for p in nearby]))
        steps = []
        for row_y in row_centers:
            xs = np.sort([p["x"] for p in nearby if abs(p["y"]-row_y) < 14])
            dx = np.diff(xs)
            steps.extend(dx[(dx > 1.4*size) & (dx < 2.8*size)])
        if len(steps) < 12:
            return original, {"applied": False, "inferred": 0, "blocks": 0}
        step_hist = np.histogram(steps, bins=np.arange(0, max(steps)+2, 1))[0]
        pitch_peak = float(np.argmax(ndimage.gaussian_filter1d(step_hist.astype(float), 2)))
        pitch = float(np.median([step for step in steps if abs(step-pitch_peak) < 2]))
        cols_per_group = columns_per_group[kind]
        if not .82 <= group_step / (cols_per_group * pitch) <= 1.18:
            return original, {"applied": False, "inferred": 0, "blocks": 0}
        # Fit each group independently.  Sparse or invisible groups inherit
        # the offset from the visible groups, preserving every layout site.
        group_fits = []
        for group_index in range(4):
            guess = large_first + group_index * group_step - .5 * (large_size - size)
            matches = []
            for p in nearby:
                col = int(round((p["x"] - guess) / pitch))
                if 0 <= col < cols_per_group and abs(p["x"] - guess - col * pitch) < .35 * pitch:
                    matches.append((col, p["x"]))
            if len(matches) >= 8 and len({col for col, _ in matches}) >= 4:
                indices = np.array([col for col, _ in matches], dtype=float)
                observed_x = np.array([x for _, x in matches], dtype=float)
                fitted_pitch, phase = np.polyfit(indices, observed_x, 1)
                if abs(fitted_pitch - pitch) < .05 * pitch and abs(phase - guess) < .35 * pitch:
                    group_fits.append((float(phase), float(fitted_pitch)))
                    continue
            group_fits.append(None)
        offsets_x = [fit[0] - (large_first + index * group_step)
                     for index, fit in enumerate(group_fits) if fit is not None]
        if not offsets_x:
            return original, {"applied": False, "inferred": 0, "blocks": 0}
        shared_offset = float(np.median(offsets_x))
        x_groups = []
        for group_index, fit in enumerate(group_fits):
            phase, fitted_pitch = fit if fit is not None else (
                large_first + group_index * group_step + shared_offset, pitch)
            lines = phase + np.arange(cols_per_group) * fitted_pitch
            if lines[0] < 0 or lines[-1] >= image.width:
                return original, {"applied": False, "inferred": 0, "blocks": 0}
            x_groups.append(lines)
        x_lines = np.concatenate(x_groups)
        cols = len(x_lines)
        radius = max(7, int(round(.95*size)))
        yy, xx = np.ogrid[-radius:radius+1, -radius:radius+1]
        distance = np.sqrt(xx*xx+yy*yy)
        center_mask = distance <= max(2, .25*size)
        ring_mask = (distance >= .6*size) & (distance <= .95*size)
        tree = cKDTree([(p["x"], p["y"]) for p in nearby])
        shape = "circle" if kind == "tiny" else "square"
        for unit_index, anchor in enumerate(pairs[:, 0]):
            for row_in_pair, offset in enumerate(row_offsets):
                expected_y = float(anchor + offset)
                supported_y = [p["y"] for p in nearby if abs(p["y"] - expected_y) < 14]
                y = float(np.median(supported_y)) if len(supported_y) >= 3 else expected_y
                if y < 0 or y >= image.height:
                    continue
                sites = np.column_stack((x_lines, np.full(cols, y)))
                distances, indices = tree.query(sites)
                scores = [_spot_score(gray, x, y, center_mask, ring_mask, radius, sign)
                          for x in x_lines]
                observed_scores = [s for s, d in zip(scores, distances) if d < .3*pitch and s is not None]
                threshold = max(2., float(np.quantile(observed_scores, .1))-1) if len(observed_scores) >= 5 else 3.
                for col_index, (x, d, idx, score) in enumerate(zip(x_lines, distances, indices, scores), 1):
                    matched = d < min(.28*pitch, .55*size)
                    if matched:
                        confidence = "high"
                        matched_count += 1
                    elif score is not None and score >= threshold:
                        confidence = "grid_inferred"
                        inferred_count += 1
                    else:
                        confidence = "layout_only"
                    observed = nearby[int(idx)] if matched else None
                    output.append({"x": round(float(x), 1), "y": round(y, 1),
                                   "width_px": round(size, 1), "height_px": round(size, 1),
                                   "shape_guess": shape, "fill": observed.get("fill") if observed else None,
                                   "grid_support": observed.get("grid_support") if observed else None,
                                   "confidence": confidence, "pad_class": kind,
                                   "layout_unit_id": f"U{unit_index+1}", "unit_row": unit_index+1,
                                   "unit_col": 1, "pad_row": group*2+row_in_pair+1,
                                   "pad_col": col_index,
                                   "signal_score": round(score, 2) if score is not None else None})
        groups.append({"pad_class": kind, "rows": 2, "cols": cols,
                       "groups": 4, "cols_per_group": cols_per_group,
                       "size_px": round(size, 1), "shape_guess": shape})
    output.sort(key=lambda p: (p["y"], p["x"]))
    return output, {"applied": True, "layout_kind": "graded_rows", "blocks": 4,
                    "unit_rows": 4, "unit_cols": 1, "row_groups": groups,
                    "cells_per_block": sum(g["rows"]*g["cols"] for g in groups),
                    "candidate_cells": len(output), "matched_cells": matched_count,
                    "inferred": inferred_count,
                    "layout_only": sum(p["confidence"] == "layout_only" for p in output)}


def complete_layout(image: Image.Image, proposals, polarity="light"):
    result, metadata = complete_lattice(image, proposals, polarity)
    if metadata["applied"]:
        return result, metadata
    return complete_graded_rows(image, proposals, polarity)

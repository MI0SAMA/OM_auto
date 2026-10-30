from PIL import Image, ImageDraw

from om_auto.lattice import complete_graded_rows


def test_graded_rows_keep_group_gaps_and_last_columns():
    """Four repeated groups have spacers, so a single uniform pitch drifts."""
    image = Image.new("L", (2742, 2521), 95)
    draw = ImageDraw.Draw(image)
    proposals = []
    layout = (
        ("tiny", 12, 24, 24.2, 161, (-376, -329)),
        ("small", 23, 12, 48.3, 165, (-272, -224)),
        ("medium", 34, 8, 72.5, 171, (-157, -85)),
        ("large", 58, 5, 120.5, 184, (0, 97)),
    )
    for band, anchor in enumerate((408, 1009, 1612, 2214)):
        for kind, size, count, pitch, first, row_offsets in layout:
            for offset in row_offsets:
                y = anchor + offset
                for group in range(4):
                    for col in range(count):
                        x = first + 602 * group + pitch * col
                        radius = size * .24
                        draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=185)
                        # Keep large anchors complete.  The other rows have
                        # sparse detections at the center and right edge.
                        observed = kind == "large" or (group == 0 and col < count - 1)
                        if kind == "small" and group == 3 and col < 7:
                            observed = True
                        if kind == "medium" and group == 3 and col < 5:
                            observed = True
                        if observed:
                            proposals.append({"x": x, "y": y, "width_px": size,
                                              "height_px": size, "shape_guess": "circle",
                                              "confidence": "high"})

    result, metadata = complete_graded_rows(image, proposals)
    assert metadata["applied"]
    assert metadata["candidate_cells"] == 4 * 2 * 4 * (24 + 12 + 8 + 5)
    assert [(row["pad_class"], row["cols"]) for row in metadata["row_groups"]] == [
        ("tiny", 96), ("small", 48), ("medium", 32), ("large", 20)]
    for kind, _, count, pitch, first, row_offsets in layout:
        last = next(p for p in result if p["pad_class"] == kind and
                    p["unit_row"] == 4 and p["pad_row"] ==
                    {"tiny": 2, "small": 4, "medium": 6, "large": 8}[kind] and
                    p["pad_col"] == 4 * count)
        assert abs(last["x"] - (first + 3 * 602 + (count - 1) * pitch)) < 5
        assert abs(last["y"] - (2214 + row_offsets[1])) < 3

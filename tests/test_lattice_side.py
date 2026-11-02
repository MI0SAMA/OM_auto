from PIL import Image, ImageDraw

from om_auto.lattice import complete_lattice


def test_repeated_left_tiny_columns_are_kept_and_completed():
    image = Image.new('L', (2120, 2120), 100)
    draw = ImageDraw.Draw(image)
    proposals = []
    for unit_row in range(3):
        for unit_col in range(3):
            x0, y0 = 180 + 660 * unit_col, 100 + 660 * unit_row
            for row in range(12):
                for col in range(12):
                    x, y = x0 + 48 * col, y0 + 48 * row
                    draw.ellipse((x - 12, y - 12, x + 12, y + 12), fill=130)
                    proposals.append({'x': x, 'y': y, 'width_px': 25,
                                      'height_px': 25, 'shape_guess': 'circle',
                                      'confidence': 'high'})
            for row in range(24):
                for col in range(2):
                    x, y = x0 - 53 + 24 * col, y0 - 12 + 24 * row
                    draw.rectangle((x - 5, y - 5, x + 5, y + 5), fill=116)
                    if unit_row == unit_col == 0 and row in (4, 5, 6):
                        continue
                    proposals.append({'x': x, 'y': y, 'width_px': 11,
                                      'height_px': 11, 'shape_guess': 'square',
                                      'confidence': 'high'})

    result, grid = complete_lattice(image, proposals)
    assert grid['applied'] and grid['blocks'] == 9
    assert grid['left_small_rows'] == 24 and grid['left_small_cols'] == 2
    assert grid['candidate_cells'] == 9 * (12 * 12 + 24 * 2)
    tiny = [p for p in result if p['pad_class'] == 'tiny']
    assert len(tiny) == 9 * 48
    assert all(p['shape_guess'] == 'square' for p in tiny)
    assert {p['pad_col'] for p in result if p['pad_class'] == 'large'} == set(range(3, 15))
    assert len({(p['layout_unit_id'], p['pad_row'], p['pad_col']) for p in result}) == len(result)
    assert any(p['layout_unit_id'] == 'U1' and p['pad_row'] == 5 and
               p['pad_col'] == 1 and p['confidence'] == 'grid_inferred' for p in tiny)

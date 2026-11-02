from PIL import Image, ImageDraw

from om_auto import lattice


def test_faint_bottom_rows_use_each_units_fitted_pitch(monkeypatch):
    image = Image.new('L', (1450, 1450), 100)
    draw = ImageDraw.Draw(image)
    proposals = []
    for block_row in range(2):
        for block_col in range(2):
            x0, y0 = 120 + block_col * 660, 120 + block_row * 660
            for row in range(12):
                for col in range(12):
                    x, y = x0 + 48 * col, y0 + 48 * row
                    draw.ellipse((x - 12, y - 12, x + 12, y + 12), fill=130)
                    proposals.append({'x': x, 'y': y, 'width_px': 25,
                                      'height_px': 25, 'shape_guess': 'circle',
                                      'confidence': 'high'})
            for row in range(2):
                for col in range(24):
                    x, y = x0 - 12 + 24 * col, y0 + 11 * 48 + 32 + 24 * row
                    draw.rectangle((x - 5, y - 5, x + 5, y + 5), fill=107)

    # A one-pixel error in the global pitch shifts the last small column by
    # about 12 pixels; the locally fitted main grid still has the right pitch.
    monkeypatch.setattr(lattice, '_estimate_pitch', lambda *_: 47)
    result, grid = lattice.complete_lattice(image, proposals)
    assert grid['applied'] and grid['bottom_small_rows'] == 2
    assert grid['small_cols'] == 24 and grid['candidate_cells'] == 4 * (144 + 48)
    assert len([p for p in result if p['pad_class'] == 'small']) == 4 * 48

from PIL import Image, ImageDraw, ImageFont

from om_auto.calibration import read_scale_bar


def test_read_scale_bar_uses_tick_centers_and_label():
    image = Image.new("RGB", (1200, 900), (20, 20, 20))
    draw = ImageDraw.Draw(image)
    draw.rectangle((140, 650, 160, 730), fill=(250, 0, 0))
    draw.rectangle((360, 650, 380, 730), fill=(250, 0, 0))
    draw.rectangle((150, 682, 370, 698), fill=(250, 0, 0))
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 70)
    draw.text((110, 755), "500µm", font=font, fill=(255, 100, 0))
    scale = read_scale_bar(image)
    assert scale["label_um"] == 500
    assert scale["bar_length_px"] == 220
    assert abs(scale["um_per_px"] - 500 / 220) < 1e-5


def test_read_scale_bar_needs_text_and_line():
    image = Image.new("RGB", (1200, 900), (20, 20, 20))
    draw = ImageDraw.Draw(image)
    draw.rectangle((140, 650, 160, 730), fill=(250, 0, 0))
    draw.rectangle((360, 650, 380, 730), fill=(250, 0, 0))
    draw.rectangle((150, 682, 370, 698), fill=(250, 0, 0))
    assert read_scale_bar(image) is None


def test_read_scale_bar_blue_with_black_label():
    image = Image.new("RGB", (1200, 900), (20, 20, 20))
    draw = ImageDraw.Draw(image)
    blue = (0, 0, 250)
    draw.rectangle((140, 650, 146, 720), fill=blue)
    draw.rectangle((380, 650, 386, 720), fill=blue)
    draw.rectangle((143, 680, 383, 689), fill=blue)
    draw.rectangle((105, 735, 570, 850), fill="white")
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 70)
    draw.text((115, 745), "2000µm", font=font, fill="black")
    scale = read_scale_bar(image)
    assert scale is not None
    assert scale["label_um"] == 2000
    assert abs(scale["bar_length_px"] - 240) <= 1
    assert abs(scale["um_per_px"] - 2000 / 240) < .05

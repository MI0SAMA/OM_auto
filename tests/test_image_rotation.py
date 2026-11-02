"""Image rotation keeps original coordinates and files available for recovery."""
import io
import json
from pathlib import Path

from PIL import Image

import om_auto.server as server
from om_auto.store import connect


def post_rotation(payload):
    body = json.dumps(payload).encode()

    class Request:
        path = "/api/rotate-image"
        headers = {"Content-Length": str(len(body))}
        rfile = io.BytesIO(body)

        def send(self, data, status=200, content_type=None, headers=None):
            self.result = status, data

    request = Request()
    server.Handler.do_POST(request)
    return request.result


def test_rotate_image_creates_new_primary_and_keeps_original(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA", tmp_path)
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "test.sqlite3")
    original = tmp_path / "original.png"
    Image.new("RGB", (60, 40), (80, 120, 160)).save(original)
    with connect(server.DB_PATH) as db:
        db.execute("INSERT INTO samples(sample_id) VALUES('S')")
        db.execute("""INSERT INTO images(image_id,sample_id,file_path,width_px,height_px,role,original_name)
                      VALUES('original','S',?,60,40,'primary','ZHENGPIAN.png')""", (str(original),))
        db.commit()

    status, result = post_rotation({"sample_id": "S", "image_id": "original", "angle_deg": 90})
    assert status == 200
    assert (result["width_px"], result["height_px"]) == (40, 60)
    with connect(server.DB_PATH) as db:
        images = db.execute("SELECT image_id,role,file_path FROM images WHERE sample_id='S'").fetchall()
        assert len(images) == 2
        assert {row["image_id"]: row["role"] for row in images} == {
            "original": "supplement", result["image_id"]: "primary"}
        rotated_path = Path(next(row["file_path"] for row in images if row["image_id"] == result["image_id"]))
    assert original.exists() and rotated_path.exists()
    with Image.open(rotated_path) as image:
        assert image.size == (40, 60)


def test_rotate_image_rejects_zero_angle_without_new_file(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA", tmp_path)
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "test.sqlite3")
    original = tmp_path / "original.jpg"
    Image.new("RGB", (50, 50), "white").save(original)
    with connect(server.DB_PATH) as db:
        db.execute("INSERT INTO samples(sample_id) VALUES('S')")
        db.execute("""INSERT INTO images(image_id,sample_id,file_path,width_px,height_px,role,original_name)
                      VALUES('original','S',?,50,50,'primary','ZHENGPIAN.jpg')""", (str(original),))
        db.commit()

    status, result = post_rotation({"sample_id": "S", "image_id": "original", "angle_deg": 0})
    assert status == 400 and "旋转角度" in result["error"]
    with connect(server.DB_PATH) as db:
        assert db.execute("SELECT count(*) FROM images WHERE sample_id='S'").fetchone()[0] == 1

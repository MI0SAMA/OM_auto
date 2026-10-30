"""Import selected local/NAS-backed OM files without touching their originals."""
import argparse
import hashlib
from pathlib import Path
import shutil
import uuid

from om_auto.server import DATA, DB_PATH
from om_auto.store import connect, rows
from om_auto.vision import inspect_image

parser = argparse.ArgumentParser()
parser.add_argument('--sample', required=True, help='Sample ID in OM Auto')
parser.add_argument('--dir', required=True, type=Path, help='One 00_OM directory')
parser.add_argument('--pattern', default='*.jpg', help='Glob within the directory')
args = parser.parse_args()

source = args.dir.expanduser().resolve()
if not source.is_dir() or source.name != '00_OM':
    parser.error('--dir must be an existing 00_OM directory')
files = sorted(p for p in source.glob(args.pattern) if p.is_file() and p.suffix.lower() in {'.jpg','.jpeg','.png'})
if not files:
    parser.error('No matching JPEG/PNG images')
db = connect(DB_PATH)
db.execute('INSERT OR IGNORE INTO samples(sample_id,notes) VALUES(?,?)',
           (args.sample,'OM image import; Pad IDs and calibration pending'))
db.commit()
if db.execute('SELECT deleted_at FROM samples WHERE sample_id=?', (args.sample,)).fetchone()[0]:
    parser.error('Sample is deleted; restore it in the application before importing images')
target = DATA / 'images'
target.mkdir(parents=True, exist_ok=True)
known = set()
for item in rows(db,'SELECT file_path FROM images WHERE sample_id=?',(args.sample,)):
    existing=Path(item['file_path'])
    if existing.is_file():
        known.add(hashlib.sha256(existing.read_bytes()).hexdigest())
for file in files:
    content=file.read_bytes()
    digest=hashlib.sha256(content).hexdigest()
    if digest in known:
        print(args.sample,file.name,'already imported')
        continue
    width,height = inspect_image(content)
    image_id=uuid.uuid4().hex
    dest=target/(image_id+file.suffix.lower())
    shutil.copy2(file,dest)
    role='primary' if file.stem.upper()=='ZHENGPIAN' else 'supplement'
    if role=='primary':
        db.execute("UPDATE images SET role='supplement' WHERE sample_id=?",(args.sample,))
    db.execute('INSERT INTO images(image_id,sample_id,file_path,width_px,height_px,role,original_name) VALUES(?,?,?,?,?,?,?)',
               (image_id,args.sample,str(dest),width,height,role,file.name))
    print(args.sample,file.name,role,image_id,width,height)
    known.add(digest)
db.commit()

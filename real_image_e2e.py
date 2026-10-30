"""End-to-end API exercise with a real whole-sample OM photo and simulated PUND.

Creates a separate database under data/e2e_real_*/. It never writes provisional
Pad IDs or fabricated electrical data into the normal application database.
"""
import argparse
import base64
from datetime import datetime
from io import BytesIO
import json
import os
from pathlib import Path
import threading
from urllib.parse import quote
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt


ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--image', type=Path, required=True, help='ZHENGPIAN.jpg')
parser.add_argument('--supplement', type=Path, help='Optional local close-up')
args = parser.parse_args()
if args.image.stem.upper() != 'ZHENGPIAN':
    parser.error('The primary input must be ZHENGPIAN.jpg')

run_dir = ROOT / 'data' / ('e2e_real_' + datetime.now().strftime('%Y%m%d_%H%M%S'))
run_dir.mkdir(parents=True)
os.environ['OM_AUTO_DATA'] = str(run_dir)
from om_auto.server import Handler, DB_PATH  # noqa: E402
from om_auto.store import connect  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402


class QuietHandler(Handler):
    def log_message(self, *_):
        pass


with connect(DB_PATH):
    pass
httpd = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
thread = threading.Thread(target=httpd.serve_forever, daemon=True)
thread.start()
base = f'http://127.0.0.1:{httpd.server_port}'


def api(path, body=None):
    if body is None:
        request = Request(base + path)
    else:
        request = Request(base + path, json.dumps(body).encode('utf-8'),
                          {'Content-Type': 'application/json'})
    with urlopen(request, timeout=120) as response:
        return json.loads(response.read())


def upload(path, sample_id):
    return api('/api/image', {'sample_id': sample_id, 'filename': path.name,
                              'data': base64.b64encode(path.read_bytes()).decode('ascii')})


def unit_boxes():
    layouts = [
        ('R1', [(4200, 4750), (4900, 5450), (5550, 6050)], [(150, 760), (850, 1450)]),
        ('R2', [(1530, 2090), (2220, 2770), (2860, 3420)],
         [(2250, 2750), (2850, 3400), (3500, 4100)]),
        ('R3', [(4140, 4700), (4820, 5380), (5500, 6060)],
         [(2250, 2750), (2850, 3400), (3500, 4100)]),
    ]
    for region, columns, rows in layouts:
        for row_num, (y1, y2) in enumerate(rows):
            for col_num, (x1, x2) in enumerate(columns):
                yield region, f'U{row_num * 3 + col_num + 1}', [x1, y1, x2, y2]


def clean_spot_score(gray, candidate, box):
    x, y = round(candidate['x'] - box[0]), round(candidate['y'] - box[1])
    if not (.2 * gray.shape[1] < x < .8 * gray.shape[1] and
            .2 * gray.shape[0] < y < .8 * gray.shape[0]):
        return -1e6
    patch = gray[y-20:y+21, x-20:x+21]
    if patch.shape != (41, 41):
        return -1e6
    yy, xx = np.mgrid[-20:21, -20:21]
    radius = np.sqrt(xx*xx + yy*yy)
    center = patch[radius < 6]
    ring = patch[(radius > 14) & (radius < 20)]
    dark_fraction = np.mean(center < center.mean() - 18)
    return float(center.mean() - ring.mean() - 30 * dark_fraction)


try:
    sample = '54#-IMAGE-E2E'
    api('/api/samples', {'sample_id': sample, 'notes': 'REAL OM IMAGE; PROVISIONAL PADS; SIMULATED PUND ONLY'})
    main = upload(args.image, sample)
    assert main['role'] == 'primary'
    if args.supplement:
        supplementary = upload(args.supplement, sample)
        assert supplementary['role'] == 'supplement'
    images = api('/api/images?sample_id=' + quote(sample))
    assert images[0]['image_id'] == main['image_id'] and images[0]['role'] == 'primary'

    image = Image.open(args.image)
    assert image.size == (7393, 10213), 'This validation recipe is calibrated for the 54# whole image'
    # The annotated red 1000 µm scale bar spans x=643..799 at y=9650.
    bar = np.asarray(image.crop((600, 9650, 850, 9651)).convert('RGB'))[0]
    red = (bar[:, 0] > 140) & (bar[:, 0] > bar[:, 1] * 1.5) & (bar[:, 0] > bar[:, 2] * 1.5)
    bar_x = np.where(red)[0] + 600
    assert bar_x.min() == 643 and bar_x.max() == 799
    um_per_px = 1000 / (bar_x.max() - bar_x.min() + 1)
    nominal_um = round(um_per_px * 21, 2)

    pad_records = []
    detection_counts = {}
    for region, unit, box in unit_boxes():
        result = api('/api/detect', {'image_id': main['image_id'], 'bbox': box,
                                    'polarity': 'light', 'min_size': 15, 'max_size': 30})
        key = f'{region}:{unit}'
        detection_counts[key] = len(result['candidates'])
        crop = np.asarray(image.crop(tuple(box)).convert('L'), dtype=np.float32)
        scored = [(clean_spot_score(crop, p, box), p) for p in result['candidates']]
        score, chosen = max(scored, key=lambda entry: entry[0]) if scored else (-1e6, None)
        if chosen is None or score < 8:
            raise AssertionError(f'No defensible bright candidate in {key}: score={score:.1f}')
        unit_number = int(unit[1:])
        pad_records.append({'pad_id': f'{sample}:{region}:L_A:{unit}:P01',
                            'region_id': region, 'layout_type_id': 'L_A',
                            'layout_unit_id': unit, 'unit_row': (unit_number - 1) // 3 + 1,
                            'unit_col': (unit_number - 1) % 3 + 1, 'pad_local_id': 'P01',
                            # Shape and geometry remain provisional pending close-up confirmation.
                            'shape': 'other', 'width_um': nominal_um, 'height_um': nominal_um,
                            'x': chosen['x'], 'y': chosen['y'], 'image_id': main['image_id'],
                            'area_source': 'whole-image 1000um scale; provisional 21px class',
                            'area_confidence': 'low', 'usable': 1})
    # A distinct large square from the lower layout records the fourth region.
    # It must not be silently folded into the three-region main geometry group.
    lower_box = [3900, 5500, 4900, 6100]
    lower = api('/api/detect', {'image_id': main['image_id'], 'bbox': lower_box,
                                'polarity': 'light', 'min_size': 40, 'max_size': 120})
    large = min(lower['candidates'], key=lambda p: (p['x'] - 4322)**2 + (p['y'] - 5605)**2)
    assert abs(large['x'] - 4322) < 8 and abs(large['y'] - 5605) < 8
    pad_records.append({'pad_id': f'{sample}:R4:L_B:U1:S01', 'region_id': 'R4',
                        'layout_type_id': 'L_B', 'layout_unit_id': 'U1',
                        'unit_row': 1, 'unit_col': 1, 'pad_local_id': 'S01', 'shape': 'square',
                        'width_um': round(large['width_px'] * um_per_px, 2),
                        'height_um': round(large['height_px'] * um_per_px, 2),
                        'x': large['x'], 'y': large['y'], 'image_id': main['image_id'],
                        'area_source': 'whole-image 1000um scale; provisional large square',
                        'area_confidence': 'low', 'usable': 1})
    imported = api('/api/pads', {'sample_id': sample, 'rows': pad_records})
    assert imported['imported'] == 25
    hierarchy = api('/api/structure?sample_id=' + quote(sample))
    assert [(r['region_id'], r['layout_type_id'], r['unit_count']) for r in hierarchy] == [
        ('R1', 'L_A', 6), ('R2', 'L_A', 9), ('R3', 'L_A', 9), ('R4', 'L_B', 1)]
    groups = api('/api/groups?sample_id=' + quote(sample))
    assert len(groups) == 2
    main_group = next(g for g in groups if g['shape'] == 'other')
    assert main_group['total'] == 24

    request = {'sample_id': sample, 'group_id': main_group['id'],
               'regions': ['R1', 'R2', 'R3'], 'count': 9, 'seed': 20261029}
    first = api('/api/plans', request)
    repeat = api('/api/plans', request)
    selected = [p['pad_id'] for p in first['pads']]
    assert selected == [p['pad_id'] for p in repeat['pads']]
    assert first['allocation'] == {'R1': 3, 'R2': 3, 'R3': 3}
    assert len({(p['region_id'], p['layout_unit_id']) for p in first['pads']}) == 9
    with urlopen(base + f"/api/task.csv?plan_id={first['plan_id']}") as response:
        (run_dir / 'initial_task.csv').write_bytes(response.read())

    outcomes = ['valid', 'valid', 'no_response', 'valid', 'leakage',
                'valid', 'breakdown', 'valid', 'no_response']
    simulated = []
    for idx, (pad_id, status) in enumerate(zip(selected, outcomes), 1):
        row = {'pad_id': pad_id, 'status': status, 'reviewed': 1,
               'measured_at': f'2026-10-29T14:{idx:02d}:00',
               'protocol_id': 'SIMULATED-E2E-NOT-EXPERIMENT'}
        if status == 'valid':
            row.update(pr_uc_cm2=round(26 + idx * 1.1, 2), ec_mv_cm=round(1.5 + idx * .06, 3))
        simulated.append(row)
    assert api('/api/measurements', {'sample_id': sample, 'rows': simulated})['imported'] == 9
    summary = api('/api/summary?sample_id=' + quote(sample) + '&group_id=' + main_group['id'])
    assert summary['tested'] == 9 and summary['valid'] == 5
    assert summary['status_counts']['breakdown'] == 1
    assert summary['valid_rate_ci95'][0] < summary['valid_rate'] < summary['valid_rate_ci95'][1]
    assert '不可外推至整片' in summary['note']

    next_plan = api('/api/plans', {**request, 'seed': 20261030})
    later_ids = {p['pad_id'] for p in next_plan['pads']}
    assert not later_ids.intersection(selected)
    with urlopen(base + f"/api/task.csv?plan_id={next_plan['plan_id']}") as response:
        (run_dir / 'next_task.csv').write_bytes(response.read())

    first_rows = [p for p in pad_records if p['pad_id'] in set(selected)]
    preview = Image.open(args.image)
    preview.thumbnail((1600, 2400))
    scale_x = preview.width / image.width
    scale_y = preview.height / image.height
    fig, axis = plt.subplots(figsize=(8, 11))
    axis.imshow(preview)
    axis.scatter([p['x']*scale_x for p in first_rows],
                 [p['y']*scale_y for p in first_rows], s=55, c='#ef7130',
                 edgecolors='white', linewidths=1)
    for p in first_rows:
        axis.annotate(p['region_id'] + '-' + p['layout_unit_id'],
                      (p['x']*scale_x, p['y']*scale_y), xytext=(5, -5),
                      textcoords='offset points', fontsize=7, color='#e15d20',
                      bbox={'facecolor': 'white', 'alpha': .8, 'edgecolor': 'none'})
    axis.set_axis_off()
    fig.tight_layout(pad=0)
    fig.savefig(run_dir / 'selected_on_whole.png', dpi=160)
    plt.close(fig)

    fig, axes = plt.subplots(3, 3, figsize=(9, 9))
    for axis, p in zip(axes.flat, first_rows):
        x, y = round(p['x']), round(p['y'])
        axis.imshow(image.crop((x-45, y-45, x+45, y+45)))
        axis.scatter([45], [45], s=50, facecolors='none', edgecolors='#ee6b2e')
        axis.set_title(p['region_id'] + '-' + p['layout_unit_id'], fontsize=9)
        axis.set_axis_off()
    fig.tight_layout()
    fig.savefig(run_dir / 'selected_contacts.png', dpi=150)
    plt.close(fig)

    report = {'source_image': str(args.image), 'image_size_px': list(image.size),
              'supplement': str(args.supplement) if args.supplement else None,
              'sample_id': sample, 'main_image_id': main['image_id'],
              'scale_bar_px': [int(bar_x.min()), int(bar_x.max())],
              'scale_um_per_px': um_per_px, 'nominal_geometry_um': nominal_um,
              'candidate_count_by_unit': detection_counts,
              'provisional_pads': pad_records, 'hierarchy': hierarchy, 'groups': groups,
              'first_plan': {'plan_id': first['plan_id'], 'allocation': first['allocation'],
                             'pad_ids': selected},
              'repeat_plan_same_seed': [p['pad_id'] for p in repeat['pads']],
              'simulated_measurements': simulated, 'summary': summary,
              'next_plan': {'plan_id': next_plan['plan_id'], 'allocation': next_plan['allocation'],
                            'pad_ids': [p['pad_id'] for p in next_plan['pads']]},
              'limitations': ['Pad shape and 21px geometry class are provisional; close-up confirmation required',
                              'PUND records are simulated only',
                              'Reference sample is partial and cannot establish wafer-wide performance']}
    (run_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f'PASS: {len(pad_records)} image-derived provisional pads in 4 regions; '
          '24 in the main test group')
    print(f'PASS: 9 first-round pads, 3 per region, deterministic seed {request["seed"]}')
    print(f'PASS: simulated PUND import; valid {summary["valid"]}/{summary["tested"]}, '
          f'Wilson 95% CI {summary["valid_rate_ci95"]}')
    print(f'PASS: next 9 pads exclude all first-round tested pads')
    print('PASS: analysis states that the 3-region geometry group cannot represent all 4 regions')
    print(f'Artifacts: {run_dir}')
finally:
    httpd.shutdown()
    httpd.server_close()

import math
from io import BytesIO
import pytest
from PIL import Image, ImageDraw
from om_auto.core import geometry_groups, pad_area, stratified_sample, summarize, wilson
from om_auto.server import import_pads, import_measurements
from om_auto.store import (archive_sample, candidate_edits, connect, delete_candidate_edit,
                           delete_region_box, measurements, pads, region_boxes, restore_sample,
                           sample_counts, save_candidate_edit, save_region_box, structure)
from om_auto.vision import apply_candidate_edits, candidates
from om_auto.lattice import complete_lattice


def make_db(tmp_path):
    db=connect(tmp_path/'test.sqlite3')
    db.execute("INSERT INTO samples(sample_id) VALUES('S')")
    db.commit()
    return db


def fixture_pads():
    return [{'pad_id':f'S:R{r}:U{u}:C', 'region_id':f'R{r}', 'layout_unit_id':f'U{u}',
             'pad_local_id':'C', 'shape':'circle', 'diameter_um':180,
             'x':r*1000+u*20,'y':u*10} for r in range(1,4) for u in range(1,10)] + [
            {'pad_id':'S:R1:U1:Q','region_id':'R1','layout_unit_id':'U1','pad_local_id':'Q',
             'shape':'square','width_um':100,'height_um':100,'x':30,'y':30}]


def test_area_and_grouping(tmp_path):
    db=make_db(tmp_path)
    import_pads(db,'S',fixture_pads())
    groups=geometry_groups(pads(db,'S'))
    assert len(groups)==2
    circle=next(g for g in groups if g['shape']=='circle')
    assert circle['total']==27 and circle['regions']==['R1','R2','R3']
    assert math.isclose(pad_area('circle',diameter_um=180),math.pi*90**2)
    assert pad_area('circle') is None
    assert pad_area('square',width_um=100)==10000


def test_sampling_reproducible_no_tested_and_scope(tmp_path):
    db=make_db(tmp_path)
    import_pads(db,'S',fixture_pads())
    import_measurements(db,'S',[{'pad_id':'S:R1:U1:C','status':'breakdown'}])
    pp=pads(db,'S'); group=next(g for g in geometry_groups(pp) if g['shape']=='circle')
    one,allocation=stratified_sample(pp,group['pad_ids'],['R1','R2','R3'],9,2026)
    two,_=stratified_sample(pp,group['pad_ids'],['R1','R2','R3'],9,2026)
    assert [p['pad_id'] for p in one]==[p['pad_id'] for p in two]
    assert allocation=={'R1':3,'R2':3,'R3':3}
    assert 'S:R1:U1:C' not in [p['pad_id'] for p in one]
    assert len({(p['region_id'],p['layout_unit_id']) for p in one})==9
    one_region,_=stratified_sample(pp,group['pad_ids'],['R1'],5,3)
    assert all(p['region_id']=='R1' for p in one_region)
    summary=summarize(pp,measurements(db,'S'),['R1'])
    assert '不代表整片样品' in summary['note']


def test_region_sampling_mixes_shapes_and_skips_layout_only(tmp_path):
    db = make_db(tmp_path)
    records = fixture_pads()
    records[1]['area_confidence'] = 'layout_only'
    records[2]['area_confidence'] = 'layout_only'
    import_pads(db, 'S', records)
    pp = pads(db, 'S')
    all_ids = [p['pad_id'] for p in pp]
    chosen, allocation = stratified_sample(pp, all_ids, ['R1', 'R2'], 12, 2026)
    assert allocation == {'R1': 6, 'R2': 6}
    assert all(p.get('area_confidence') != 'layout_only' for p in chosen)
    assert len({p['layout_unit_id'] for p in chosen if p['region_id'] == 'R1'}) == 6
    assert len({p['layout_unit_id'] for p in chosen if p['region_id'] == 'R2'}) == 6
    chosen_again, _ = stratified_sample(pp, all_ids, ['R1', 'R2'], 12, 2026)
    assert [p['pad_id'] for p in chosen] == [p['pad_id'] for p in chosen_again]
    only_inferred = [p['pad_id'] for p in pp if p.get('area_confidence') == 'layout_only']
    with pytest.raises(ValueError, match='没有可用'):
        stratified_sample(pp, only_inferred, ['R1'], 1, 1)
    included, _ = stratified_sample(pp, only_inferred, ['R1'], 1, 1, include_layout_only=True)
    assert included[0]['area_confidence'] == 'layout_only'


def test_missing_group_region_and_shortage(tmp_path):
    db=make_db(tmp_path);import_pads(db,'S',fixture_pads())
    pp=pads(db,'S');square=next(g for g in geometry_groups(pp) if g['shape']=='square')
    with pytest.raises(ValueError,match='没有可用'):
        stratified_sample(pp,square['pad_ids'],['R1','R2'],2,1)
    with pytest.raises(ValueError,match='不足'):
        stratified_sample(pp,square['pad_ids'],['R1'],2,1)


def test_import_is_atomic_and_preserves_invalid(tmp_path):
    db=make_db(tmp_path);import_pads(db,'S',fixture_pads())
    with pytest.raises(ValueError,match='未知 Pad'):
        import_measurements(db,'S',[{'pad_id':'S:R1:U1:C','status':'valid','pr_uc_cm2':20,'ec_mv_cm':1},
                                    {'pad_id':'unknown','status':'valid','pr_uc_cm2':20,'ec_mv_cm':1}])
    assert measurements(db,'S')==[]
    with pytest.raises(ValueError,match='不应填写'):
        import_measurements(db,'S',[{'pad_id':'S:R1:U1:C','status':'breakdown','pr_uc_cm2':0}])
    import_measurements(db,'S',[{'pad_id':'S:R1:U1:C','status':'breakdown'},
                                {'pad_id':'S:R2:U1:C','status':'valid','pr_uc_cm2':32,'ec_mv_cm':1.8}])
    s=summarize(pads(db,'S'),measurements(db,'S'))
    assert s['tested']==2 and s['valid']==1 and s['pr_uc_cm2']['mean']==32
    assert s['status_counts']['breakdown']==1


@pytest.mark.parametrize('statuses,expected', [(['breakdown']*3,0),(['valid']*3,3)])
def test_all_invalid_or_valid(tmp_path,statuses,expected):
    db=make_db(tmp_path);import_pads(db,'S',fixture_pads())
    rec=[]
    for i,status in enumerate(statuses,1):
        row={'pad_id':f'S:R1:U{i}:C','status':status}
        if status=='valid':row.update(pr_uc_cm2=25,ec_mv_cm=1.5)
        rec.append(row)
    import_measurements(db,'S',rec)
    s=summarize(pads(db,'S'),measurements(db,'S'))
    assert s['valid']==expected
    assert s['pr_uc_cm2'] is None if expected==0 else s['pr_uc_cm2']['n']==3
    assert 0 <= s['valid_rate_ci95'][0] <= s['valid_rate_ci95'][1] <= 1


def test_missing_area_and_wilson(tmp_path):
    db=make_db(tmp_path)
    import_pads(db,'S',[{'pad_id':'x','region_id':'R1','layout_unit_id':'U1',
                         'pad_local_id':'P1','shape':'circle'}])
    assert pads(db,'S')[0]['area_um2'] is None
    assert geometry_groups(pads(db,'S'))==[]
    assert wilson(0,0) is None


def test_om_candidates_are_pixel_proposals():
    image=Image.new('RGB',(500,300),(100,100,100))
    draw=ImageDraw.Draw(image)
    for x in (50,180,310):
        draw.rectangle((x,60,x+70,130),fill=(180,180,180))
    stream=BytesIO();image.save(stream,format='PNG')
    result=candidates(stream.getvalue(),min_size=30,max_size=100,polarity='light')
    assert len(result['candidates'])==3
    assert [round(p['x']) for p in result['candidates']]==[86,216,346]
    assert all(p['shape_guess']=='square' for p in result['candidates'])


def test_om_candidates_cover_full_large_grid():
    image = Image.new('L', (800, 800), 100)
    draw = ImageDraw.Draw(image)
    for row in range(25):
        for col in range(25):
            x, y = 25 + 30 * col, 25 + 30 * row
            draw.rectangle((x, y, x + 7, y + 7), fill=185)
    stream = BytesIO(); image.save(stream, format='PNG')
    found = candidates(stream.getvalue(), min_size=5, max_size=15)['candidates']
    assert len(found) == 625
    assert sum(p['y'] > 500 for p in found) > 200
    assert all('grid_support' in p and 'confidence' in p for p in found)


def test_region_boxes_persist_and_keep_distinct_regions(tmp_path):
    db = make_db(tmp_path)
    db.execute("""INSERT INTO images(image_id,sample_id,file_path,width_px,height_px,role)
                  VALUES('main','S','unused.jpg',1000,1200,'primary')""")
    db.commit()
    save_region_box(db, 'S', 'main', 'R1', [10, 20, 400, 500])
    save_region_box(db, 'S', 'main', 'R2', [500, 600, 900, 1100])
    assert [r['region_id'] for r in region_boxes(db, 'S', 'main')] == ['R1', 'R2']
    with pytest.raises(ValueError, match='已有框'):
        save_region_box(db, 'S', 'main', 'R1', [20, 30, 300, 400])
    with pytest.raises(ValueError, match='超出图片范围'):
        save_region_box(db, 'S', 'main', 'R3', [900, 1000, 1200, 1300])
    assert delete_region_box(db, 'S', 'main', 'R1')['ok']
    assert [r['region_id'] for r in region_boxes(db, 'S', 'main')] == ['R2']


def test_candidate_corrections_survive_redetection(tmp_path):
    db = make_db(tmp_path)
    db.execute("""INSERT INTO images(image_id,sample_id,file_path,width_px,height_px,role)
                  VALUES('main','S','unused.jpg',1000,1200,'primary')""")
    db.commit()
    save_region_box(db, 'S', 'main', 'R1', [10, 20, 400, 500])
    removed = save_candidate_edit(db, 'S', 'main', 'R1', 'remove', 100, 100, 20, 20)
    added = save_candidate_edit(db, 'S', 'main', 'R1', 'add', 200, 200, 20, 20)
    proposals = [{'x': 101, 'y': 100, 'width_px': 20, 'height_px': 20},
                 {'x': 300, 'y': 300, 'width_px': 20, 'height_px': 20}]
    result = apply_candidate_edits(proposals, candidate_edits(db, 'S', 'main'))
    assert [(p['x'], p['y']) for p in result] == [(200, 200), (300, 300)]
    assert result[0]['edit_id'] == added['edit_id']
    delete_candidate_edit(db, 'S', 'main', removed['edit_id'])
    assert len(apply_candidate_edits(proposals, candidate_edits(db, 'S', 'main'))) == 3
    delete_region_box(db, 'S', 'main', 'R1')
    assert candidate_edits(db, 'S', 'main') == []


def test_lattice_recovers_visible_missing_sites_without_filling_blank_sites():
    image = Image.new('L', (850, 850), 100)
    draw = ImageDraw.Draw(image)
    proposals = []
    missing = {(0, 0, 3, 4), (1, 1, 5, 2)}
    blank = (0, 1, 2, 6)
    for block_row in range(2):
        for block_col in range(2):
            for row in range(8):
                for col in range(8):
                    x = 60 + block_col * 410 + col * 40
                    y = 60 + block_row * 410 + row * 40
                    key = (block_row, block_col, row, col)
                    if key != blank:
                        draw.ellipse((x-7, y-7, x+7, y+7), fill=125)
                    if key not in missing and key != blank:
                        proposals.append({'x': x, 'y': y, 'width_px': 15,
                                          'height_px': 15, 'shape_guess': 'circle',
                                          'confidence': 'high'})
    result, grid = complete_lattice(image, proposals)
    inferred = [(p['x'], p['y']) for p in result if p['confidence'] == 'grid_inferred']
    assert grid['blocks'] == 4 and grid['inferred'] == 2
    assert grid['large_rows'] == grid['large_cols'] == 8
    assert grid['small_rows'] == 0 and len(result) == 256
    assert any(abs(x-220) < 3 and abs(y-180) < 3 for x, y in inferred)
    assert any(abs(x-550) < 3 and abs(y-670) < 3 for x, y in inferred)
    assert not any(abs(x-710) < 3 and abs(y-140) < 3 for x, y in inferred)
    assert any(abs(p['x']-710) < 3 and abs(p['y']-140) < 3 and
               p['confidence'] == 'layout_only' for p in result)


def test_lattice_finds_two_half_pitch_small_rows():
    image = Image.new('L', (850, 850), 100)
    draw = ImageDraw.Draw(image)
    proposals = []
    for block_row in range(2):
        for block_col in range(2):
            x0, y0 = 60 + block_col * 410, 60 + block_row * 410
            for row in range(8):
                for col in range(8):
                    x, y = x0 + col * 40, y0 + row * 40
                    draw.ellipse((x-7, y-7, x+7, y+7), fill=125)
                    proposals.append({'x': x, 'y': y, 'width_px': 15,
                                      'height_px': 15, 'shape_guess': 'circle',
                                      'confidence': 'high'})
            for row in range(2):
                for col in range(16):
                    x = x0 - 10 + col * 20
                    y = round(y0 + 7 * 40 + 40 * 2 / 3 + row * 20)
                    draw.ellipse((x-3, y-3, x+3, y+3), fill=112)
    result, grid = complete_lattice(image, proposals)
    assert grid['unit_rows'] == grid['unit_cols'] == 2
    assert grid['small_rows'] == 2 and grid['small_cols'] == 16
    assert len(result) == 4 * (8 * 8 + 2 * 16)
    assert sum(p['pad_class'] == 'small' for p in result) == 128
    assert any(p['layout_unit_id'] == 'U4' and p['pad_row'] == 10 and
               p['pad_col'] == 16 for p in result)


def test_lattice_finds_faint_small_rows_above_main_grid():
    image = Image.new('L', (850, 960), 100)
    draw = ImageDraw.Draw(image)
    proposals = []
    for block_row in range(2):
        for block_col in range(2):
            x0, y0 = 60 + block_col * 410, 120 + block_row * 410
            for row in range(8):
                for col in range(8):
                    x, y = x0 + col * 40, y0 + row * 40
                    draw.rectangle((x-7, y-7, x+7, y+7), fill=125)
                    proposals.append({'x': x, 'y': y, 'width_px': 15,
                                      'height_px': 15, 'shape_guess': 'square',
                                      'confidence': 'high'})
            for row in range(2):
                for col in range(16):
                    x = x0 - 10 + col * 20 + 2
                    y = round(y0 - 7 * 40 / 6 + row * 20 + 3)
                    draw.rectangle((x-3, y-3, x+3, y+3), fill=113)
    result, grid = complete_lattice(image, proposals)
    assert grid['small_position'] == 'top'
    assert grid['top_small_rows'] == 2 and grid['bottom_small_rows'] == 0
    assert len(result) == 4 * (8 * 8 + 2 * 16)
    assert any(p['layout_unit_id'] == 'U1' and p['pad_class'] == 'small' and
               p['pad_row'] == 1 and p['pad_col'] == 1 and p['shape_guess'] == 'square'
               for p in result)
    assert any(p['layout_unit_id'] == 'U4' and p['pad_class'] == 'large' and
               p['pad_row'] == 10 and p['pad_col'] == 8 for p in result)


def test_delete_and_restore_sample_preserves_results(tmp_path):
    db=make_db(tmp_path)
    import_pads(db,'S',fixture_pads())
    import_measurements(db,'S',[{'pad_id':'S:R1:U1:C','status':'valid',
                                 'pr_uc_cm2':28,'ec_mv_cm':1.7}])
    db.execute("""INSERT INTO plans(sample_id,group_id,regions_json,count,seed,allocation_json,pad_ids_json)
                  VALUES('S','G001','[\"R1\"]',1,1,'{\"R1\":1}','[\"S:R1:U1:C\"]')""")
    db.commit()
    before=sample_counts(db,'S')
    archived=archive_sample(db,'S')
    assert archived['deleted_at'] is not None
    assert {k:archived[k] for k in ('pads','measurements','plans','images')} == {
        k:before[k] for k in ('pads','measurements','plans','images')}
    assert db.execute("SELECT count(*) FROM samples WHERE deleted_at IS NULL").fetchone()[0]==0
    with pytest.raises(ValueError,match='已删除'):
        import_measurements(db,'S',[{'pad_id':'S:R1:U2:C','status':'breakdown'}])
    restored=restore_sample(db,'S')
    assert restored['deleted_at'] is None
    assert len(pads(db,'S'))==28 and len(measurements(db,'S'))==1


def test_region_unit_pad_grid_hierarchy_and_conflicts(tmp_path):
    db=make_db(tmp_path)
    records=[
        {'pad_id':'S:R1:L_A:U1:r1c1','region_id':'R1','layout_type_id':'L_A',
         'layout_unit_id':'U1','unit_row':1,'unit_col':1,'pad_local_id':'r1c1',
         'pad_row':1,'pad_col':1,'shape':'circle','diameter_um':180},
        {'pad_id':'S:R1:L_A:U1:r1c2','region_id':'R1','layout_type_id':'L_A',
         'layout_unit_id':'U1','unit_row':1,'unit_col':1,'pad_local_id':'r1c2',
         'pad_row':1,'pad_col':2,'shape':'square','width_um':100},
        {'pad_id':'S:R2:L_B:U1:r1c1','region_id':'R2','layout_type_id':'L_B',
         'layout_unit_id':'U1','unit_row':1,'unit_col':1,'pad_local_id':'r1c1',
         'pad_row':1,'pad_col':1,'shape':'square','width_um':200},
    ]
    assert import_pads(db,'S',records)==3
    tree=structure(db,'S')
    assert [(r['region_id'],r['layout_type_id'],r['unit_count'],r['pad_count']) for r in tree]==[
        ('R1','L_A',1,2),('R2','L_B',1,1)]
    p=pads(db,'S')[0]
    assert (p['layout_type_id'],p['unit_row'],p['unit_col'],p['pad_row'],p['pad_col'])==('L_A',1,1,1,1)
    with pytest.raises(ValueError,match='版图类型'):
        import_pads(db,'S',[dict(records[0],pad_id='conflict',layout_type_id='L_C',pad_local_id='r2c2',pad_row=2,pad_col=2)])
    with pytest.raises(ValueError,match='行列位置冲突'):
        import_pads(db,'S',[dict(records[0],pad_id='conflict',layout_unit_id='U1',unit_row=2,unit_col=1,
                                 pad_local_id='r2c2',pad_row=2,pad_col=2)])
    with pytest.raises(ValueError,match='Pad 行列位置重复'):
        import_pads(db,'S',[dict(records[0],pad_id='conflict',pad_local_id='other')])
    assert len(pads(db,'S'))==3


def test_sampling_uses_unit_grid_when_image_coordinates_missing(tmp_path):
    db=make_db(tmp_path)
    records=[]
    for row in range(1,4):
        for col in range(1,4):
            unit=f'U{(row-1)*3+col}'
            records.append({'pad_id':f'S:R1:L_A:{unit}:P1','region_id':'R1',
                            'layout_type_id':'L_A','layout_unit_id':unit,
                            'unit_row':row,'unit_col':col,'pad_local_id':'P1',
                            'pad_row':1,'pad_col':1,'shape':'circle','diameter_um':180})
    import_pads(db,'S',records)
    pp=pads(db,'S')
    group=geometry_groups(pp)[0]
    first,_=stratified_sample(pp,group['pad_ids'],['R1'],3,12)
    second,_=stratified_sample(pp,group['pad_ids'],['R1'],3,12)
    assert [p['pad_id'] for p in first]==[p['pad_id'] for p in second]
    assert len({(p['unit_row'],p['unit_col']) for p in first})==3
    assert max(p['unit_row'] for p in first)-min(p['unit_row'] for p in first)>=1

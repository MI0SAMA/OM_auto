"""Create a 3-region, 9-unit-per-region reproducible demonstration dataset."""
import argparse
import random
from om_auto.server import DB_PATH, import_measurements, import_pads
from om_auto.store import connect

parser=argparse.ArgumentParser()
parser.add_argument('--sample',default='DEMO-3R')
args=parser.parse_args()
sid=args.sample
db=connect(DB_PATH)
db.execute('INSERT INTO samples(sample_id,recipe_id,notes) VALUES(?,?,?)',
           (sid,'DEMO','模拟数据；仅用于验证程序，不代表真实样品'))
db.commit()
records=[]
for region in range(1,4):
    for unit in range(1,10):
        ux=(unit-1)%3
        uy=(unit-1)//3
        for local,shape,size,offset in [('C180','circle',180,0),('C100','circle',100,18),
                                        ('S180','square',180,36),('S100','square',100,54)]:
            pad_grid={'C180':(1,1),'C100':(1,2),'S180':(2,1),'S100':(2,2)}[local]
            rec={'pad_id':f'{sid}:R{region}:L1:U{unit}:{local}', 'region_id':f'R{region}',
                 'layout_type_id':'L1', 'layout_unit_id':f'U{unit}',
                 'unit_row':uy+1, 'unit_col':ux+1,
                 'pad_local_id':local, 'pad_row':pad_grid[0], 'pad_col':pad_grid[1], 'shape':shape,
                 'x':(region-1)*450+ux*100+offset,'y':uy*100+20,
                 'area_source':'design','area_confidence':'high'}
            rec['diameter_um' if shape=='circle' else 'width_um']=size
            if shape=='square':rec['height_um']=size
            records.append(rec)
import_pads(db,sid,records)
rng=random.Random(37)
statuses=['valid','valid','valid','valid','no_response','leakage','breakdown','valid']
measures=[]
for region in range(1,4):
    for unit in (1,2):
        pid=f'{sid}:R{region}:L1:U{unit}:C180'
        status=statuses[(region*3+unit)%len(statuses)]
        rec={'pad_id':pid,'measured_at':f'2026-10-{region+10:02d}T10:{unit:02d}:00',
             'protocol_id':'DEMO-PUND','status':status,'reviewed':1}
        if status=='valid':
            rec['pr_uc_cm2']=round(30+region*2+rng.uniform(-3,3),2)
            rec['ec_mv_cm']=round(1.5+region*.1+rng.uniform(-.15,.15),3)
        if status=='breakdown':rec['breakdown_v']=18
        measures.append(rec)
import_measurements(db,sid,measures)
print(f'Created {sid}: {len(records)} pads, {len(measures)} measurements in {DB_PATH}')

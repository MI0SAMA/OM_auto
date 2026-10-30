import argparse
from om_auto.server import run

parser = argparse.ArgumentParser()
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=8765)
args = parser.parse_args()
run(args.host, args.port)

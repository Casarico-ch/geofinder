#!/bin/bash
# vw.sh KEY [px] [grid] -> georef/wKEY.png + gridded georef/wgKEY.png
cd "${GENEVA_RULES_WORK:-$(dirname "$0")/../../work/rules}"
python3 -I scripts/view_plan.py georef/$1_p1.json georef/w$1.png ${2:-1400} && python3 -I scripts/grid.py georef/w$1.png georef/wg$1.png ${3:-100}

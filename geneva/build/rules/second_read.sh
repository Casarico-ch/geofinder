#!/bin/bash
# usage: second_read.sh G pdf page -> independent OCR of the page (page 0 = all pages) at a higher dpi (capped ~40 Mpx/page) into tmp/sr/<pdf>_p<page>.txt
G="$1"; pdf="$2"; page="$3"
out="$G/tmp/sr/$(echo "$pdf" | sed 's/[^A-Za-z0-9]/_/g')_p$page.txt"
[ -s "$out" ] && exit 0
if [ "$page" = 0 ]; then f=1; l=$(pdfinfo "$G/$pdf" | awk '/^Pages:/{print $2}'); else f=$page; l=$page; fi
read w h < <(pdfinfo -f $f -l $f "$G/$pdf" | awk '/size:/{print $4, $6; exit}')
dpi=$(python3 -I -c "import math;print(int(min(400, math.sqrt(40e6/($w*$h))*72)))")
tmp=$(mktemp -d -p "$G/tmp/sr")
pdftoppm -f $f -l $l -r $dpi -gray -png "$G/$pdf" "$tmp/p"
if awk -v w="$w" 'BEGIN{exit !(w>1000)}'; then psm=11; else psm=6; fi
{ echo "dpi=$dpi psm=$psm"; for im in "$tmp"/p*.png; do OMP_THREAD_LIMIT=1 tesseract "$im" - -l fra --psm $psm 2>/dev/null; done; } > "$out.part" && mv "$out.part" "$out"
rm -rf "$tmp"

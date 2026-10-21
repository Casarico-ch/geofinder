#!/bin/bash
f="$1"; base="${f%.pdf}"; T="${GENEVA_RULES_WORK:-$(dirname "$0")/../../work/rules}/tmp"
tmp=$(mktemp -d -p $T)
w=$(pdfinfo "$f" | awk '/Page size/{print ($3>$5)?$3:$5; exit}')
r=300; awk -v w="$w" 'BEGIN{exit !(w>1500)}' && r=150; awk -v w="$w" 'BEGIN{exit !(w>4000)}' && r=110
pdftoppm -r $r -gray -png "$f" "$tmp/p" 2>/dev/null
: > "$base.ocr.txt"
for p in "$tmp"/p*.png; do echo "=== PAGE $(basename $p .png | sed 's/^p-*0*//')" >> "$base.ocr.txt"; OMP_THREAD_LIMIT=1 tesseract "$p" - -l fra --psm 3 2>/dev/null >> "$base.ocr.txt"; done
rm -rf "$tmp"; echo "done $f r=$r $(wc -c < "$base.ocr.txt")"

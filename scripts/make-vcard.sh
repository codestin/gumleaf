#!/usr/bin/env bash
# Generates a .vcf contact card for your bot, ready to host and wire up via the
# VCARD_URL env var (see README "Contact card").
#
#   bash scripts/make-vcard.sh --name "Trail Bot" --number +15551234567 \
#     [--url https://example.com] [--photo koala.png] [--out trailbot.vcf] \
#     [--no-attribution]
#
# By default the card's NOTE credits GumLeaf (this project) so the people your
# users share the card with can find it too. Pass --no-attribution to omit.
set -euo pipefail

NAME="" NUMBER="" URL="" PHOTO="" OUT="" ATTRIB=1
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --number) NUMBER="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --photo) PHOTO="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --no-attribution) ATTRIB=0; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[ -n "$NAME" ] || { echo "--name is required (your bot's display name)" >&2; exit 1; }
[ -n "$NUMBER" ] || { echo "--number is required (E.164, e.g. +15551234567)" >&2; exit 1; }
OUT="${OUT:-$(echo "$NAME" | tr '[:upper:] ' '[:lower:]-').vcf}"

NOTE="Text me any question and get an answer back by SMS."
if [ "$ATTRIB" = "1" ]; then
  NOTE="$NOTE Powered by GumLeaf - getgumleaf.com"
fi

{
  printf 'BEGIN:VCARD\r\n'
  printf 'VERSION:3.0\r\n'
  printf 'N:;%s;;;\r\n' "$NAME"
  printf 'FN:%s\r\n' "$NAME"
  printf 'TEL;TYPE=CELL:%s\r\n' "$NUMBER"
  [ -n "$URL" ] && printf 'URL:%s\r\n' "$URL"
  printf 'NOTE:%s\r\n' "$NOTE"
  if [ -n "$PHOTO" ]; then
    B64=$(base64 -i "$PHOTO" 2>/dev/null || base64 "$PHOTO")
    B64=$(echo "$B64" | tr -d '\n')
    # RFC folding: continuation lines start with a single space.
    printf 'PHOTO;ENCODING=b;TYPE=PNG:%s\n' "$B64" | fold -w 74 | sed '2,$s/^/ /' | sed 's/$/\r/'
  fi
  printf 'END:VCARD\r\n'
} > "$OUT"

echo "Wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)."
echo "Host it with header 'Content-Type: text/vcard', then set VCARD_URL to its public URL."

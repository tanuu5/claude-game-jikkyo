#!/usr/bin/env bash
# usage: sheet.sh video.mp4 out.jpg [every=0.5] [cols=6]  -> one tiled contact sheet (320px thumbs)
v=$1; out=$2; every=${3:-0.5}; cols=${4:-6}
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$v")
n=$(python3 -c "import math;print(max(1,math.ceil($dur/$every)))")
rows=$(( (n + cols - 1) / cols ))
fps=$(python3 -c "print(1/$every)")
ffmpeg -loglevel error -y -i "$v" -vf "fps=$fps,scale=320:-1,tile=${cols}x${rows}:padding=2:color=black" -frames:v 1 "$out"
echo "$out: $n thumbs, ${every}s apart (row = $(python3 -c "print($cols*$every)")s)"

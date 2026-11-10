"""Verify the actual encoded video, including installations with FFmpeg only."""
import json
import math
import subprocess
import tempfile
from fractions import Fraction


def verify_video(video_path, *, ffmpeg, ffprobe, frames, width, height, duration, fps):
    try:
        probe = subprocess.run([ffprobe, '-v', 'error', '-select_streams', 'v:0', '-count_frames',
                                '-show_entries', 'stream=nb_read_frames,width,height,duration',
                                '-of', 'json', str(video_path)],
                               capture_output=True, text=True, timeout=10, check=True)
    except FileNotFoundError:
        # FrameMD5 decodes every frame, supplies dimensions and rational PTS,
        # and fails on decoding errors. Never treat mere file existence as success.
        with tempfile.TemporaryFile(mode='w+b') as output:
            try:
                # -vsync 0 is supported by the older Windows installer binary
                # as well as current FFmpeg; -fps_mode is a newer option.
                subprocess.run([ffmpeg, '-v', 'error', '-xerror', '-nostdin', '-i', str(video_path),
                                '-map', '0:v:0', '-an', '-vsync', '0', '-f', 'framemd5', 'pipe:1'],
                               stdout=output, stderr=subprocess.PIPE, timeout=10, check=True)
            except subprocess.CalledProcessError as exc:
                detail = (exc.stderr or b'').decode('utf-8', errors='replace').strip()
                raise ValueError(f"FFmpeg video verification failed (exit {exc.returncode}): {detail[-2000:]}") from exc
            output.seek(0)
            timebase = None
            dimensions = None
            count = 0
            end = Fraction(0)
            previous = None
            for raw in output:
                line = raw.decode('ascii').strip()
                if line.startswith('#tb 0:'):
                    timebase = Fraction(line.split(':', 1)[1].strip())
                elif line.startswith('#dimensions 0:'):
                    dimensions = tuple(map(int, line.split(':', 1)[1].strip().split('x')))
                elif line and not line.startswith('#'):
                    fields = [part.strip() for part in line.split(',')]
                    if len(fields) != 6 or fields[0] != '0' or timebase is None:
                        raise ValueError('Invalid FFmpeg frame verification output')
                    pts, length = int(fields[2]), int(fields[3])
                    if length <= 0 or (previous is not None and pts <= previous):
                        raise ValueError('Encoded video timestamps are invalid')
                    if count == 0 and pts != 0:
                        raise ValueError('Encoded video does not start at zero')
                    previous = pts
                    end = (pts + length) * timebase
                    count += 1
            measured = float(end)
            method = 'ffmpeg-framemd5'
    else:
        streams = json.loads(probe.stdout).get('streams', [])
        if len(streams) != 1:
            raise ValueError('Encoded video stream verification failed')
        stream = streams[0]
        count = int(stream.get('nb_read_frames', 0))
        dimensions = (int(stream['width']), int(stream['height']))
        measured = float(stream.get('duration', 'nan'))
        method = 'ffprobe'
    if count != frames:
        raise ValueError('Encoded video frame count verification failed')
    if dimensions != (width, height):
        raise ValueError('Encoded dimensions changed')
    if not math.isfinite(measured) or abs(measured - duration) > 1 / fps:
        raise ValueError('Encoded video duration does not match source timeline')
    return method

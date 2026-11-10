"""Offline gaze-to-static-image analysis using SIFT homography estimation."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np


def _scaled_gray(image: np.ndarray, max_dimension: int) -> tuple[np.ndarray, float]:
    height, width = image.shape[:2]
    largest = max(width, height)
    scale = min(1.0, float(max_dimension) / float(largest)) if largest > 0 else 1.0
    if scale < 0.999:
        image = cv2.resize(
            image,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    if image.ndim == 3:
        image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return image, scale


def _estimate_homography(
    frame: np.ndarray,
    static_keypoints: list[Any],
    static_descriptors: np.ndarray,
    sift: Any,
    matcher: Any,
    frame_max_dimension: int,
) -> tuple[np.ndarray | None, float, int, int, float]:
    frame_gray, frame_scale = _scaled_gray(frame, frame_max_dimension)
    frame_keypoints, frame_descriptors = sift.detectAndCompute(frame_gray, None)
    if frame_descriptors is None or len(frame_keypoints) < 12:
        return None, 0.0, 0, 0, frame_scale

    raw_matches = matcher.knnMatch(frame_descriptors, static_descriptors, k=2)
    good_matches = [pair[0] for pair in raw_matches if len(pair) == 2 and pair[0].distance < 0.7 * pair[1].distance]
    if len(good_matches) < 12:
        return None, 0.0, len(good_matches), 0, frame_scale

    source = np.float32([frame_keypoints[m.queryIdx].pt for m in good_matches]).reshape(-1, 1, 2)
    target = np.float32([static_keypoints[m.trainIdx].pt for m in good_matches]).reshape(-1, 1, 2)
    homography, inlier_mask = cv2.findHomography(source, target, cv2.RANSAC, 5.0)
    if homography is None or inlier_mask is None:
        return None, 0.0, len(good_matches), 0, frame_scale

    inliers = int(inlier_mask.ravel().sum())
    inlier_ratio = inliers / max(1, len(good_matches))
    confidence = min(1.0, inlier_ratio * min(1.0, inliers / 24.0))
    if inliers < 8 or inlier_ratio < 0.25:
        return None, confidence, len(good_matches), inliers, frame_scale
    return homography, confidence, len(good_matches), inliers, frame_scale


def run_mapping(job: dict[str, Any]) -> dict[str, Any]:
    video_path = Path(str(job.get("videoPath") or "")).expanduser().resolve()
    image_path = Path(str(job.get("imagePath") or "")).expanduser().resolve()
    output_path = Path(str(job.get("outputPath") or "")).expanduser().resolve()
    gaze_points = job.get("gazePoints")
    if not video_path.is_file():
        raise ValueError("视频文件不存在")
    if not image_path.is_file():
        raise ValueError("静态图片不存在")
    if not isinstance(gaze_points, list) or not gaze_points:
        raise ValueError("没有可映射的注视点")

    static_image = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if static_image is None:
        raise ValueError("无法读取静态图片")
    static_height, static_width = static_image.shape[:2]
    static_gray, static_scale = _scaled_gray(static_image, int(job.get("staticMaxDimension") or 4096))

    sift = cv2.SIFT_create(nfeatures=int(job.get("maxFeatures") or 12000))
    static_keypoints, static_descriptors = sift.detectAndCompute(static_gray, None)
    if static_descriptors is None or len(static_keypoints) < 12:
        raise ValueError("静态图片特征不足，无法建立映射")
    matcher = cv2.FlannBasedMatcher(dict(algorithm=1, trees=5), dict(checks=64))

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError("无法打开视频")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    if not math.isfinite(fps) or fps <= 0:
        fps = 30.0
    frame_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    frame_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if frame_width <= 0 or frame_height <= 0:
        capture.release()
        raise ValueError("无法读取视频分辨率")

    interval_frames = max(1, min(300, int(job.get("keyframeIntervalFrames") or 15)))
    normalized_points: list[dict[str, Any]] = []
    for index, raw in enumerate(gaze_points):
        if not isinstance(raw, dict):
            continue
        try:
            x = float(raw.get("x", float("nan")))
            y = float(raw.get("y", float("nan")))
            timestamp_value = raw.get("timestamp")
            timestamp_ms = float(timestamp_value) if timestamp_value is not None else index * 1000.0 / fps
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(timestamp_ms)):
            continue
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            continue
        frame_index = max(0, round(timestamp_ms * fps / 1000.0))
        keyframe_index = (frame_index // interval_frames) * interval_frames
        normalized_points.append({
            "x": x,
            "y": y,
            "timestampMs": timestamp_ms,
            "weight": raw.get("weight"),
            "durationMs": raw.get("durationMs"),
            "id": raw.get("id", index),
            "frameIndex": frame_index,
            "keyframeIndex": keyframe_index,
        })
    if not normalized_points:
        capture.release()
        raise ValueError("注视点坐标无效")

    grouped: dict[int, list[dict[str, Any]]] = {}
    for point in normalized_points:
        grouped.setdefault(int(point["keyframeIndex"]), []).append(point)
    keyframe_indexes = sorted(grouped)
    final_frame_index = max(int(point["frameIndex"]) for point in normalized_points)
    if keyframe_indexes and final_frame_index > keyframe_indexes[-1]:
        keyframe_indexes.append(final_frame_index)

    keyframe_stats: list[dict[str, Any]] = []
    keyframe_models: list[dict[str, Any]] = []
    previous_homography: np.ndarray | None = None
    previous_frame_scale = 1.0
    previous_confidence = 0.0
    for keyframe_index in keyframe_indexes:
        capture.set(cv2.CAP_PROP_POS_FRAMES, keyframe_index)
        ok, frame = capture.read()
        homography = None
        confidence = 0.0
        match_count = 0
        inlier_count = 0
        frame_scale = previous_frame_scale
        inherited = False
        if ok and frame is not None:
            homography, confidence, match_count, inlier_count, frame_scale = _estimate_homography(
                frame,
                static_keypoints,
                static_descriptors,
                sift,
                matcher,
                int(job.get("frameMaxDimension") or 1280),
            )
        if homography is None and previous_homography is not None:
            homography = previous_homography
            frame_scale = previous_frame_scale
            confidence = max(0.05, previous_confidence * 0.55)
            inherited = True
        elif homography is not None:
            previous_homography = homography
            previous_frame_scale = frame_scale
            previous_confidence = confidence

        keyframe_stats.append({
            "frameIndex": keyframe_index,
            "timestampMs": keyframe_index * 1000.0 / fps,
            "matched": homography is not None,
            "inherited": inherited,
            "confidence": round(confidence, 4),
            "matches": match_count,
            "inliers": inlier_count,
        })
        keyframe_models.append({
            "frameIndex": keyframe_index,
            "homography": homography,
            "frameScale": frame_scale,
            "confidence": confidence,
            "inherited": inherited,
        })

    capture.release()

    mapped: list[dict[str, Any]] = []
    models_by_index = {int(model["frameIndex"]): model for model in keyframe_models}
    sorted_model_indexes = sorted(models_by_index)
    for point in normalized_points:
        current_model = models_by_index.get(int(point["keyframeIndex"]))
        if current_model is None or current_model["homography"] is None:
            continue
        current_source = np.float32([[[
            point["x"] * frame_width * float(current_model["frameScale"]),
            point["y"] * frame_height * float(current_model["frameScale"]),
        ]]])
        current_target = cv2.perspectiveTransform(current_source, current_model["homography"])[0][0]
        target_x = float(current_target[0])
        target_y = float(current_target[1])
        confidence = float(current_model["confidence"])
        inherited = bool(current_model["inherited"])

        next_index = next((index for index in sorted_model_indexes if index > int(point["keyframeIndex"])), None)
        if next_index is not None:
            next_model = models_by_index[next_index]
            if next_model["homography"] is not None:
                next_source = np.float32([[[
                    point["x"] * frame_width * float(next_model["frameScale"]),
                    point["y"] * frame_height * float(next_model["frameScale"]),
                ]]])
                next_target = cv2.perspectiveTransform(next_source, next_model["homography"])[0][0]
                span = max(1, next_index - int(point["keyframeIndex"]))
                alpha = max(0.0, min(1.0, (int(point["frameIndex"]) - int(point["keyframeIndex"])) / span))
                target_x = target_x * (1.0 - alpha) + float(next_target[0]) * alpha
                target_y = target_y * (1.0 - alpha) + float(next_target[1]) * alpha
                confidence = confidence * (1.0 - alpha) + float(next_model["confidence"]) * alpha
                inherited = inherited or bool(next_model["inherited"])

        absolute_x = target_x / static_scale
        absolute_y = target_y / static_scale
        if not (math.isfinite(absolute_x) and math.isfinite(absolute_y)):
            continue
        if absolute_x < 0 or absolute_x > static_width or absolute_y < 0 or absolute_y > static_height:
            continue
        mapped.append({
            "timestampMs": round(float(point["timestampMs"]), 3),
            "x": round(absolute_x, 3),
            "y": round(absolute_y, 3),
            "weight": point.get("weight"),
            "durationMs": point.get("durationMs"),
            "sourceId": point.get("id"),
            "confidence": round(confidence, 4),
            "inherited": inherited,
        })

    mapped.sort(key=lambda item: item["timestampMs"])
    result = {
        "version": 1,
        "imageRef": image_path.name,
        "resolution": {"width": static_width, "height": static_height},
        "video": {
            "name": video_path.name,
            "fps": fps,
            "width": frame_width,
            "height": frame_height,
        },
        "settings": {"algorithm": "SIFT_FLANN_RANSAC", "keyframeIntervalFrames": interval_frames},
        "summary": {
            "inputPoints": len(normalized_points),
            "mappedPoints": len(mapped),
            "mappingRate": round(len(mapped) / max(1, len(normalized_points)), 4),
            "keyframes": len(keyframe_stats),
            "matchedKeyframes": sum(1 for item in keyframe_stats if item["matched"] and not item["inherited"]),
            "inheritedKeyframes": sum(1 for item in keyframe_stats if item["inherited"]),
        },
        "keyframes": keyframe_stats,
        "gazeData": mapped,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    args = parser.parse_args(argv)
    try:
        job_path = Path(args.job).expanduser().resolve()
        job = json.loads(job_path.read_text(encoding="utf-8"))
        result = run_mapping(job)
        print(json.dumps({"ok": True, "outputPath": str(Path(job["outputPath"]).resolve()), "summary": result["summary"]}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

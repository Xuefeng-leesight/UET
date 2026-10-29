import { FACE_MESH_TESSELLATION } from '@/features/recording/domain/faceMeshTessellation';

export type FacialLandmarkPoint = { x: number; y: number };

export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10];
export const LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33];
export const RIGHT_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398, 362];
export const OUTER_LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78, 61];
export const INNER_LIPS = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78];

export function buildFacialMeshEdges(points: FacialLandmarkPoint[]): Array<[number, number]> {
  const pointCount = points.length;
  if (pointCount < 468) return [];
  return FACE_MESH_TESSELLATION
    .filter(([start, end]) => start < pointCount && end < pointCount)
    .map(([start, end]) => [start, end]);
}

export function isRenderableFacialLandmark(
  point: FacialLandmarkPoint | null | undefined,
): point is FacialLandmarkPoint {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

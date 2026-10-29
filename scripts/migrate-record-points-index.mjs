import fs from 'node:fs'
import path from 'node:path'

const basePath = process.argv[2]?.replace(/\.(csv|points\.index\.json)$/i, '')
if (!basePath) {
  throw new Error('Usage: node scripts/migrate-record-points-index.mjs <record-base-or-csv>')
}

const csvPath = `${basePath}.csv`
const metaPath = `${basePath}.points.index.json`
const legacyFixationPath = `${basePath}.fixation.events.jsonl`
const analysisPath = `${basePath}.analysis-events.csv`
const blockSizeMs = 10_000
const columns = [
  'x', 'y', 'weight', 'id', 'timestamp', 'fixationState', 'fixationTimestampMs',
  'fixationDurationMs', 'blink', 'leftBlink', 'rightBlink', 'pupilDiameter',
  'leftPupilDiameter', 'rightPupilDiameter', 'saccadeDurationMs', 'saccadeAmplitude',
  'saccadeVelocity', 'saccadePeakVelocity', 'saccadeStartX', 'saccadeStartY',
  'saccadeEndX', 'saccadeEndY', 'stimulusName', 'marker', 'triggerMark',
  'customMarker', 'markerOnly', 'parseVersion',
]

const encodeCell = (value) => {
  if (value === undefined || value === null) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const csvBuffer = fs.readFileSync(csvPath)
const firstNewline = csvBuffer.indexOf(0x0a)
if (firstNewline < 0) throw new Error('CSV header is missing')
const headers = csvBuffer.subarray(0, firstNewline).toString('utf8').replace(/\r$/, '').split(',')
const timeIndex = headers.indexOf('video_time_ms')
if (timeIndex < 0) throw new Error('video_time_ms column is missing')
const stimulusIndex = headers.indexOf('stimulus')

const blocks = []
const stimulusBoundaryEvents = []
let totalRows = 0
let gazePointCount = 0
let minVideoTimeMs = Infinity
let maxVideoTimeMs = -Infinity
let lastBlockStart = -1
let activeStimulusName = ''
let lineStart = firstNewline + 1
for (let cursor = lineStart; cursor <= csvBuffer.length; cursor += 1) {
  if (cursor < csvBuffer.length && csvBuffer[cursor] !== 0x0a) continue
  const line = csvBuffer.subarray(lineStart, cursor).toString('utf8').replace(/\r$/, '')
  if (line) {
    totalRows += 1
    const timeMs = Number(line.split(',')[timeIndex])
    if (Number.isFinite(timeMs)) {
      gazePointCount += 1
      minVideoTimeMs = Math.min(minVideoTimeMs, timeMs)
      maxVideoTimeMs = Math.max(maxVideoTimeMs, timeMs)
      const blockStart = Math.floor(Math.max(0, timeMs) / blockSizeMs) * blockSizeMs
      if (blockStart !== lastBlockStart) {
        blocks.push({ startMs: blockStart, endMs: blockStart + blockSizeMs, byteOffset: lineStart })
        lastBlockStart = blockStart
      }
      const stimulusName = stimulusIndex >= 0 ? String(line.split(',')[stimulusIndex] || '').trim() : ''
      if (stimulusName !== activeStimulusName) {
        if (activeStimulusName) {
          stimulusBoundaryEvents.push({
            x: 0, y: 0, timestamp: timeMs, stimulusName: activeStimulusName, markerOnly: true, parseVersion: 12,
          })
        }
        if (stimulusName) {
          stimulusBoundaryEvents.push({
            x: 0, y: 0, timestamp: timeMs, stimulusName, markerOnly: true, parseVersion: 12,
          })
        }
        activeStimulusName = stimulusName
      }
    }
  }
  lineStart = cursor + 1
}
if (activeStimulusName && Number.isFinite(maxVideoTimeMs)) {
  stimulusBoundaryEvents.push({
    x: 0, y: 0, timestamp: maxVideoTimeMs, stimulusName: activeStimulusName, markerOnly: true, parseVersion: 12,
  })
}

const fixationEvents = []
const saccadeGroups = new Map()
for (const line of fs.readFileSync(legacyFixationPath, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  for (const point of JSON.parse(line).points || []) {
    const state = Number(point.fixationState)
    if (state === 4 || point.markerOnly) {
      fixationEvents.push(point)
    } else if ((state === 1 || state === 2) && point.id !== undefined) {
      const key = String(point.id)
      const group = saccadeGroups.get(key) || []
      group.push(point)
      saccadeGroups.set(key, group)
    }
  }
}

const saccadeEvents = [...saccadeGroups.values()].map((points) => {
  points.sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
  const first = points[0]
  const last = points.at(-1)
  const duration = Number(first.saccadeDurationMs)
  return {
    ...first,
    x: last.x,
    y: last.y,
    weight: Number.isFinite(duration) ? duration : Math.max(0, Number(last.timestamp) - Number(first.timestamp)),
    fixationState: 2,
    saccadeDurationMs: Number.isFinite(duration) ? duration : undefined,
    saccadeStartX: first.saccadeStartX ?? first.x,
    saccadeStartY: first.saccadeStartY ?? first.y,
    saccadeEndX: last.saccadeEndX ?? last.x,
    saccadeEndY: last.saccadeEndY ?? last.y,
  }
})
const analysisEvents = [...fixationEvents, ...saccadeEvents, ...stimulusBoundaryEvents]
  .map((point) => ({ ...point, parseVersion: 12 }))
  .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))

const analysisText = [
  columns.join(','),
  ...analysisEvents.map((point) => columns.map((key) => encodeCell(point[key])).join(',')),
].join('\n') + '\n'
const previousMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
const stat = fs.statSync(csvPath)
const nextMeta = {
  ...previousMeta,
  version: 4,
  parseVersion: 12,
  sourceSizeBytes: stat.size,
  sourceMtimeMs: Math.floor(stat.mtimeMs),
  createdAt: new Date().toISOString(),
  blockSizeMs,
  totalRows,
  durationMs: Math.max(0, maxVideoTimeMs - minVideoTimeMs),
  minVideoTimeMs,
  maxVideoTimeMs,
  fixationPointCount: fixationEvents.filter((point) => Number(point.fixationState) === 4).length,
  gazePointCount,
  analysisEventCount: analysisEvents.length,
  blocks,
  files: { analysis: path.basename(analysisPath) },
}

const suffix = `.tmp-${process.pid}`
fs.writeFileSync(`${analysisPath}${suffix}`, analysisText, 'utf8')
fs.writeFileSync(`${metaPath}${suffix}`, `${JSON.stringify(nextMeta, null, 2)}\n`, 'utf8')
fs.renameSync(`${analysisPath}${suffix}`, analysisPath)
fs.renameSync(`${metaPath}${suffix}`, metaPath)

console.log(JSON.stringify({
  csvPath,
  totalRows,
  gazePointCount,
  fixationEvents: nextMeta.fixationPointCount,
  saccadeEvents: saccadeEvents.length,
  analysisEventCount: analysisEvents.length,
  blocks: blocks.length,
  durationMs: nextMeta.durationMs,
}, null, 2))

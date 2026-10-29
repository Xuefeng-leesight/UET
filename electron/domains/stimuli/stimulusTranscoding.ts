import * as fs from 'node:fs'

export function createStimulusTranscoder(
  findFfmpegBinary: () => string | null,
  runCommand: (command: string, args: string[], cwd?: string) => Promise<void>,
) {
  return async function transcodeStimulusVideoToMp4(sourcePath: string, destPath: string): Promise<{ ok: true; message?: never } | { ok: false; message: string }> {
    const ffmpegBin = findFfmpegBinary()
    if (!ffmpegBin) {
      return { ok: false, message: '未找到 ffmpeg，无法转换视频格式' }
    }
  
    const tempOut = `${destPath}.tmp_${Date.now()}.mp4`
    const args: string[] = [
      '-y',
      '-i',
      sourcePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      tempOut,
    ]
  
    try {
      await runCommand(ffmpegBin, args)
      const outStat = await fs.promises.stat(tempOut)
      if (!outStat.isFile() || outStat.size <= 0) {
        try {
          await fs.promises.unlink(tempOut)
        } catch {
        }
        return { ok: false, message: '转换后的视频为空文件' }
      }
      await fs.promises.rename(tempOut, destPath)
      return { ok: true }
    } catch (error: unknown) {
      try {
        await fs.promises.unlink(tempOut)
      } catch {
      }
      return { ok: false, message: `视频格式转换失败：${error instanceof Error ? error.message : '未知错误'}` }
    }
  }
  
}

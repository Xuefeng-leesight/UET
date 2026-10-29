import type { ErrorLog } from '@/shared/types/mrt';

/**
 * 错误日志记录器
 * 统一管理应用程序的错误日志
 */
export class ErrorLogger {
  private logs: ErrorLog[] = [];
  private maxLogs: number = 1000; // 最多保留1000条日志

  /**
   * 记录日志
   */
  log(level: ErrorLog['level'], module: string, message: string, details?: unknown): void {
    const log: ErrorLog = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      details,
    };

    this.logs.push(log);

    // 限制日志数量
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // 输出到控制台
    const consoleMethod = level === 'error' ? console.error : level === 'warning' ? console.warn : console.log;
    consoleMethod(`[${module}] ${message}`, details || '');

    // 错误级别的日志可以考虑持久化（通过IPC）
    if (level === 'error') {
      this.persistErrorLog(log);
    }
  }

  /**
   * 记录错误
   */
  error(module: string, message: string, details?: unknown): void {
    this.log('error', module, message, details);
  }

  /**
   * 记录警告
   */
  warning(module: string, message: string, details?: unknown): void {
    this.log('warning', module, message, details);
  }

  /**
   * 记录信息
   */
  info(module: string, message: string, details?: unknown): void {
    this.log('info', module, message, details);
  }

  /**
   * 获取所有日志
   */
  getLogs(): ErrorLog[] {
    return [...this.logs];
  }

  /**
   * 获取特定级别的日志
   */
  getLogsByLevel(level: ErrorLog['level']): ErrorLog[] {
    return this.logs.filter(log => log.level === level);
  }

  /**
   * 获取特定模块的日志
   */
  getLogsByModule(module: string): ErrorLog[] {
    return this.logs.filter(log => log.module === module);
  }

  /**
   * 清空日志
   */
  clearLogs(): void {
    this.logs = [];
  }

  /**
   * 持久化错误日志（可选）
   */
  private persistErrorLog(log: ErrorLog): void {
    // 这里可以通过IPC将错误日志保存到文件
    // 暂时只在控制台输出
    try {
      // 如果需要持久化，可以调用IPC方法
      // await ipcClient.saveErrorLog({ log });
    } catch (error) {
      console.error('持久化错误日志失败:', error);
    }
  }

  /**
   * 导出日志为JSON
   */
  exportLogsAsJSON(): string {
    return JSON.stringify(this.logs, null, 2);
  }

  /**
   * 导出日志为文本
   */
  exportLogsAsText(): string {
    return this.logs
      .map(log => `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.module}] ${log.message}`)
      .join('\n');
  }
}

// 导出单例实例
export const errorLogger = new ErrorLogger();

/**
 * 用户友好的错误提示工具
 */
export class ErrorHandler {
  /**
   * 显示数据验证错误
   */
  static showValidationError(field: string, message: string): void {
    alert(`${field}: ${message}`);
    errorLogger.warning('Validation', `${field}: ${message}`);
  }

  /**
   * 显示网络通讯错误
   */
  static showNetworkError(operation: string, error?: unknown): void {
    const message = `网络操作失败: ${operation}。请检查网络连接和配置。`;
    alert(message);
    errorLogger.error('Network', message, error);
  }

  /**
   * 显示文件系统错误
   */
  static showFileSystemError(operation: string, error?: unknown): void {
    let message = `文件操作失败: ${operation}。`;
    const errorCode = typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
    
    if (errorCode === 'ENOSPC') {
      message += '磁盘空间不足。';
    } else if (errorCode === 'EACCES') {
      message += '权限不足，无法访问文件。';
    } else {
      message += '请稍后重试。';
    }
    
    alert(message);
    errorLogger.error('FileSystem', message, error);
  }

  /**
   * 显示播放错误
   */
  static showPlaybackError(stimulusName: string, error?: unknown): void {
    const message = `刺激物 "${stimulusName}" 播放失败，已跳过。`;
    alert(message);
    errorLogger.error('Playback', message, error);
  }

  /**
   * 显示Trigger发送错误
   */
  static showTriggerError(mark: number, error?: unknown): void {
    const message = `Trigger标记 ${mark} 发送失败。请检查UDP配置。`;
    alert(message);
    errorLogger.error('Trigger', message, error);
  }

  /**
   * 显示通用错误
   */
  static showGenericError(operation: string, error?: unknown): void {
    const message = `操作失败: ${operation}。请稍后重试。`;
    alert(message);
    errorLogger.error('General', message, error);
  }

  /**
   * 显示成功消息
   */
  static showSuccess(message: string): void {
    // 可以使用更友好的通知组件替代alert
    console.log(`✓ ${message}`);
    errorLogger.info('Success', message);
  }
}

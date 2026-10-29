import type { TriggerConfig, ValidationError } from '@/shared/types/mrt';

/**
 * Trigger通讯服务
 * 管理UDP连接和数据发送（客户端侧）
 */
export class TriggerService {
  /**
   * 验证配置参数
   * @param config Trigger配置
   * @returns 验证结果
   */
  validateConfig(config: TriggerConfig): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (config.serialEnabled) {
      if (!String(config.serialPath || '').trim() || /[\u0000\r\n]/.test(config.serialPath || '')) errors.push('请填写有效的串口路径');
      if (!Number.isInteger(config.serialBaudRate ?? 115200) || (config.serialBaudRate ?? 115200) < 1 || (config.serialBaudRate ?? 115200) > 4_000_000) {
        errors.push('串口波特率必须是 1–4000000 的整数');
      }
      if (![5, 6, 7, 8].includes(config.serialDataBits ?? 8)) errors.push('串口数据位无效');
      if (![1, 1.5, 2].includes(config.serialStopBits ?? 1)) errors.push('串口停止位无效');
      if (!['none', 'even', 'odd', 'mark', 'space'].includes(config.serialParity ?? 'none')) errors.push('串口校验位无效');
    }

    // 验证端口号范围
    if (config.udpSendPort < 1 || config.udpSendPort > 65535) {
      errors.push('UDP发送端口必须在1-65535范围内');
    }
    if (config.udpReceivePort < 1 || config.udpReceivePort > 65535) {
      errors.push('UDP接收端口必须在1-65535范围内');
    }

    // 验证发送和接收端口不相同
    if (config.udpSendPort === config.udpReceivePort) {
      errors.push('发送端口和接收端口不能相同');
    }

    if (config.tcpListenPort < 1 || config.tcpListenPort > 65535) {
      errors.push('TCP监听端口必须在1-65535范围内');
    }

    const listenIp = String(config.tcpListenIp || '').trim();
    if (!listenIp) {
      errors.push('TCP监听地址不能为空');
    }

    // 验证IP地址格式（IPv4）
    const ipRegex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = config.targetIp.match(ipRegex);
    
    if (!match) {
      errors.push('IP地址格式无效，请使用IPv4格式（例如：192.168.1.1）');
    } else {
      // 验证每个数字在0-255范围内
      for (let i = 1; i <= 4; i++) {
        const num = parseInt(match[i], 10);
        if (num < 0 || num > 255) {
          errors.push('IP地址每个部分必须在0-255范围内');
          break;
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * 验证Trigger标记
   * @param value 输入值
   * @returns 验证错误或null
   */
  validateTriggerMark(value: string): ValidationError | null {
    if (!value.trim()) {
      return { field: 'triggerMark', message: 'Trigger标记不能为空', value };
    }
    
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return { field: 'triggerMark', message: 'Trigger标记必须是有效数字', value };
    }
    
    if (num < 0 || num > 65535) {
      return { field: 'triggerMark', message: 'Trigger标记应在0-65535范围内', value };
    }
    
    return null;
  }
}

// 导出单例实例
export const triggerService = new TriggerService();

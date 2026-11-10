import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** 当提供时，渲染在此处而不再上抛；用于页面级 lazy 容器。 */
  fallback?: React.ReactNode | ((error: Error, reset: () => void) => React.ReactNode);
  /** 出错时的回调，用于上报日志。 */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 应用级错误边界。任一子树抛错时展示可恢复的占位 UI，避免整应用白屏。
 * 在生产环境尤为重要：lazy 页面加载失败或运行时异常都能被兜住。
 */
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  // React 的类型声明在本项目未安装（react 无内置 d.ts，React.Component 推断为 any），
  // 因此显式声明继承自基类的成员，保证 this.props / this.setState 可被类型系统识别。
  declare props: ErrorBoundaryProps
  declare setState: (state: Partial<ErrorBoundaryState> | null) => void
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string | null }): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] captured', error, info.componentStack);
    this.props.onError?.(error, info as React.ErrorInfo);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback !== undefined) {
      return typeof this.props.fallback === 'function'
        ? this.props.fallback(error, this.reset)
        : this.props.fallback;
    }
    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '60vh',
          padding: '24px',
          gap: '12px',
          color: '#1f2937',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>页面出现问题</h2>
        <p style={{ margin: 0, color: '#6b7280', maxWidth: '480px', textAlign: 'center' }}>
          {error.message || '发生了未知错误。'}
        </p>
        <button
          type="button"
          onClick={this.reset}
          style={{
            padding: '8px 16px',
            border: '1px solid #d1d5db',
            borderRadius: '6px',
            background: '#ffffff',
            cursor: 'pointer',
            fontSize: '14px',
          }}
        >
          重试
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;

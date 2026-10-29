import React from 'react';

type AutoResizeTextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const AutoResizeTextarea = React.forwardRef<HTMLTextAreaElement, AutoResizeTextareaProps>(function AutoResizeTextarea(
  { rows = 3, style, onInput, ...props },
  forwardedRef,
) {
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const measuredSizeRef = React.useRef({ width: 0, height: 0 });
  React.useImperativeHandle(forwardedRef, () => textareaRef.current!, []);

  const resize = React.useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (textarea.getClientRects().length === 0) {
      measuredSizeRef.current = { width: 0, height: 0 };
      return;
    }
    const computed = getComputedStyle(textarea);
    const padding = parseFloat(computed.paddingTop) + parseFloat(computed.paddingBottom);
    const border = parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth);
    const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.5;
    const minimum = parseFloat(computed.minHeight)
      || Math.max(1, textarea.rows) * lineHeight + padding + border;

    // Collapse only while measuring so deleting text can also shrink the field.
    textarea.style.overflowY = 'hidden';
    textarea.style.height = '0px';
    const contentHeight = Math.max(minimum, textarea.scrollHeight + border);
    textarea.style.height = `${computed.boxSizing === 'border-box' ? contentHeight : contentHeight - padding - border}px`;
    // CSS max-height limits growth in dialogs; the remaining content stays reachable.
    textarea.style.overflowY = textarea.scrollHeight > textarea.clientHeight + 1 ? 'auto' : 'hidden';
    measuredSizeRef.current = { width: textarea.clientWidth, height: textarea.clientHeight };
  }, []);

  // Covers initial/loaded controlled values, clearing and parent layout changes.
  React.useLayoutEffect(resize);

  React.useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      const measured = measuredSizeRef.current;
      if (textarea.clientWidth === measured.width && textarea.clientHeight === measured.height) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });
    observer.observe(textarea);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [resize]);

  return (
    <textarea
      {...props}
      ref={textareaRef}
      rows={rows}
      style={{ maxHeight: 'min(18rem, 40vh)', ...style, resize: 'none' }}
      onInput={(event) => {
        onInput?.(event);
        resize();
      }}
    />
  );
});

export default AutoResizeTextarea;

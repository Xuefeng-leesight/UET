import React from 'react';
import { LiquidGlassLens } from '@/app/layout/LiquidGlassLens';

/** Follows <html data-theme> without re-applying the theme (unlike useTheme). */
function useIsGlassTheme(): boolean {
  const read = () => document.documentElement.dataset.theme === 'glass';
  const [glass, setGlass] = React.useState(read);
  React.useEffect(() => {
    const observer = new MutationObserver(() => setGlass(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    setGlass(read());
    return () => observer.disconnect();
  }, []);
  return glass;
}

/**
 * The sidebar's liquid glass lens for a horizontal switch (tab bar or mode switch),
 * shown only in the glass theme. Put it inside the container that holds the items;
 * mark each item with data-nav-id and aria-pressed (or aria-selected). The lens glides
 * to the selected item, keeps one width across the items, and can be dragged sideways;
 * dropping it calls onSelect with the nearest item's id, or by default clicks that
 * item, so it runs exactly what a click on it would.
 */
export function GlassSegmentLens({
  containerRef,
  activeKey,
  onSelect,
  memoryKey,
  maxHeight = 30,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  activeKey: string;
  onSelect?: (id: string) => void;
  /** Give switches that are re-rendered (e.g. per mode) a shared key so they still glide. */
  memoryKey?: string;
  maxHeight?: number;
}) {
  const glass = useIsGlassTheme();
  const select = React.useCallback((id: string) => {
    if (onSelect) {
      onSelect(id);
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    let target: HTMLElement | null = null;
    container.querySelectorAll<HTMLElement>('[data-nav-id]').forEach((item) => {
      if (!target && item.dataset.navId === id) target = item;
    });
    (target as HTMLElement | null)?.click();
  }, [containerRef, onSelect]);
  if (!glass) return null;
  return (
    <LiquidGlassLens
      containerRef={containerRef}
      activeKey={activeKey}
      onSelect={select}
      axis="x"
      activeSelector='[data-nav-id]:is([aria-pressed="true"], [aria-selected="true"])'
      uniformWidth
      maxHeight={maxHeight}
      memoryKey={memoryKey}
      dragTitle="拖动切换"
    />
  );
}

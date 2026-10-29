import { useLayoutEffect, useRef, useSyncExternalStore, type ButtonHTMLAttributes } from 'react';
import { createGlassSwitch } from './switches/glassSwitchController';

type Size = 'normal' | 'compact' | 'timeline';
type VisualProps = {
  checked: boolean;
  disabled?: boolean;
  size?: Size;
  activeClass?: string;
  inactiveClass?: string;
};

const subscribers = new Set<() => void>();
let themeObserver: MutationObserver | undefined;
function subscribeTheme(listener: () => void) {
  subscribers.add(listener);
  themeObserver ??= new MutationObserver(() => subscribers.forEach((notify) => notify()));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) { themeObserver?.disconnect(); themeObserver = undefined; }
  };
}
const isGlassTheme = () => document.documentElement.dataset.theme === 'glass';

/** Visual only: dropdowns retain their option button and its existing click contract. */
export function SwitchVisual({ checked, disabled = false, size = 'normal', activeClass = 'bg-sky-500', inactiveClass = 'bg-slate-300' }: VisualProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const controller = useRef<ReturnType<typeof createGlassSwitch> | null>(null);
  const glass = useSyncExternalStore(subscribeTheme, isGlassTheme, () => false);
  useLayoutEffect(() => {
    if (!glass || !ref.current) return;
    controller.current = createGlassSwitch(ref.current, checked, disabled);
    return () => { controller.current?.dispose(); controller.current = null; };
  }, [glass]);
  useLayoutEffect(() => { controller.current?.update(checked, disabled); }, [checked, disabled, glass, activeClass, inactiveClass]);
  return (
    <span ref={ref} data-switch-track data-checked={checked} data-size={size} className="mrt-switch-visual" aria-hidden="true">
      <span className={`mrt-switch-track ${checked ? activeClass : inactiveClass}`} />
      <span className="mrt-switch-thumb" />
      <span className={`mrt-switch-paint-on ${activeClass}`} />
      <span className={`mrt-switch-paint-off ${inactiveClass}`} />
      <canvas className="mrt-switch-lens" />
    </span>
  );
}

type SwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & VisualProps;
export default function Switch({ checked, disabled, size, activeClass, inactiveClass, className = '', ...props }: SwitchProps) {
  return (
    <button {...props} type="button" role="switch" aria-checked={checked} disabled={disabled} className={`mrt-switch ${className}`}>
      <SwitchVisual checked={checked} disabled={disabled} size={size} activeClass={activeClass} inactiveClass={inactiveClass} />
    </button>
  );
}

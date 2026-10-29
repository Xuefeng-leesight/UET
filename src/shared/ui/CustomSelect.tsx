import React from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

type ParsedOption = {
  value: string;
  label: React.ReactNode;
  disabled: boolean;
};

interface CustomSelectProps {
  'aria-label'?: string;
  value?: string | number | null;
  onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  children?: React.ReactNode;
  className?: string;
  menuClassName?: string;
  portalMenu?: boolean;
  disabled?: boolean;
  showArrow?: boolean;
  fullWidth?: boolean;
  menuMatchTriggerWidth?: boolean;
  truncateSelectedLabel?: boolean;
  truncateOptionLabel?: boolean;
  dataI18nSkip?: boolean;
}

function collectOptions(nodes: React.ReactNode): ParsedOption[] {
  const result: ParsedOption[] = [];
  const visit = (node: React.ReactNode): void => {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return;
      if (child.type === React.Fragment) {
        visit(child.props.children);
        return;
      }
      if (typeof child.type !== 'string' || child.type.toLowerCase() !== 'option') {
        return;
      }
      const optionValue = child.props.value;
      const value =
        optionValue === undefined || optionValue === null
          ? String(child.props.children ?? '')
          : String(optionValue);
      result.push({
        value,
        label: child.props.children ?? value,
        disabled: !!child.props.disabled,
      });
    });
  };
  visit(nodes);
  return result;
}

const CustomSelect: React.FC<CustomSelectProps> = ({
  'aria-label': ariaLabel,
  value,
  onChange,
  children,
  className = '',
  menuClassName = '',
  portalMenu = false,
  disabled = false,
  showArrow = true,
  fullWidth = true,
  menuMatchTriggerWidth = true,
  truncateSelectedLabel = true,
  truncateOptionLabel = true,
  dataI18nSkip = false,
}) => {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = React.useState<React.CSSProperties | null>(null);
  const options = React.useMemo(() => collectOptions(children), [children]);
  const currentValue = value === undefined || value === null ? '' : String(value);
  const selected = options.find((opt) => opt.value === currentValue) || null;

  React.useLayoutEffect(() => {
    if (!open || !portalMenu) return;
    const positionMenu = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const placeAbove = below < Math.min(256, options.length * 36 + 8) && above > below;
      const available = Math.max(0, placeAbove ? above : below);
      const width = Math.min(rect.width, window.innerWidth - 16);
      setMenuPosition({
        position: 'fixed',
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        width: menuMatchTriggerWidth ? width : undefined,
        minWidth: width,
        maxWidth: window.innerWidth - 16,
        maxHeight: Math.min(256, available),
        ...(placeAbove ? { bottom: window.innerHeight - rect.top } : { top: rect.bottom }),
        zIndex: 2147483647,
      });
    };
    positionMenu();
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    return () => {
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
    };
  }, [open, portalMenu, menuMatchTriggerWidth, options.length]);

  React.useEffect(() => {
    if (!open) return;

    const onMouseDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (!root.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const emitChange = React.useCallback(
    (nextValue: string) => {
      if (!onChange) return;
      const syntheticEvent = {
        target: { value: nextValue },
      } as React.ChangeEvent<HTMLSelectElement>;
      onChange(syntheticEvent);
    },
    [onChange],
  );

  const handleSelect = React.useCallback(
    (option: ParsedOption) => {
      if (disabled || option.disabled) return;
      setOpen(false);
      if (option.value !== currentValue) {
        emitChange(option.value);
      }
    },
    [disabled, emitChange, currentValue],
  );

  const buttonClassName = [
    fullWidth ? 'w-full' : 'w-auto',
    'mrt-select relative block min-h-7 rounded-lg text-left transition-colors',
    'bg-[var(--app-control)] text-slate-700',
    'focus-visible:ring-2 focus-visible:ring-sky-500/10 outline-none',
    'disabled:opacity-60 disabled:cursor-not-allowed',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const selectedLabel = selected?.label ?? (options.find((opt) => !opt.disabled)?.label || '');

  const menu = open && (
    <div
      ref={menuRef}
      role="listbox"
      aria-label={ariaLabel}
      data-side={portalMenu && menuPosition?.bottom !== undefined ? 'top' : 'bottom'}
      style={portalMenu ? menuPosition ?? { visibility: 'hidden', position: 'fixed' } : undefined}
      className={`mrt-dropdown-panel ${portalMenu ? '' : `absolute top-full ${menuMatchTriggerWidth ? 'left-0 right-0' : 'left-0 min-w-full w-max'} z-[120]`} max-h-64 overflow-auto bg-white p-1 shadow-lg ${menuClassName}`.trim()}
    >
      {options.length === 0 ? (
        <div className="px-2 py-2 text-xs text-slate-400">暂无可选项</div>
      ) : options.map((option) => (
        <button
          key={`${option.value}-${String(option.label)}`}
          type="button"
          role="option"
          title={typeof option.label === 'string' ? option.label : undefined}
          aria-selected={option.value === currentValue}
          disabled={option.disabled}
          onClick={() => handleSelect(option)}
          className={`mrt-dropdown-option flex w-full items-center gap-2 px-2 py-2 text-left text-xs transition-colors ${option.disabled
            ? 'text-slate-300 cursor-not-allowed'
            : option.value === currentValue ? 'bg-sky-50 text-sky-600 font-semibold'
            : 'text-slate-600 hover:bg-slate-50'}`}
        >
          <span className={`block min-w-0 flex-1 ${truncateOptionLabel ? 'truncate' : 'whitespace-normal break-words leading-tight'}`}>{option.label}</span>
          <Check size={13} aria-hidden="true" className={`shrink-0 ${option.value === currentValue ? '' : 'invisible'}`} />
        </button>
      ))}
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={`${fullWidth ? 'relative' : 'relative inline-block max-w-full'}${open ? ' z-[121]' : ''}`}
      data-i18n-skip={dataI18nSkip ? 'true' : undefined}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        title={typeof selectedLabel === 'string' ? selectedLabel : undefined}
        data-select-arrow={showArrow ? 'true' : undefined}
        data-side={portalMenu && menuPosition?.bottom !== undefined ? 'top' : 'bottom'}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            setOpen((prev) => !prev);
          }
        }}
        className={buttonClassName}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`block ${truncateSelectedLabel ? 'truncate' : 'whitespace-nowrap'}`}>{selectedLabel}</span>
        {showArrow && (
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={`absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none transition-transform ${
              open ? 'rotate-180' : ''
            }`}
          />
        )}
      </button>

      {portalMenu && open ? createPortal(menu, document.body) : menu}
    </div>
  );
};

export default CustomSelect;

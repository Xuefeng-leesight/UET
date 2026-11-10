import React from 'react';

interface SpinnerRingProps {
  className?: string;
  style?: React.CSSProperties;
}

const SpinnerRing: React.FC<SpinnerRingProps> = ({ className = '', style }) => {
  const ref = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== 'function') return;
    const animation = el.animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 800, iterations: Infinity, easing: 'linear' },
    );
    return () => {
      animation.cancel();
    };
  }, []);

  return (
    <span
      ref={ref}
      className={className}
      style={{
        display: 'inline-block',
        transformOrigin: '50% 50%',
        ...style,
      }}
    />
  );
};

export default SpinnerRing;

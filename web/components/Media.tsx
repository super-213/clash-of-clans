import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ImageOff, X } from 'lucide-react';
import type { Unit } from '../../shared/schema';
import { unitName } from '../format';

export function Picture({
  src,
  alt,
  ...props
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return broken ? (
    <div className="image-fallback">
      <ImageOff size={24} />
      <span>图片暂不可用</span>
    </div>
  ) : (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      {...props}
    />
  );
}
export function UnitStrip({
  units,
  full = false,
}: {
  units: Unit[];
  full?: boolean;
}) {
  return (
    <div className={full ? 'units units-full' : 'units'}>
      {units.map((unit, index) => (
        <div
          className="unit"
          key={`${unit.group}-${index}`}
          title={`${unitName(unit)} ×${unit.count}`}
        >
          <Picture src={unit.image_url} alt={unitName(unit)} />
          <b>×{unit.count}</b>
          {full && <span>{unitName(unit)}</span>}
        </div>
      ))}
    </div>
  );
}
export function Dialog({
  children,
  close,
  label,
  className,
}: {
  children: ReactNode;
  close: () => void;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const scrollY = window.scrollY;
    const bodyStyle = document.body.style.cssText;
    const htmlOverflow = document.documentElement.style.overflow;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    document.documentElement.style.overflow = 'hidden';
    dialog?.showModal();
    return () => {
      dialog?.close();
      document.body.style.cssText = bodyStyle;
      document.documentElement.style.overflow = htmlOverflow;
      window.scrollTo(0, scrollY);
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      onCancel={close}
      aria-label={label}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="dialog-toolbar">
        <span>{label}</span>
        <button
          className="icon-button dialog-close"
          aria-label="关闭"
          onClick={close}
        >
          <X size={20} />
        </button>
      </div>
      <div className="dialog-scroll">{children}</div>
    </dialog>
  );
}

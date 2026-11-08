import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

interface RuntimeDisclosureProps {
  id: string;
  label: string;
  disabled?: boolean;
  busy?: boolean;
  overlay?: boolean;
  children: (close: () => void) => ComponentChildren;
}

/** A disclosure of ordinary controls: native tab order, with no menu semantics or focus trap. */
export default function RuntimeDisclosure({ id, label, disabled, busy, overlay, children }: RuntimeDisclosureProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  function close(): void {
    setOpen(false);
    trigger.current?.focus();
  }
  useEffect(() => {
    const element = root.current;
    if (!open || !element) return;
    const document = element.ownerDocument;
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    document.addEventListener('click', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div ref={root} class={`doc-disclosure${overlay ? ' doc-disclosure--overlay' : ''}`}>
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (busy) return;
          if (open) close();
          else setOpen(true);
        }}
      >
        {label} <span aria-hidden="true">▾</span>
      </button>
      <div id={id} class="doc-disclosure__content" hidden={!open}>
        {children(close)}
      </div>
    </div>
  );
}

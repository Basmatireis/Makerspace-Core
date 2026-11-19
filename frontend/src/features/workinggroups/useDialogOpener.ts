import { useRef, useState } from 'react';

/** State of a dialog that returns focus to the control that opened it when it closes. */
export function useDialogOpener<T = true>() {
  const opener = useRef<HTMLElement | null>(null);
  const [value, setValue] = useState<T | null>(null);
  return {
    value,
    open: (next: T) => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setValue(next);
    },
    close: () => {
      setValue(null);
      window.setTimeout(() => opener.current?.focus(), 0);
    },
  };
}

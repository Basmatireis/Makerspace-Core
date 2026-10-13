/* eslint-disable react-refresh/only-export-components -- the provider and its hook belong together */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ToastNotification } from '@carbon/react';

export type Toast = { kind: 'success' | 'info' | 'warning' | 'error'; title: string; subtitle?: string };
type Notify = (toast: Toast) => void;

const NotifyContext = createContext<Notify | null>(null);

/** Transient confirmation toasts for the Machines & Jobs area (mounted by MachineLogbookLayout). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<(Toast & { id: number })[]>([]);
  const nextId = useMemo(() => ({ value: 0 }), []);
  const notify = useCallback<Notify>((toast) => setToasts((current) => [...current, { ...toast, id: ++nextId.value }]), [nextId]);
  const dismiss = (id: number) => setToasts((current) => current.filter((toast) => toast.id !== id));
  return (
    <NotifyContext.Provider value={notify}>
      {children}
      <div className="mj-toasts" aria-live="polite">
        {toasts.map((toast) => (
          <ToastNotification key={toast.id} kind={toast.kind} lowContrast timeout={5000} title={toast.title} subtitle={toast.subtitle} onClose={() => { dismiss(toast.id); return false; }} onCloseButtonClick={() => dismiss(toast.id)} />
        ))}
      </div>
    </NotifyContext.Provider>
  );
}

/** `notify({ kind: 'success', title })`. Does nothing outside a ToastProvider. */
export function useNotify(): Notify {
  return useContext(NotifyContext) ?? (() => undefined);
}

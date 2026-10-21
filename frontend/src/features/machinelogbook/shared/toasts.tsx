/* eslint-disable react-refresh/only-export-components -- the provider and its hook belong together */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { ActionableNotification, ToastNotification } from '@carbon/react';
import { useNavigate } from 'react-router-dom';

export type Toast = {
  kind: 'success' | 'info' | 'warning' | 'error';
  title: string;
  subtitle?: string;
  link?: { label: string; to: string };
};
type Notify = (toast: Toast) => void;

const NotifyContext = createContext<Notify | null>(null);

/** A toast with a follow-up action: Carbon toasts take no interactive children, so it is an actionable notification. Needs a router. */
function LinkToast({
  toast,
  onDismiss,
}: {
  toast: Toast & { link: NonNullable<Toast['link']> };
  onDismiss: () => void;
}) {
  const navigate = useNavigate();
  return (
    <ActionableNotification
      kind={toast.kind}
      lowContrast
      hasFocus={false}
      role="status"
      title={toast.title}
      subtitle={toast.subtitle}
      actionButtonLabel={toast.link.label}
      onActionButtonClick={() => {
        onDismiss();
        navigate(toast.link.to);
      }}
      onClose={() => {
        onDismiss();
        return false;
      }}
      onCloseButtonClick={onDismiss}
    />
  );
}

/** Transient confirmation toasts for the Machines & Jobs area (mounted by MachineLogbookLayout). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<(Toast & { id: number })[]>([]);
  const nextId = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  // Stable identity: notify is the context value, and consumers list it as a dependency.
  const notify = useCallback<Notify>(
    (toast) => {
      const id = ++nextId.current;
      setToasts((current) => [...current, { ...toast, id }]);
      // Carbon times plain toasts out itself; actionable ones stay a little longer so the action can be reached.
      if (toast.link) window.setTimeout(() => dismiss(id), 10000);
    },
    [dismiss],
  );
  return (
    <NotifyContext.Provider value={notify}>
      {children}
      <div className="mj-toasts" aria-live="polite">
        {toasts.map((toast) =>
          toast.link ? (
            <LinkToast key={toast.id} toast={{ ...toast, link: toast.link }} onDismiss={() => dismiss(toast.id)} />
          ) : (
            <ToastNotification
              key={toast.id}
              kind={toast.kind}
              lowContrast
              timeout={5000}
              title={toast.title}
              subtitle={toast.subtitle}
              onClose={() => {
                dismiss(toast.id);
                return false;
              }}
              onCloseButtonClick={() => dismiss(toast.id)}
            />
          ),
        )}
      </div>
    </NotifyContext.Provider>
  );
}

/** `notify({ kind: 'success', title })`. Does nothing outside a ToastProvider. */
export function useNotify(): Notify {
  return useContext(NotifyContext) ?? (() => undefined);
}

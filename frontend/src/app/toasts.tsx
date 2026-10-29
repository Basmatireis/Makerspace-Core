/* eslint-disable react-refresh/only-export-components -- the provider and its hook belong together */
import './toasts.scss';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { ActionableNotification, ToastNotification } from '@carbon/react';
import { useNavigate } from 'react-router-dom';

export type Toast = {
  kind: 'success' | 'info' | 'warning' | 'error';
  title: string;
  subtitle?: string;
  /** Opens an app path. */
  link?: { label: string; to: string };
  /** A follow-up that is not a plain app path, for example opening a notification. Used instead of `link`. */
  action?: { label: string; run: () => void };
  /** `top` shows the toast at the top right (new notifications); the default is the bottom right. */
  placement?: 'top';
};
type Notify = (toast: Toast) => void;

const NotifyContext = createContext<Notify | null>(null);

/** A toast with a follow-up action: Carbon toasts take no interactive children, so it is an actionable notification. Needs a router. */
function LinkToast({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const navigate = useNavigate();
  const label = toast.action?.label ?? toast.link?.label;
  return (
    <ActionableNotification
      kind={toast.kind}
      lowContrast
      hasFocus={false}
      role="status"
      title={toast.title}
      subtitle={toast.subtitle}
      actionButtonLabel={label}
      onActionButtonClick={() => {
        onDismiss();
        if (toast.action) toast.action.run();
        else if (toast.link) navigate(toast.link.to);
      }}
      onClose={() => {
        onDismiss();
        return false;
      }}
      onCloseButtonClick={onDismiss}
    />
  );
}

/**
 * Transient toasts for the whole application: confirmations and new notifications. The app shell mounts the one
 * region; a provider inside it (the Machines & Jobs layout) just reuses it.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const parent = useContext(NotifyContext);
  return parent ? <>{children}</> : <ToastRegion>{children}</ToastRegion>;
}

function ToastRegion({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<(Toast & { id: number })[]>([]);
  const nextId = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  // Stable identity: notify is the context value, and consumers list it as a dependency.
  const notify = useCallback<Notify>(
    (toast) => {
      const id = ++nextId.current;
      setToasts((current) => [...current, { ...toast, id }]);
      // Carbon times plain toasts out itself; actionable ones stay a little longer so the action can be reached.
      if (toast.link || toast.action) window.setTimeout(() => dismiss(id), 10000);
    },
    [dismiss],
  );
  return (
    <NotifyContext.Provider value={notify}>
      {children}
      {(['top', 'bottom'] as const).map((placement) => (
        <div key={placement} className={`app-toasts app-toasts--${placement}`} aria-live="polite">
          {toasts
            .filter((toast) => (toast.placement ?? 'bottom') === placement)
            .map((toast) =>
              toast.link || toast.action ? (
                <LinkToast key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
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
      ))}
    </NotifyContext.Provider>
  );
}

/** `notify({ kind: 'success', title })`. Does nothing outside a ToastProvider. */
export function useNotify(): Notify {
  return useContext(NotifyContext) ?? (() => undefined);
}

import { Outlet } from 'react-router-dom';
import { ToastProvider } from './toasts';
import './shared.scss';

/** Layout route of the whole Machines & Jobs area: loads the shared styles once and hosts the toast stack. */
export function MachineLogbookLayout() {
  return <ToastProvider><Outlet /></ToastProvider>;
}

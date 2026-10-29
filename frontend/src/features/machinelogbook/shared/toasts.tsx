/* eslint-disable react-refresh/only-export-components -- a re-export of the application-wide toast helper */
// The toast helper is application-wide (the header shows new notifications with it); it lives in src/app.
export { ToastProvider, useNotify, type Toast } from '../../../app/toasts';

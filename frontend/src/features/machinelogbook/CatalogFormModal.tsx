import { Modal } from '@carbon/react';
import { useEffect, useRef, type ComponentProps } from 'react';

/** These editors unmount on close; preserve their launcher across a discard view. */
export function CatalogFormModal(props: ComponentProps<typeof Modal>) {
  const launcher = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const element = launcher.current;
    return () => { if (element?.isConnected) element.focus(); };
  }, []);
  return <Modal {...props} />;
}

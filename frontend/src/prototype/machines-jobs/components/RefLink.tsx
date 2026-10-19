import { ActionableNotification } from '@carbon/react';
import { Fragment, type ReactNode } from 'react';
import { Link as CarbonLink } from '@carbon/react';
import { Link, useLocation } from 'react-router-dom';
import { useStore } from '../store';
import { refKind, refPermission, refRoute, splitRefs } from '../refs';

type RefLinkProps = {
  /** The visible reference, e.g. `O-2026-000118`. It also resolves the target when `id` is not given. */
  reference: string;
  /** Entity id when the caller already has it (skips the lookup by reference). */
  id?: string;
  /** Visible text when it differs from the reference. */
  children?: ReactNode;
  /** Called after the link was followed, e.g. to close the dialog it sits in. */
  onNavigate?: () => void;
};

/**
 * An underlined link to the page of a job, run, order or payment. Renders plain text when the entity is unknown, the role lacks the
 * read permission of the target, or the link would point at the page that is already open.
 */
export function RefLink({ reference, id, children, onNavigate }: RefLinkProps) {
  const store = useStore();
  const { pathname } = useLocation();
  const label = children ?? reference;
  const kind = refKind(reference);
  if (!kind || !store.can(refPermission[kind])) return <>{label}</>;
  const target = id ?? (kind === 'job' ? store.jobs.find((item) => item.displayId === reference)?.id
    : kind === 'run' ? store.prints.find((item) => item.displayId === reference)?.id
      : kind === 'order' ? store.orders.find((item) => item.reference === reference)?.id
        : store.payments.find((item) => item.reference === reference)?.id);
  if (!target) return <>{label}</>;
  const to = refRoute(kind, target);
  if (to === pathname) return <>{label}</>;
  return (
    <CarbonLink as={Link} to={to} inline onClick={(event: React.MouseEvent) => { event.stopPropagation(); onNavigate?.(); }}>{label}</CarbonLink>
  );
}

/** Renders generated text (timeline lines, summaries, reasons) and turns every job, run, order and payment reference in it into a RefLink. */
export function LinkifiedText({ text, onNavigate }: { text: string; onNavigate?: () => void }) {
  return (
    <>
      {splitRefs(text).map((part, index) => index % 2 === 1
        ? <RefLink key={index} reference={part} onNavigate={onNavigate} />
        : <Fragment key={index}>{part}</Fragment>)}
    </>
  );
}

/** Body of an inline notification that carries references: Carbon's title and subtitle props only take strings, its children render below them. */
/**
 * An inline notification whose body may contain links. Carbon's InlineNotification throws on interactive children,
 * so this uses the actionable variant without an action button.
 */
export function RichNotification({ kind, title, children, className }: { kind: 'info' | 'warning' | 'error' | 'success'; title: string; children: ReactNode; className?: string }) {
  return <ActionableNotification inline lowContrast hideCloseButton kind={kind} title={title} subtitle={children} className={className} />;
}

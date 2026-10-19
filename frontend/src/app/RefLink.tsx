import { Fragment, type MouseEvent, type ReactNode } from 'react';
import { Link as CarbonLink } from '@carbon/react';
import { Link, useLocation } from 'react-router-dom';
import { useCurrentUser } from '../features/auth/auth';
import { hasPermission } from '../features/auth/permissions';
import { refKind, refPermission, type RefKind, refRoute, splitRefs } from './references';

/** Reference -> entity id for the references a text may mention. Only references listed here become links. */
export type RefTargets = Readonly<Record<string, string | undefined>>;

type RefLinkProps = {
  /** The visible reference, e.g. `O-2026-000118`. Its prefix selects the target page. */
  reference: string;
  /** Entity id. Without it nothing is known about the target and the reference stays plain text. */
  id: string | null | undefined;
  /** Visible text when it differs from the reference. */
  children?: ReactNode;
  /** Target type when the caller knows it; otherwise the reference prefix decides. */
  kind?: RefKind;
  /** Called after the link was followed, e.g. to close the dialog it sits in. */
  onNavigate?: () => void;
};

/**
 * An underlined link to the page of a job, run, order, payment or spool. Renders plain text when the id is unknown, the
 * person lacks the read permission of the target, or the link would point at the page that is already open.
 */
export function RefLink({ reference, id, kind: knownKind, children, onNavigate }: RefLinkProps) {
  const currentUser = useCurrentUser();
  const { pathname } = useLocation();
  const label = children ?? reference;
  const kind = knownKind ?? refKind(reference);
  if (!kind || !id || !hasPermission(currentUser, refPermission[kind])) return <>{label}</>;
  const to = refRoute(kind, id);
  if (to === pathname) return <>{label}</>;
  return (
    <CarbonLink as={Link} to={to} inline onClick={(event: MouseEvent) => { event.stopPropagation(); onNavigate?.(); }}>{label}</CarbonLink>
  );
}

/** Renders generated text (summaries, reasons, messages) and turns every reference listed in `targets` into a RefLink. */
export function LinkifiedText({ text, targets, onNavigate }: { text: string; targets: RefTargets; onNavigate?: () => void }) {
  return (
    <>
      {splitRefs(text).map((part, index) => index % 2 === 1
        ? <RefLink key={index} reference={part} id={targets[part]} onNavigate={onNavigate} />
        : <Fragment key={index}>{part}</Fragment>)}
    </>
  );
}

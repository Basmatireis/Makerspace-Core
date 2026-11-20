import { useMemo, useState } from 'react';
import { Button, Modal, Tag, Tile as CarbonTile } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { WorkingGroupProject, WorkingGroupPurchase, WorkingGroupSummary } from '../../api/generated/models';
import { DetailPanel, DetailPanelHead, DetailPanelSection } from '../../app/components/DetailPanel';
import { ListWithPanel, useListPanelLayout } from '../../app/components/ListWithPanel';
import { formatDate } from '../../app/dateTime';
import { formatMoney } from '../orders/formatting';
import { formatCents, toCents } from '../orders/money';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { amountCents } from './financeModel';
import { budgetOptions, purchasesOptions } from './financeQueries';
import { projectsOptions } from './projectQueries';
import { PurchasePanel } from './PurchasePanel';
import { Tile } from './TaskSummary';
import { PROJECT_STATUS_LABEL } from './projectModel';

type Kind = 'approve' | 'refund' | 'project' | 'wiref';

interface Waiting {
  key: string;
  kind: Kind;
  title: string;
  sub: string;
  groupName: string;
  at: string;
  cents: number;
  purchase?: WorkingGroupPurchase;
  project?: WorkingGroupProject;
}

const SECTION: Record<Kind, string> = {
  approve: 'Purchases to approve',
  refund: 'Refunds to pay',
  project: 'Projects to approve',
  wiref: 'At the WiRef',
};
const ORDER: Kind[] = ['approve', 'refund', 'project', 'wiref'];

/** Working groups → All groups, for management: what waits for you, then a card per group. */
export function ManagementOverview({
  groups,
  onOpenGroup,
}: {
  groups: readonly WorkingGroupSummary[];
  onOpenGroup: (id: string) => void;
}) {
  const currentUser = useCurrentUser();
  const finance = hasPermission(currentUser, PermissionId.working_group_financesmanage);
  const wanted = useQuery({ ...purchasesOptions({ status: 'wanted' }), enabled: finance });
  const bought = useQuery({ ...purchasesOptions({ status: 'bought' }), enabled: finance });
  const submitted = useQuery({ ...projectsOptions({ status: 'submitted' }), enabled: finance });
  const wiref = useQuery({ ...projectsOptions({ status: 'wiref' }), enabled: finance });
  const budget = useQuery({ ...budgetOptions({}), enabled: finance });
  const [focus, setFocus] = useState<Kind | null>(null);
  const panelFits = useListPanelLayout();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const waiting = useMemo<Waiting[]>(() => {
    const result: Waiting[] = [];
    for (const purchase of wanted.data?.items ?? []) {
      result.push({
        key: `approve:${purchase.id}`,
        kind: 'approve',
        title: purchase.item,
        sub: `${purchase.quantity} × · ${purchase.requester?.displayName ?? 'Former member'}${purchase.needsProject ? ' · needs a project' : ''}`,
        groupName: purchase.groupName,
        at: purchase.createdAt,
        cents: amountCents(purchase),
        purchase,
      });
    }
    for (const purchase of (bought.data?.items ?? []).filter((item) => item.how === 'self')) {
      result.push({
        key: `refund:${purchase.id}`,
        kind: 'refund',
        title: purchase.item,
        sub: `${purchase.requester?.displayName ?? 'Former member'} bought it`,
        groupName: purchase.groupName,
        at: purchase.createdAt,
        cents: amountCents(purchase),
        purchase,
      });
    }
    for (const [kind, data] of [
      ['project', submitted.data],
      ['wiref', wiref.data],
    ] as const) {
      for (const project of data?.items ?? []) {
        result.push({
          key: `${kind}:${project.id}`,
          kind,
          title: project.title,
          sub: `${project.requester?.displayName ?? 'Former member'} · ${PROJECT_STATUS_LABEL[project.status]}`,
          groupName: project.groupName,
          at: project.createdAt,
          cents: 0,
          project,
        });
      }
    }
    return result.sort((a, b) => a.at.localeCompare(b.at));
  }, [wanted.data, bought.data, submitted.data, wiref.data]);

  const count = (kind: Kind) => waiting.filter((item) => item.kind === kind).length;
  const shown = waiting.filter((item) => focus === null || item.kind === focus);
  const selected = waiting.find((item) => item.key === selectedKey) ?? null;
  const share = new Map((budget.data?.groups ?? []).map((entry) => [entry.groupId, entry]));

  const panel = selected?.purchase ? (
    <PurchasePanel
      key={selected.key}
      me={currentUser.person.id}
      isLead={false}
      finance={finance}
      purchase={selected.purchase}
      onGone={() => setSelectedKey(null)}
    />
  ) : selected?.project ? (
    <DetailPanel>
      <DetailPanelHead
        title={selected.project.title}
        meta={`Project · ${selected.project.groupName}`}
        helper={
          <Tag size="sm" type="purple">
            {PROJECT_STATUS_LABEL[selected.project.status]}
          </Tag>
        }
      />
      <div className="wg-panel-actions">
        <Button as={Link} to={`/working-groups/projects/${selected.project.id}`} kind="primary" size="md">
          Open project
        </Button>
      </div>
    </DetailPanel>
  ) : (
    <DetailPanel>
      <DetailPanelSection>
        <p className="wg-placeholder__title">Nothing selected</p>
        <p className="wg-muted">Pick a line.</p>
      </DetailPanelSection>
    </DetailPanel>
  );

  return (
    <>
      {finance && (
        <>
          <div className="wg-summary">
            <Tile
              title="Waiting for you"
              count={waiting.length}
              pressed={focus === null}
              onClick={() => setFocus(null)}
              rows={[
                ['Total', formatCents(waiting.reduce((sum, item) => sum + item.cents, 0))],
                ['Oldest since', waiting[0] ? formatDate(waiting[0].at) : '–'],
              ]}
            />
            {ORDER.map((kind) => (
              <Tile
                key={kind}
                title={SECTION[kind]}
                count={count(kind)}
                pressed={focus === kind}
                onClick={() => setFocus(focus === kind ? null : kind)}
                rows={[]}
              />
            ))}
          </div>
          <ListWithPanel panel={panel} panelLabel="Details">
            <div className="wg-card-list">
              {shown.length === 0 ? (
                <p className="wg-empty">Nothing waits for you.</p>
              ) : (
                ORDER.filter((kind) => shown.some((item) => item.kind === kind)).map((kind) => (
                  <section key={kind} aria-labelledby={`wg-mg-${kind}`}>
                    <h3 id={`wg-mg-${kind}`} className="wg-lweek">
                      {SECTION[kind]} <small>{shown.filter((item) => item.kind === kind).length}</small>
                    </h3>
                    <ul className="wg-llist">
                      {shown
                        .filter((item) => item.kind === kind)
                        .map((item) => (
                          <li key={item.key}>
                            <button
                              type="button"
                              className={`wg-lrow wg-prow wg-prow--group${item.key === selectedKey ? ' is-selected' : ''}`}
                              aria-pressed={item.key === selectedKey}
                              onClick={() => setSelectedKey(item.key)}
                            >
                              <span className="wg-pamount">
                                <strong>{item.cents > 0 ? formatCents(item.cents) : '–'}</strong>
                              </span>
                              <span className="wg-lwhat">
                                <span className="wg-lwhat__title">{item.title}</span>
                                <small>{item.sub}</small>
                              </span>
                              <span className="wg-lfrom">{item.groupName}</span>
                              <span className="wg-muted">since {formatDate(item.at)}</span>
                            </button>
                          </li>
                        ))}
                    </ul>
                  </section>
                ))
              )}
            </div>
          </ListWithPanel>
          {!panelFits && selected && (
            <Modal open passiveModal size="md" modalHeading="Details" onRequestClose={() => setSelectedKey(null)}>
              {panel}
            </Modal>
          )}
        </>
      )}
      <h2 className="wg-dbsec">Groups</h2>
      <div className="wg-gcards">
        {groups.map((group) => {
          const entry = share.get(group.id);
          return (
            <CarbonTile key={group.id} className="wg-gcard">
              <div className="wg-gcard__top">
                <Button kind="ghost" size="sm" onClick={() => onOpenGroup(group.id)}>
                  {group.name}
                </Button>
                {finance && entry && <span>{formatMoney(entry.free)} free</span>}
              </div>
              <span>
                {group.memberCount} people · {group.openTicketCount ?? 0} open tickets
              </span>
              {finance && entry && (
                <span className="wg-muted">
                  Share {formatMoney(entry.given)} · used {formatCents(toCents(entry.spent) + toCents(entry.reserved))}
                </span>
              )}
            </CarbonTile>
          );
        })}
      </div>
    </>
  );
}

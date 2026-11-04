import { useState, type MouseEvent, type ReactNode } from 'react';
import { Button, Link as CarbonLink } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { DetectedSpoolTag, FilamentSpool, Material } from '../../../api/generated/models';
import { ListWithPanel, useListPanelLayout } from '../../../app/components/ListWithPanel';
import { RegisterSpoolModal } from '../dialogs/RegisterSpoolModal';
import {
  attentionDirectoryColumn,
  DirectoryTable,
  useUrlState,
  type Column,
  type Option,
} from '../shared/DirectoryTable';
import { machineLogbookPaths } from '../shared/paths';
import { QueryBoundary } from '../shared/QueryBoundary';
import { allSpoolsQuery, filamentMaterialsQuery } from '../spoolData';
import { useSelectedRow } from './articleActions';
import { EmptyPanel } from './ArticlePanel';
import { DetectedSpoolsStrip } from './DetectedSpoolsStrip';
import { ColorSwatch } from './inventoryShared';
import { SpoolDialogs, useSpoolPermissions, type SpoolDialog } from './spoolActions';
import { SpoolPanel } from './SpoolPanel';
import {
  LOW_PERCENT,
  MountLink,
  mountText,
  nfcTagOf,
  remainingOf,
  SpoolRemaining,
  spoolPercent,
  SpoolStateTag,
} from './spoolShared';

const ID = 'spools';
const stateOptions: Option[] = [
  { id: 'mounted', label: 'Mounted' },
  { id: 'storage', label: 'In storage' },
  { id: 'low', label: `Almost empty (< ${LOW_PERCENT} %)` },
];
const matchesState = (spool: FilamentSpool, id: string) =>
  id === 'mounted' ? spool.mounted : id === 'storage' ? !spool.mounted : spoolPercent(spool) < LOW_PERCENT;

type Register = { detected?: DetectedSpoolTag } | null;

function SpoolsTable({
  spools,
  materials,
  switcher,
  onReceive,
}: {
  spools: FilamentSpool[];
  materials: Material[];
  switcher?: ReactNode;
  onReceive?: () => void;
}) {
  const navigate = useNavigate();
  const allowed = useSpoolPermissions();
  const panelFits = useListPanelLayout();
  const [selected, select] = useSelectedRow();
  const [dialog, setDialog] = useState<SpoolDialog | null>(null);
  const [register, setRegister] = useState<Register>(null);
  const url = useUrlState(ID);
  const typeIds = url.list('type');
  const stateIds = url.list('state');
  const machineIds = url.list('machine');
  const materialsById = new Map(materials.map((material) => [material.id, material]));

  const rows = spools.filter(
    (spool) =>
      (typeIds.length === 0 || typeIds.includes(spool.materialTypeName)) &&
      (stateIds.length === 0 || stateIds.some((id) => matchesState(spool, id))) &&
      (machineIds.length === 0 || machineIds.includes(spool.mountedOn?.machineId ?? '')),
  );
  const typeOptions: Option[] = [...new Set(spools.map((spool) => spool.materialTypeName))]
    .sort()
    .map((name) => ({ id: name, label: name }));
  const machineOptions: Option[] = [
    ...new Map(
      spools.flatMap((spool) =>
        spool.mountedOn ? [[spool.mountedOn.machineId, spool.mountedOn.machineName]] : [],
      ) as [string, string][],
    ).entries(),
  ].map(([id, label]) => ({ id, label }));
  const current = selected ? spools.find((spool) => spool.id === selected) : undefined;

  const open = (spool: FilamentSpool) => (panelFits ? select(spool.id) : navigate(machineLogbookPaths.spool(spool.id)));
  const onNameClick = (event: MouseEvent, spool: FilamentSpool) => {
    if (!panelFits || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    select(spool.id);
  };

  const columns: Column<FilamentSpool>[] = [
    {
      key: 'spool',
      header: 'Spool',
      sortValue: (spool) => spool.displayId,
      render: (spool) => (
        <div className="mj-cell-stack">
          <CarbonLink
            as={Link}
            to={machineLogbookPaths.spool(spool.id)}
            className={['inv-mono', spool.id === selected && panelFits ? 'inv-row-selected' : null]
              .filter(Boolean)
              .join(' ')}
            aria-current={spool.id === selected && panelFits ? 'true' : undefined}
            onClick={(event: MouseEvent) => onNameClick(event, spool)}
          >
            {spool.displayId}
          </CarbonLink>
          <span className="mj-secondary mj-show-narrow">
            {[spool.materialName, mountText(spool.mountedOn) ?? spool.storageLocation].filter(Boolean).join(' · ')}
          </span>
        </div>
      ),
    },
    {
      key: 'article',
      header: 'Article',
      narrow: true,
      sortValue: (spool) => spool.materialName,
      render: (spool) => (
        <span className="inv-name">
          <ColorSwatch hex={spool.colorHex} name={spool.colorName} />
          {spool.materialName}
        </span>
      ),
    },
    {
      key: 'remaining',
      header: 'Remaining',
      sortValue: (spool) => remainingOf(spool),
      firstDirection: 'DESC',
      render: (spool) => <SpoolRemaining spool={spool} />,
    },
    {
      key: 'where',
      header: 'Mounted / location',
      narrow: true,
      sortValue: (spool) => mountText(spool.mountedOn) ?? spool.storageLocation ?? '',
      render: (spool) => (spool.mountedOn ? <MountLink mount={spool.mountedOn} /> : spool.storageLocation || '—'),
    },
    {
      key: 'tag',
      header: 'Tag',
      narrow: true,
      render: (spool) =>
        nfcTagOf(spool) ? (
          <span className="inv-mono">{nfcTagOf(spool)}</span>
        ) : (
          <span className="mj-secondary">No tag</span>
        ),
    },
    {
      key: 'state',
      header: 'Status',
      narrow: true,
      sortValue: (spool) => (spool.mounted ? 0 : 1),
      render: (spool) => <SpoolStateTag spool={spool} size="sm" />,
    },
    attentionDirectoryColumn<FilamentSpool>((spool) => spool.attention),
  ];

  return (
    <div className="mj-stack">
      <DetectedSpoolsStrip
        materials={materials}
        onRegister={allowed.move ? (detected) => setRegister({ detected }) : undefined}
      />
      <ListWithPanel
        panelLabel="Spool details"
        panel={
          current ? (
            <SpoolPanel
              spool={current}
              material={materialsById.get(current.materialId)}
              onClose={() => select(null)}
              onAction={setDialog}
            />
          ) : (
            <EmptyPanel text="Select a spool to see where it is, what is left and what it was used for." />
          )
        }
      >
        <DirectoryTable
          id={ID}
          label="Spools"
          columns={columns}
          rows={rows}
          totalCount={spools.length}
          switcher={switcher}
          searchText={(spool) =>
            [
              spool.displayId,
              spool.materialDisplayId,
              spool.materialName,
              spool.materialTypeName,
              spool.manufacturer,
              spool.colorName,
              spool.notes,
              mountText(spool.mountedOn),
              spool.storageLocation,
              spool.acquisitionReference,
              ...spool.identifiers.map((item) => item.value),
            ]
              .filter(Boolean)
              .join(' ')
          }
          defaultSort={{ key: 'spool', direction: 'ASC' }}
          pageSizes={[25, 50, 100]}
          onRowClick={open}
          toolbarAction={
            allowed.move ? (
              <>
                <Button kind="ghost" renderIcon={Add} onClick={() => setRegister({})}>
                  Register spool
                </Button>
                {onReceive && (
                  <Button renderIcon={Add} onClick={onReceive} data-guide="workshop-receive-stock">
                    Receive stock
                  </Button>
                )}
              </>
            ) : undefined
          }
          filterCategories={[
            { key: 'type', label: 'Material', options: typeOptions },
            { key: 'state', label: 'Status', options: stateOptions },
            ...(machineOptions.length > 0 ? [{ key: 'machine', label: 'Printer', options: machineOptions }] : []),
          ]}
          empty={{
            title: 'No spools yet',
            description: 'Receive filament on new spools or register a spool from loose stock to track what is left.',
            action: allowed.move ? (
              <Button kind="tertiary" onClick={() => setRegister({})}>
                Register spool
              </Button>
            ) : undefined,
          }}
        />
      </ListWithPanel>
      {current && (
        <SpoolDialogs spool={current} dialog={dialog} onClose={() => setDialog(null)} onGone={() => select(null)} />
      )}
      {register && (
        <RegisterSpoolModal
          open
          onClose={() => setRegister(null)}
          detected={register.detected}
          onRegistered={(spool) => panelFits && select(spool.id)}
        />
      )}
    </div>
  );
}

/** The Spools tab of the Inventory page: detected tags, active spools and the spool panel. */
export function InventorySpoolsTable({ switcher, onReceive }: { switcher?: ReactNode; onReceive?: () => void }) {
  const query = useQuery(allSpoolsQuery({ lifecycle: 'active' }));
  const materials = useQuery(filamentMaterialsQuery());
  return (
    <QueryBoundary query={query} errorMessage="Spools could not be loaded.">
      {(spools) => (
        <SpoolsTable spools={spools} materials={materials.data ?? []} switcher={switcher} onReceive={onReceive} />
      )}
    </QueryBoundary>
  );
}

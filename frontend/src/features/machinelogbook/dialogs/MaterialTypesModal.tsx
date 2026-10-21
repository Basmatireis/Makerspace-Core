import { useState } from 'react';
import { Button, ContentSwitcher, Link as CarbonLink, Modal, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tag } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { MaterialKind, MaterialType } from '../../../api/generated/models';
import { InlineLoadingState, ErrorState } from '../../../app/PageState';
import { articleKinds, kindNames, typeNoun, typeNounLower, unitLabel } from '../components/inventoryShared';
import { materialTypesQuery } from '../inventoryQueries';
import { processConfig } from '../processConfig';
import { DeleteMaterialTypeModal } from './DeleteMaterialTypeModal';
import { MaterialTypeFormModal } from './MaterialTypeFormModal';

type View = { name: 'list' } | { name: 'form'; type?: MaterialType } | { name: 'delete'; type: MaterialType };

/**
 * Manages material types per kind: material types of filament and consumables, categories of parts. Opened from the
 * Inventory page with the kind of the current tab; the list and the form take turns inside one flow.
 */
export function MaterialTypesModal({ open, onClose, initialKind, canManage }: { open: boolean; onClose: () => void; initialKind: MaterialKind; canManage: boolean }) {
  const [kind, setKind] = useState<MaterialKind>(initialKind);
  const [view, setView] = useState<View>({ name: 'list' });
  const types = useQuery({ ...materialTypesQuery(), enabled: open });
  const rows = (types.data ?? []).filter((item) => item.kind === kind);
  const back = () => setView({ name: 'list' });

  if (view.name === 'form') {
    return <MaterialTypeFormModal open onClose={back} materialType={view.type} kind={kind} onDelete={view.type ? () => setView({ name: 'delete', type: view.type as MaterialType }) : undefined} />;
  }
  if (view.name === 'delete') return <DeleteMaterialTypeModal materialType={view.type} onClose={back} />;

  return (
    <Modal open={open} passiveModal size="lg" modalHeading="Types & categories" onRequestClose={onClose}>
      <div className="mj-stack">
        <ContentSwitcher size="md" selectedIndex={articleKinds.indexOf(kind)} onChange={({ index }) => setKind(articleKinds[index ?? 0])}>
          {articleKinds.map((item) => <Switch key={item} name={item} text={item === 'part' ? 'Part categories' : `${kindNames[item]} types`} />)}
        </ContentSwitcher>
        {types.isError && <ErrorState message="The types could not be loaded." onRetry={() => { void types.refetch(); }} />}
        {types.isPending && <InlineLoadingState label="Loading types" />}
        {types.isSuccess && (
          <Table size="md" aria-label={kind === 'part' ? 'Part categories' : `${kindNames[kind]} types`}>
            <TableHead>
              <TableRow>
                <TableHeader>{typeNoun(kind) === 'Category' ? 'Category' : 'Material type'}</TableHeader>
                <TableHeader>Unit</TableHeader>
                {kind !== 'part' && <TableHeader>Processes</TableHeader>}
                <TableHeader>Articles</TableHeader>
                <TableHeader>Price rules</TableHeader>
                <TableHeader>Status</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.length === 0 && <TableRow><TableCell colSpan={kind === 'part' ? 5 : 6}>{`No ${kind === 'part' ? 'categories' : 'material types'} yet.`}</TableCell></TableRow>}
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{canManage ? <CarbonLink as="button" type="button" className="mj-link-button" onClick={() => setView({ name: 'form', type: row })}>{row.name}</CarbonLink> : row.name}</TableCell>
                  <TableCell>{unitLabel(row.unit)}</TableCell>
                  {kind !== 'part' && <TableCell>{row.processes.map((process) => processConfig[process].label).join(', ')}</TableCell>}
                  <TableCell>{row.materialCount}</TableCell>
                  <TableCell>{row.pricingRuleCount}</TableCell>
                  <TableCell>{row.active ? <Tag type="green" size="sm">Active</Tag> : <Tag type="gray" size="sm">Inactive</Tag>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {canManage && <div><Button kind="tertiary" size="md" onClick={() => setView({ name: 'form' })}>{`Add ${typeNounLower(kind)}`}</Button></div>}
      </div>
    </Modal>
  );
}

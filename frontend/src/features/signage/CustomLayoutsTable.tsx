import { useState } from 'react';
import {
  Button,
  Link as CarbonLink,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { Edit, TrashCan, View } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import type { SignageCustomLayout } from '../../api/generated/models';
import { deleteSignageCustomLayout } from '../../api/generated/signage/signage';
import { EmptyState } from '../../app/PageState';
import { RowActions } from '../../app/RowActions';
import { DeleteDialog } from './components';
import { pluralize } from './helpers';
import { LayoutDiagram } from './LayoutDiagram';
import { resolveLayout } from './layouts';
import { signagePaths } from './paths';

/** The custom layouts section of the Content page. Write controls only appear with `signage.content.manage`. */
export function CustomLayoutsTable({
  layouts,
  canEdit,
  create,
}: {
  layouts: readonly SignageCustomLayout[];
  canEdit: boolean;
  create?: React.ReactNode;
}) {
  const [deleting, setDeleting] = useState<SignageCustomLayout | null>(null);
  if (layouts.length === 0)
    return (
      <EmptyState
        title="No custom layouts yet"
        description="A custom layout splits the screen into zones of your own: a grid with weighted rows and columns, or free rectangles."
        action={create}
      />
    );
  return (
    <>
      <TableContainer>
        <Table aria-label="Custom layouts">
          <TableHead>
            <TableRow>
              <TableHeader>Layout</TableHeader>
              <TableHeader>Name</TableHeader>
              <TableHeader>Mode</TableHeader>
              <TableHeader>Zones</TableHeader>
              <TableHeader>Scenes</TableHeader>
              <TableHeader>
                <span className="cds--visually-hidden">Actions</span>
              </TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {layouts.map((layout) => (
              <TableRow key={layout.id}>
                <TableCell>
                  <div className="sg-layout-thumb">
                    <LayoutDiagram layout={resolveLayout('custom', layout.id, layouts)} orientation="landscape" />
                  </div>
                </TableCell>
                <TableCell>
                  <CarbonLink as={Link} to={signagePaths.layout(layout.id)}>
                    {layout.name}
                  </CarbonLink>
                </TableCell>
                <TableCell>
                  <Tag size="sm" type="cool-gray">
                    {layout.mode === 'grid' ? 'Grid' : 'Free'}
                  </Tag>
                </TableCell>
                <TableCell>{layout.zones.length}</TableCell>
                <TableCell>
                  {layout.sceneCount === 0 ? (
                    <span className="sg-secondary">Not in use</span>
                  ) : (
                    pluralize(layout.sceneCount, 'scene')
                  )}
                </TableCell>
                <TableCell>
                  <RowActions label={`Actions for ${layout.name}`}>
                    <Button
                      kind="ghost"
                      size="sm"
                      renderIcon={canEdit ? Edit : View}
                      as={Link}
                      to={signagePaths.layout(layout.id)}
                    >
                      {canEdit ? 'Edit' : 'View'}
                    </Button>
                    {canEdit && (
                      <Button kind="danger--ghost" size="sm" renderIcon={TrashCan} onClick={() => setDeleting(layout)}>
                        Delete
                      </Button>
                    )}
                  </RowActions>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {deleting && (
        <DeleteDialog
          title={`Delete “${deleting.name}”?`}
          noun="Layout"
          confirmLabel="Delete layout"
          remove={() => deleteSignageCustomLayout(deleting.id, { expectedVersion: deleting.version })}
          onDeleted={() => setDeleting(null)}
          onClose={() => setDeleting(null)}
        >
          <p>
            The layout is removed for good. A layout that scenes still use cannot be deleted. This cannot be undone.
          </p>
        </DeleteDialog>
      )}
    </>
  );
}

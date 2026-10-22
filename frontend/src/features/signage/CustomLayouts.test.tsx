import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { freeLayoutFixture, gridLayoutFixture, layoutIds, mockCustomLayouts } from './layoutFixtures';
import { ids, mockSignage, sceneFixture } from './testFixtures';

const writer = [PermissionId.signageread, PermissionId.signagecontentmanage];
const list = '/signage/content?section=layouts';

describe('Custom layouts', () => {
  it('lists layouts read-only with signage.read: no create, edit form or delete', async () => {
    mockSignage([PermissionId.signageread]);
    mockCustomLayouts([gridLayoutFixture({ sceneCount: 2 }), freeLayoutFixture()]);
    renderRoute(<App />, list);
    const table = await screen.findByRole('table', { name: 'Custom layouts' });
    expect(within(table).getByRole('link', { name: 'Poster with side' })).toHaveAttribute(
      'href',
      `/signage/layouts/${layoutIds.grid}`,
    );
    expect(within(table).getByText('2 scenes')).toBeInTheDocument();
    expect(within(table).getByText('Free')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New layout' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    await userEvent.setup().click(within(table).getByRole('link', { name: 'Poster with side' }));
    expect(await screen.findByText('Read only')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save layout' })).not.toBeInTheDocument();
  });

  it('does not open the new layout page without signage.content.manage', async () => {
    mockSignage([PermissionId.signageread]);
    mockCustomLayouts([]);
    renderRoute(<App />, '/signage/layouts/new');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Create layout' })).not.toBeInTheDocument());
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('explains which scenes block deleting a layout', async () => {
    mockSignage(writer);
    mockCustomLayouts([gridLayoutFixture({ sceneCount: 1 })]);
    server.use(
      http.delete('*/api/v1/signage/custom-layouts/:id', () =>
        HttpResponse.json(
          {
            code: 'signage_in_use',
            message: 'In use',
            details: { references: [{ kind: 'scene', id: ids.scene, name: 'Open days poster' }] },
          },
          { status: 409 },
        ),
      ),
    );
    renderRoute(<App />, list);
    const user = userEvent.setup();
    await user.click(
      within(await screen.findByRole('group', { name: 'Actions for Poster with side' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Delete layout' }));
    expect(await screen.findByText('Layout is still in use')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open days poster' })).toHaveAttribute(
      'href',
      `/signage/scenes/${ids.scene}`,
    );
  });

  it('creates a grid layout from track counts and a zone added by cell numbers', async () => {
    mockSignage(writer);
    mockCustomLayouts([]);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/signage/custom-layouts', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(gridLayoutFixture(), { status: 201 });
      }),
    );
    renderRoute(<App />, '/signage/layouts/new');
    const user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: '  Three columns ' } });
    fireEvent.change(screen.getByLabelText('Columns'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Rows'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Column 3 weight'), { target: { value: '2' } });
    // The default Left and Right zones cover row 1; the new one takes the free row.
    fireEvent.change(screen.getByLabelText('Last column'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('First row'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Last row'), { target: { value: '2' } });
    await user.click(screen.getByRole('button', { name: 'Add zone' }));
    fireEvent.change(await screen.findByLabelText('Zone label'), { target: { value: 'Footer' } });
    await user.click(screen.getByRole('button', { name: 'Create layout' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({
      name: 'Three columns',
      mode: 'grid',
      columns: [1, 1, 2],
      rows: [1, 1],
      zones: [
        { id: 'z1', label: 'Left', grid: { col: 1, row: 1, colSpan: 1, rowSpan: 1 }, rect: null },
        { id: 'z2', label: 'Right', grid: { col: 2, row: 1, colSpan: 1, rowSpan: 1 }, rect: null },
        { id: 'z3', label: 'Footer', grid: { col: 1, row: 2, colSpan: 3, rowSpan: 1 }, rect: null },
      ],
    });
  });

  it('refuses a zone that overlaps another in the grid', async () => {
    mockSignage(writer);
    mockCustomLayouts([]);
    renderRoute(<App />, '/signage/layouts/new');
    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
    // First column, first row is the Left zone already.
    expect(screen.getByText('Overlaps Left.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add zone' })).toBeDisabled();
  });

  it('creates a free layout with numeric positions, keeping zone ids stable', async () => {
    mockSignage(writer);
    mockCustomLayouts([]);
    let body: { mode?: string; zones?: { id: string; label: string; rect: unknown }[] } | undefined;
    server.use(
      http.post('*/api/v1/signage/custom-layouts', async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json(freeLayoutFixture(), { status: 201 });
      }),
    );
    renderRoute(<App />, '/signage/layouts/new');
    const user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Free form' } });
    await user.click(screen.getByLabelText('Free (rectangles)'));
    // The two grid zones became rectangles; select the second and move it.
    await user.click(await screen.findByRole('button', { name: 'Zone Right' }));
    fireEvent.change(screen.getByLabelText('Width (%)'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Left (%)'), { target: { value: '60.25' } });
    await user.click(screen.getByRole('button', { name: 'Add zone' }));
    expect(screen.getByLabelText('Zone label')).toHaveValue('Zone 3');
    await user.click(screen.getByRole('button', { name: 'Delete zone' }));
    await user.click(screen.getByRole('button', { name: 'Create layout' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body?.mode).toBe('free');
    expect(body?.zones).toEqual([
      { id: 'z1', label: 'Left', grid: null, rect: { x: 0, y: 0, width: 50, height: 100 } },
      { id: 'z2', label: 'Right', grid: null, rect: { x: 60.25, y: 0, width: 30, height: 100 } },
    ]);
  });

  it('asks before converting a free layout to a grid and names the zones it cannot keep', async () => {
    mockSignage(writer);
    mockCustomLayouts([
      freeLayoutFixture({
        zones: [
          { id: 'z1', label: 'Back', grid: null, rect: { x: 0, y: 0, width: 100, height: 100 } },
          { id: 'z2', label: 'Front', grid: null, rect: { x: 0, y: 0, width: 50, height: 50 } },
        ],
      }),
    ]);
    renderRoute(<App />, `/signage/layouts/${layoutIds.free}`);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Grid (rows and columns)'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('1 zone will be removed')).toBeInTheDocument();
    expect(within(dialog).getByText(/Front would overlap/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Convert to grid' }));
    expect(await screen.findByRole('button', { name: 'Column 1, row 1, Back' })).toBeInTheDocument();
  });

  it('lists the scenes that lose widgets before removed zones are saved', async () => {
    mockSignage(writer, {
      scenes: [
        sceneFixture({
          id: ids.scene,
          name: 'Open days poster',
          layoutId: 'custom',
          customLayoutId: layoutIds.grid,
          zones: { z1: { type: 'clock', mode: 'time' }, z2: { type: 'empty' }, z3: { type: 'clock', mode: 'time' } },
        }),
        sceneFixture({
          id: ids.scene2,
          name: 'Only the poster',
          layoutId: 'custom',
          customLayoutId: layoutIds.grid,
          zones: { z1: { type: 'clock', mode: 'time' }, z2: { type: 'empty' }, z3: { type: 'empty' } },
        }),
      ],
    });
    mockCustomLayouts([gridLayoutFixture({ sceneCount: 2 })]);
    let body: { expectedVersion?: number; zones?: unknown[] } | undefined;
    server.use(
      http.put('*/api/v1/signage/custom-layouts/:id', async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json(gridLayoutFixture({ version: 3 }));
      }),
    );
    renderRoute(<App />, `/signage/layouts/${layoutIds.grid}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Column 2, row 2, Bottom side' }));
    await user.click(screen.getByRole('button', { name: 'Delete zone' }));
    await user.click(screen.getByRole('button', { name: 'Save layout' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Open days poster')).toBeInTheDocument();
    expect(within(dialog).getByText(/loses the widget in Bottom side/)).toBeInTheDocument();
    // A scene whose removed zone is empty is not affected.
    expect(within(dialog).queryByText('Only the poster')).not.toBeInTheDocument();
    expect(body).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Save and drop widgets' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body?.expectedVersion).toBe(2);
    expect(body?.zones).toHaveLength(2);
  });

  it('saves removed zones without a warning when no scene uses the layout', async () => {
    mockSignage(writer);
    mockCustomLayouts([gridLayoutFixture({ sceneCount: 0 })]);
    let saved = false;
    server.use(
      http.put('*/api/v1/signage/custom-layouts/:id', () => {
        saved = true;
        return HttpResponse.json(gridLayoutFixture({ version: 3 }));
      }),
    );
    renderRoute(<App />, `/signage/layouts/${layoutIds.grid}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Column 2, row 2, Bottom side' }));
    await user.click(screen.getByRole('button', { name: 'Delete zone' }));
    await user.click(screen.getByRole('button', { name: 'Save layout' }));
    await waitFor(() => expect(saved).toBe(true));
    expect(screen.queryByText('Remove zones from scenes?')).not.toBeInTheDocument();
  });

  it('offers the latest version after a stale write', async () => {
    mockSignage(writer);
    mockCustomLayouts([gridLayoutFixture()]);
    server.use(
      http.put('*/api/v1/signage/custom-layouts/:id', () =>
        HttpResponse.json({ code: 'stale_write', message: 'Stale' }, { status: 409 }),
      ),
    );
    renderRoute(<App />, `/signage/layouts/${layoutIds.grid}`);
    const user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed' } });
    await user.click(screen.getByRole('button', { name: 'Save layout' }));
    expect(await screen.findByText(/Somebody else changed this layout/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load latest version' })).toBeInTheDocument();
  });
});

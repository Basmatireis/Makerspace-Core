import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../../test/render';
import { recordedRun, usage } from '../../../test/machineRuns';
import { MaterialUsageTable } from './MaterialUsageTable';

vi.mock('../../auth/auth', () => ({
  useCurrentUser: () => ({
    permissions: ['machine_jobs.read'],
    person: { id: '0192f6f8-743e-7c77-a349-cd07c3e8ffff' },
  }),
}));

const reportedLine = {
  lineNumber: 0,
  reportRevision: 1,
  slicerFilamentId: '1',
  plannedQuantityGrams: '5.62',
  estimatedQuantityGrams: '5.62',
  method: 'slicer_complete',
  calculationVersion: 'bambu-3mf-v1',
  quality: 'unresolved' as const,
  segments: [],
};

describe('material usage table', () => {
  it('lists booked usage and unmapped report lines of a job and maps a line without opening the run', async () => {
    const booked = recordedRun({ usages: [usage({ spoolDisplayId: 'S-617', materialName: 'PLA White' })] });
    const unmapped = recordedRun({
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a999',
      displayId: 'R-2026-000009',
      usages: [],
      reportedUsageItems: [reportedLine],
    });
    const onMap = vi.fn();
    const user = userEvent.setup();
    renderRoute(<MaterialUsageTable runs={[booked, unmapped]} showRun description="All runs" onMap={onMap} />);

    const table = screen.getByRole('table', { name: 'Material usage' });
    expect(within(table).getByText('PLA White')).toBeInTheDocument();
    expect(within(table).getByText(/^Spool S-617/)).toBeInTheDocument();
    const row = within(table).getByText('Filament 1').closest('tr') as HTMLElement;
    expect(within(row).getByText('Not mapped')).toBeInTheDocument();
    expect(within(row).getByText('5.62 g')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'R-2026-000009' })).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Map Filament 1 of R-2026-000009' }));
    expect(onMap).toHaveBeenCalledWith(unmapped, reportedLine);
  });

  it('lists only the parts of a line fed by several spools that nothing booked, and maps them', async () => {
    // The H2D case: the recipient's spool ran out, and the part after layer 42 came from a spool Core does not know.
    const segment = (index: number, grams: string, extra: object) => ({
      index,
      inputUnitExternalId: '0',
      slotExternalId: String(index),
      startedAt: '2026-11-05T05:03:00Z',
      startLayer: index === 0 ? null : 42,
      estimatedQuantityGrams: grams,
      split: 'gcode_layer' as const,
      spoolId: null,
      materialId: null,
      customerFilament: false,
      ...extra,
    });
    const line = {
      ...reportedLine,
      estimatedQuantityGrams: '11.38',
      quality: 'medium' as const,
      segments: [segment(0, '5.62', { customerFilament: true }), segment(1, '5.76', {}), segment(2, '0', {})],
    };
    const run = recordedRun({
      usages: [usage({ ownership: 'external', quantity: '5.620', materialName: 'PLA White' })],
      reportedUsageItems: [line],
    });
    const onMapSegment = vi.fn();
    const user = userEvent.setup();
    const { unmount } = renderRoute(
      <MaterialUsageTable runs={[run]} showRun={false} description="This run" onMapSegment={onMapSegment} />,
    );
    // The recipient's part is booked and the empty part fed nothing: only the unknown spool's part is open.
    expect(screen.queryByText('Filament 1 part 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Filament 1 part 3')).not.toBeInTheDocument();
    const row = screen.getByText('Filament 1 part 2').closest('tr') as HTMLElement;
    expect(within(row).getByText('No spool')).toBeInTheDocument();
    expect(within(row).getByText('5.76 g')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Map Filament 1 part 2' }));
    expect(onMapSegment).toHaveBeenCalledWith(run, line, line.segments[1]);
    unmount();

    // Once staff corrected the run's usage by hand, that usage stands for the whole run.
    const corrected = recordedRun({
      usages: [usage({ ownership: 'external', quantity: '11.380', materialName: 'PLA White', staffCorrected: true })],
      reportedUsageItems: [line],
    });
    renderRoute(<MaterialUsageTable runs={[corrected]} showRun={false} description="This run" />);
    expect(screen.queryByText(/Filament 1 part/)).not.toBeInTheDocument();
  });

  it('offers no mapping without the right to edit', () => {
    renderRoute(
      <MaterialUsageTable
        runs={[recordedRun({ usages: [], reportedUsageItems: [reportedLine] })]}
        showRun={false}
        description="This run"
      />,
    );
    expect(screen.getByText('Not mapped')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Map/ })).not.toBeInTheDocument();
  });
});

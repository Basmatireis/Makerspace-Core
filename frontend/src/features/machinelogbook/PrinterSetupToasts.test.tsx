import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { PrinterLiveStatusUnit } from '../../api/generated/models';
import { server } from '../../test/server';
import { testQueryClient } from '../../test/render';
import { PrinterSetup } from './components/PrinterSetup';
import { liveStatusKey } from './connectorQueries';
import { h2dUnits, liveStatusOf, printer, printerId, templateProfile, tray } from './printerTestData';
import { ToastProvider } from './shared/toasts';

vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: [] }) }));

const withTray = (units: PrinterLiveStatusUnit[], unitId: string, replacement: ReturnType<typeof tray>) =>
  units.map((unit) =>
    unit.externalId === unitId
      ? { ...unit, trays: unit.trays.map((item) => (item.externalId === replacement.externalId ? replacement : item)) }
      : unit,
  );

describe('Filament change toasts on the printer setup', () => {
  it('stays quiet on the first snapshot and reports tray changes between consecutive snapshots', async () => {
    let snapshot = liveStatusOf({ units: h2dUnits });
    server.use(http.get(`*/api/v1/machines/${printerId}/printer/live-status`, () => HttpResponse.json(snapshot)));
    const profile = templateProfile();
    // A spool is mounted in the first AMS slot; the second one has none.
    profile.slots = profile.slots.map((slot) => (slot.id === 'slot-ams-2' ? { ...slot, spoolId: 'spool-1' } : slot));
    const queryClient = testQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ToastProvider>
            <PrinterSetup machine={printer} profile={profile} connection={undefined} />
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(queryClient.getQueryData(liveStatusKey(printerId))).toBeTruthy());
    await waitFor(() =>
      expect(screen.queryByText(/Loading|Checking what the printer reports/)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/spool removed|loaded|new material|without RFID/)).not.toBeInTheDocument();

    let units = withTray(h2dUnits, '0', tray('0')); // removed
    units = withTray(
      units,
      '0',
      tray('2', {
        materialType: 'PLA',
        subBrand: 'PLA Matte',
        colorHex: '112233',
        rfid: true,
        tagUid: 'AA',
        empty: false,
      }),
    ); // mounted spool in the slot: loaded
    units = withTray(
      units,
      '0',
      tray('3', { materialType: 'ABS', subBrand: null, colorHex: '445566', rfid: true, tagUid: 'BB', empty: false }),
    ); // tag without a mounted spool in the slot
    units = withTray(
      units,
      '255',
      tray('255', { materialType: 'PA', subBrand: null, colorHex: '778899', rfid: false, empty: false }),
    ); // no tag
    snapshot = liveStatusOf({ units });
    await queryClient.invalidateQueries({ queryKey: liveStatusKey(printerId) });

    expect(await screen.findByText('Slot AMS 2 Pro · 0: spool removed')).toBeInTheDocument();
    expect(await screen.findByText('Slot AMS 2 Pro · 2: PLA Matte loaded')).toBeInTheDocument();
    expect(await screen.findByText('Slot AMS 2 Pro · 3: new material (ABS) without a known spool')).toBeInTheDocument();
    expect(
      await screen.findByText('Slot External spool L · 255: material without RFID tag — assign a spool by hand'),
    ).toBeInTheDocument();
    // The unchanged tray 1 produces nothing.
    expect(screen.queryByText(/AMS 2 Pro · 1:/)).not.toBeInTheDocument();
  });
});

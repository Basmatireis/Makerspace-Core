import { Button, Select, SelectItem, Stack, Toggle } from '@carbon/react';
import { Bullhorn, Reset, StopOutline } from '@carbon/icons-react';
import { useSignage } from '../SignageContext';
import type { MachineSim } from '../types';

const STATES: { id: MachineSim; label: string }[] = [{ id: 'idle', label: 'Idle' }, { id: 'printing', label: 'Printing' }, { id: 'camera_unavailable', label: 'Camera unavailable' }];

/** The "Signage simulation" group of the prototype controls panel. */
export function SignageSimulationControls() {
  const { sim, setSim, resetSignage, startSampleClosed, stopAllAnnouncements } = useSignage();
  return (
    <Stack gap={5}>
      <p className="prototype-controls__title">Signage simulation</p>
      <Select id="sim-h2d" labelText="H2D" value={sim.h2d} onChange={(event) => setSim({ h2d: event.target.value as MachineSim })}>
        {STATES.map((item) => <SelectItem key={item.id} value={item.id} text={item.label} />)}
      </Select>
      <Select id="sim-x1c" labelText="X1C" value={sim.x1c} onChange={(event) => setSim({ x1c: event.target.value as MachineSim })}>
        {STATES.map((item) => <SelectItem key={item.id} value={item.id} text={item.label} />)}
      </Select>
      <Toggle id="sim-core" size="sm" labelText="Core reachable" labelA="No" labelB="Yes" toggled={sim.coreReachable} onToggle={(coreReachable) => setSim({ coreReachable })} />
      <Button kind="tertiary" size="sm" renderIcon={Bullhorn} onClick={startSampleClosed}>Start sample “Closed” announcement</Button>
      <Button kind="ghost" size="sm" renderIcon={StopOutline} onClick={stopAllAnnouncements}>Stop all announcements</Button>
      <Button kind="ghost" size="sm" renderIcon={Reset} onClick={resetSignage}>Reset signage data</Button>
    </Stack>
  );
}

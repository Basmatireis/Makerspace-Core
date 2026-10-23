import { Tile } from '@carbon/react';

export function StatTile({ value, label, alert = false }: { value: number | string; label: string; alert?: boolean }) {
  return (
    <Tile className={`attendance-stat${alert ? ' is-alert' : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </Tile>
  );
}

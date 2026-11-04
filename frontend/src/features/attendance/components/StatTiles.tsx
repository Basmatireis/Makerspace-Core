import { Tile } from '@carbon/react';

export function StatTile({ value, label }: { value: number | string; label: string }) {
  return (
    <Tile className="attendance-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </Tile>
  );
}

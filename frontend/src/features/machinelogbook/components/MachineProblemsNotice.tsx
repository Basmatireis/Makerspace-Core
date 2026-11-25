import { useId } from 'react';
import { Callout } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { MachineAttentionCode } from '../../../api/generated/models';
import { useCurrentUser } from '../../auth/auth';
import { hasPermission } from '../../auth/permissions';
import { machinesQuery } from '../queries';
import { machineLogbookPaths } from '../shared/paths';

/** Attention codes that mean recorded prints lose their files, timelapses or status. */
const connectorProblemCodes: MachineAttentionCode[] = [
  'printer_storage_unavailable',
  'connector_offline',
  'connector_error',
];

/**
 * Warns above the Workshop's jobs when a printer connector has a problem, so missing print files and timelapses are
 * noticed while they can still be fetched. Shown only to people who may read machines.
 */
export function MachineProblemsNotice() {
  const titleId = useId();
  const user = useCurrentUser();
  const allowed = hasPermission(user, 'machines.read');
  const machines = useQuery({ ...machinesQuery({ pageSize: 100 }), enabled: allowed });
  if (!allowed) return null;
  const problems = (machines.data?.items ?? []).flatMap((machine) =>
    machine.attention.filter((item) => connectorProblemCodes.includes(item.code)).map((item) => ({ machine, item })),
  );
  if (problems.length === 0) return null;
  return (
    <Callout
      kind="warning"
      lowContrast
      className="mj-machine-problems"
      titleId={titleId}
      title={problems.length === 1 ? 'A printer needs attention' : 'Printers need attention'}
    >
      <ul>
        {problems.map(({ machine, item }) => (
          <li key={`${machine.id}-${item.code}`}>
            <Link to={machineLogbookPaths.machine(machine.id)} aria-describedby={titleId}>
              {machine.name}
            </Link>
            : {item.message}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

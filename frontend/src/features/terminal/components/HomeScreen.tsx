import { Button } from '@carbon/react';
import { Login, Logout, UserAdmin } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import { TerminalHardwareStatus } from '../DeviceBridgePanel';

export function HomeScreen({
  staffDestination,
  onCheckIn,
  onCheckOut,
}: {
  staffDestination: string;
  onCheckIn: () => void;
  onCheckOut: () => void;
}) {
  return (
    <div className="tablet-home">
      <div>
        <h1 className="tablet-home__title">Welcome to the Makerspace</h1>
        <p className="tablet-home__lead">Check in when you arrive and check out before you leave.</p>
      </div>

      <div className="tablet-home__actions">
        <Button className="tablet-action" size="2xl" renderIcon={Login} onClick={onCheckIn}>
          Check in
        </Button>
        <Button className="tablet-action" kind="secondary" size="2xl" renderIcon={Logout} onClick={onCheckOut}>
          Check out
        </Button>
      </div>

      <TerminalHardwareStatus />

      <div className="tablet-home__footer">
        <Button
          as={Link}
          to={`/${staffDestination}`}
          state={{ origin: 'terminal' }}
          kind="ghost"
          size="lg"
          renderIcon={UserAdmin}
        >
          Staff sign in
        </Button>
      </div>
    </div>
  );
}

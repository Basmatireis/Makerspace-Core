# Navigation

## Current tree

Dashboard; Open Days; Events; Attendance; Machines (Overview, Jobs, Review, Inventory, Print submissions, Machines, Statistics); Directory (people or staffing fallback); Orders; Payments; External invoicing; Administration (Settings, Audit Log); About/Imprint/Privacy policy.

## Approved tree

- Dashboard
- Operations: Open Days, Events, Attendance
- Directory (group): People (`/people`), Organizations (`/organizations`), Staffing
- Machines & inventory: Overview, Machines, Jobs, Review, Print submissions, Inventory, Statistics
- Sales & payments: Orders, Payments, External invoicing
- Administration: Settings, Audit Log
- Persistent secondary links: About, Imprint, Privacy policy

The four feature groups use one Carbon SideNavMenu level. No empty groups; controlled expansion opens the active group on client navigation. Phone navigation closes after selection with appropriate focus. Preserve external legal links and configured branding. Settings children remain on their landing page; spools remain reachable from Inventory, management from Open Days.

## Permission mapping

Open Days: open_days.read OR manage. Events: events.read OR manage OR staffing.manage OR assign. Attendance: attendance.read OR assist OR statistics.read. Directory: existing people directory predicate; Staffing: existing supervisor staffing permissions (inspect App.tsx/current predicates). Staffing-only user gets Staffing, not an inaccessible directory link. Machine Overview: machine_jobs.read OR statistics.read; Machines: machines.read; Jobs: machine_jobs.read; Inventory: inventory.read; Statistics: statistics.read. Orders/payments/external invoicing retain their read grants. Organizations: organizations.read. Settings keeps existing predicates plus pricing.read access to machine configuration; organizations moved from Settings to the Directory group. Audit retains existing audit grant. Backend enforcement is unchanged.

Validate route and menu agreement, descendants, back/forward, active expansion after navigation, resize, mobile overlay/keyboard/focus and every permission combination. No new role-name checks.

# Authorization

Authorization is based on application-registered permission identifiers. Backend services enforce permissions and resource scope; UI checks exist only to present an understandable interface.

## Registered permissions

| Permission | Capability |
| --- | --- |
| `people.read.self` | Read the Person linked to the current Account. |
| `people.read.all` | List and read every Person. |
| `people.create` | Create a Person. |
| `people.update.self` | Update ordinary fields on the linked Person. |
| `people.update.all` | Update ordinary fields on any Person. |
| `people.delete` | Hard-delete a Person; an attached Account also requires `accounts.delete`. |
| `people.read.matriculation` | Receive matriculation numbers in authorized Person responses. |
| `people.update.matriculation` | Set or clear a matriculation number in an otherwise authorized create/update operation. |
| `accounts.read` | Read account status, login identity, and role assignments in administration APIs. |
| `accounts.create` | Create an Account for an existing Person. |
| `accounts.delete` | Hard-delete an Account and its authentication data. |
| `accounts.enable` | Enable an Account with an active password credential. |
| `accounts.disable` | Disable an Account and revoke its sessions. |
| `accounts.login_email.update` | Change an account login email independently of Person contact email. |
| `accounts.password.set` | Directly set another account's password. |
| `accounts.password.reset` | Issue a one-time reset link for another account. |
| `accounts.roles.assign` | Assign or remove allowed Roles from Accounts. |
| `roles.read` | List registered permissions and read configured Roles. |
| `roles.manage` | Create, edit, delete, and replace permissions on configurable Roles. |
| `audit.read` | Read privacy-minimized audit events. |

The registry in application code is authoritative. Database RolePermission rows may reference only identifiers in this registry; unknown values from stale data or client requests never become effective. Additions require coordinated backend registry, OpenAPI enum, documentation, and authorization tests.

## Resource and field scope

`people.read.self` and `people.update.self` apply only when the requested Person ID equals the authenticated principal's linked Person ID. Their `*.all` counterparts apply to any Person. `GET /people` is an administrative listing and requires `people.read.all`; a self-only caller reads their record through `/auth/me` or `GET /people/{personId}`.

Matriculation access is an additional field gate, not a substitute for record access. Without `people.read.matriculation`, the backend omits `matriculationNumber` entirely even if the caller has `people.read.all`. `null` is reserved for an authorized response with no stored value. Sending the field requires `people.update.matriculation` in addition to the applicable create/update permission.

Account data nested in Person responses is omitted without `accounts.read`. `/auth/me` inherently returns the current principal's Account, minimal Person identity, and sorted effective permissions. Contact fields require the applicable self/all Person-read permission, and matriculation still requires its dedicated read permission.

## Dynamic roles and privilege boundaries

Operators may create arbitrary business Roles and assign registered permissions. Business logic never checks names such as “admin” or “supervisor.” A non-master actor with `roles.manage` may create or update only a permission set that is a subset of their own effective permissions. A non-master actor with `accounts.roles.assign` may assign only Roles whose effective permissions are a subset of their own. These checks prevent privilege escalation through indirection.

Deleting a configurable Role removes its account assignments and permission rows in the same transaction. Role/account writes use `expectedVersion`; concurrent changes return HTTP 409 with `stale_write` rather than silently overwriting a newer policy.

## Master system role

`master` is the only system Role. Its stable system key, rather than its display name, drives the special behavior:

- it always has every permission currently registered in application code;
- it automatically receives permissions introduced by later versions;
- it cannot be renamed, deleted, or have its permission rows edited;
- only an existing master may assign or remove the master Role;
- disabling/deleting an Account or removing a Role may not leave zero enabled master Accounts.

Bootstrap and recovery are deliberate local administrative CLI operations, never HTTP endpoints. The last-enabled-master invariant is enforced transactionally with database locking so concurrent requests cannot both pass an earlier count.

## Enforcement and failures

Handlers parse authenticated identity and transport input, but services make the final permission decision inside the business operation. Missing permission returns HTTP 403 with the standard error envelope. Not-found behavior may conceal resource existence where disclosure would be unsafe. Account status, current Roles, and master semantics are loaded from PostgreSQL for each authenticated request, making revocation effective immediately at this system's small expected scale.

Every authorization-sensitive mutation and security-relevant denial path has focused tests. Important successful mutations write a privacy-minimized AuditEvent atomically with their domain changes.

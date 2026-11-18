# Working groups

A working group is a team of members that looks after machines and places of the makerspace. Each group has:

- a **name** (1–80 characters, unique ignoring case) and a **description** of what the group looks after (up to 500 characters),
- an optional **chat link** (an `https://` URL) to the group's chat, shown only to members of the group and to people who manage working groups,
- exactly one **lead**, who is always a member,
- **members**; a person may belong to several groups,
- the **machines** it looks after; a machine belongs to at most one group,
- **places**: free-text names without a machine, such as "Soldering corner".

## Who may do what

| Operation                                                      | `working_groups.read` only | Lead of the group | `working_groups.manage` |
| -------------------------------------------------------------- | -------------------------- | ----------------- | ----------------------- |
| See groups, leads, member names, machines and places           | yes                        | yes               | yes                     |
| See the chat link                                              | only as a member           | yes (is a member) | yes                     |
| Edit description and chat link                                 | no                         | own group         | any group               |
| Add and remove members, set machines, add and remove places    | no                         | own group         | any group               |
| Create, rename and delete a group, choose the lead             | no                         | no                | yes                     |

Being the lead is data scope, not a permission: it only counts for people who also hold `working_groups.read`. The system grants `working_groups.read` to every role except master and the Visitor membership role (migration 00148); `working_groups.manage` is granted to no role, the master role holds every registered permission. Every operation answers 403 without `working_groups.read`, and an unknown group answers 404.

## Rules

- The lead cannot be removed as a member (409 `working_group_lead_required`); choose another lead first. The previous lead stays a normal member.
- Adding a person who is already a member answers 409 `working_group_member_exists`.
- Assigning a machine that belongs to another group answers 409 `machine_in_other_working_group`; `details.machineId` names it. Setting the machines replaces the whole set.
- Group names and place names (per group) are unique ignoring case (409 `working_group_exists`, `working_group_place_exists`).
- Name, description and chat link are changed with optimistic locking (`expectedVersion`; a stale write answers 409 `stale_write`).
- Deleting a group removes its memberships, machine assignments and places.
- Every change and its audit event commit in one transaction. Audit events name the group and the changed fields, never the chat link or place names.
- People with the Visitor membership role cannot be members or leads (422 `person_not_eligible`) and do not appear in the member picker.
- The names of a group's machines are shown to everyone with `working_groups.read`, also without a machine permission. This is intended: the group page says what the group looks after.
- The chat link is an invite link of an external chat. Removing a member does not take it back from them; rotate the link at the chat provider and save the new one.
- Description and place names are visible to every reader. Do not put personal data in them.

## In the app

- **Working groups → Overview** (`/working-groups`, side navigation, needs `working_groups.read`): one tab per group, the groups of the signed-in person first. A tab shows the description, the machines and places, the people with the group lead first and, for members and management, a link to the group chat. The selected group is in the URL (`?group=<id>`). Without groups, people with `working_groups.manage` get a button to set them up.
- **Settings → Working groups** (`/settings/working-groups`, needs `working_groups.read`): the tile appears only for people who can edit at least one group, which are those with `working_groups.manage` and the leads of a group. Leads see a tab for each group they lead and reach it with "Manage group" on the overview; management sees every group and can also create a group, rename it, choose the lead and delete it. Each tab edits the description and chat link, the members, the machines and the places.
- The screens only hide what the person cannot do; the API enforces every rule above again.

## API

| Operation                                    | Method and path                                  | Needs                       |
| -------------------------------------------- | ------------------------------------------------ | --------------------------- |
| `listWorkingGroups`                          | `GET /working-groups`                            | read                        |
| `createWorkingGroup`                         | `POST /working-groups`                           | manage                      |
| `getWorkingGroup`                            | `GET /working-groups/{groupId}`                  | read                        |
| `updateWorkingGroup`                         | `PATCH /working-groups/{groupId}`                | name: manage; rest: lead or manage |
| `deleteWorkingGroup`                         | `DELETE /working-groups/{groupId}`               | manage                      |
| `addWorkingGroupMember`                      | `POST /working-groups/{groupId}/members`         | lead or manage              |
| `removeWorkingGroupMember`                   | `DELETE /working-groups/{groupId}/members/{personId}` | lead or manage         |
| `setWorkingGroupLead`                        | `PUT /working-groups/{groupId}/lead`             | manage                      |
| `setWorkingGroupMachines`                    | `PUT /working-groups/{groupId}/machines`         | lead or manage              |
| `addWorkingGroupPlace`                       | `POST /working-groups/{groupId}/places`          | lead or manage              |
| `removeWorkingGroupPlace`                    | `DELETE /working-groups/{groupId}/places/{placeId}` | lead or manage           |
| `listWorkingGroupPeople`                     | `GET /working-groups/people?search=`             | manage or lead of any group |
| `listWorkingGroupMachines`                   | `GET /working-groups/machines`                   | manage or lead of any group |

All operations also need `working_groups.read`. The two picker lists return the minimum: people as id and display name (no e-mail, no matriculation number), machines with the group they already belong to.

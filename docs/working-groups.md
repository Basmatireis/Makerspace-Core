# Working groups

A working group is a team of members that looks after machines and places of the makerspace. Each group has:

- a **name** (1–80 characters, unique ignoring case) and a **description** of what the group looks after (up to 500 characters),
- an optional **chat link** (an `https://` URL) to the group's chat, shown only to members of the group and to people who manage working groups,
- exactly one **lead**, who is always a member,
- **members**; a person may belong to several groups,
- the **machines** it looks after; a machine belongs to at most one group,
- **places**: free-text names without a machine, such as "Soldering corner".

## Who may do what

| Operation                                                   | `working_groups.read` only | Lead of the group | `working_groups.manage` |
| ----------------------------------------------------------- | -------------------------- | ----------------- | ----------------------- |
| See groups, leads, member names, machines and places        | yes                        | yes               | yes                     |
| See the chat link                                           | only as a member           | yes (is a member) | yes                     |
| Edit description and chat link                              | no                         | own group         | any group               |
| Add and remove members, set machines, add and remove places | no                         | own group         | any group               |
| Create, rename and delete a group, choose the lead          | no                         | no                | yes                     |

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

## Tickets

A ticket is a problem, request or question for a group (`kind` `problem`, `request` or `question`). Anybody with `working_groups.read` writes one: a subject (1–120 characters), an optional description (up to 2000), an optional machine of that group (else the ticket is "general") and the flag `blocksUse` ("it cannot be used right now"). Everybody with read sees every ticket of every group: subject, description, kind, machine, author name, status, followers, assignee and due date.

A person is **inside** a group when they are a member of it or hold `working_groups.manage`; everybody else with read is **outside**.

| Operation                                                             | Outside | Inside |
| --------------------------------------------------------------------- | ------- | ------ |
| Write a ticket, comment publicly, follow and unfollow (not their own) | yes     | yes    |
| Write an internal comment ("only the group and management see it")    | no      | yes    |
| Plan, change, close, decline and reopen a ticket                      | no      | yes    |

- Status: `new` (the group's inbox) → `planned` → `done` or `declined`. **Plan** moves a new ticket into one of the group's columns with an assignee (a member of the group, optional), a due date (optional) and the column, all in one call. A planned ticket's assignee, due date and column are changed with `PATCH` under optimistic locking (`expectedVersion`, 409 `stale_write`). **Close** (`done` or `declined`, from `new` or `planned`) takes an optional answer that is stored as a public comment in the same transaction; declining requires one (422). **Reopen** sends a planned, done or declined ticket back to the inbox and clears assignee, due date and column. A call that does not fit the ticket's status answers 409 `working_group_task_state`.
- Following ("I have this too") is idempotent: following twice or unfollowing when not following changes nothing and is not audited. The author cannot follow their own ticket (409 `working_group_ticket_own`). The author is not listed among the followers.
- The machine of a ticket must belong to the group (422 `machine_not_in_working_group`); the assignee must be a member (422 `assignee_not_in_group`); the column must belong to the group (422 `working_group_column_not_found`).
- Removing a member clears their assignments in that group; the tickets stay planned without an assignee.
- A deleted person's tickets and comments stay; author and assignee are then absent ("Former member"). Their follows are deleted.
- The list returns at most 500 tickets, newest first, and can be filtered by `groupId` and `status`. Each item carries `isFollowing`, `isMine` (author or assignee), the number of comments the caller may see and `inside`.
- Notifications for planned and closed tickets are not sent yet.

## To-dos

A to-do is a task of the group: a title (1–160 characters), an optional assignee (a member), a due date (required), a column and an optional `repeatEveryDays` (1–730). To-dos and their comments are visible and editable **only to people inside the group**: for everybody else a single to-do answers 404, lists never contain them, and writing one answers 403 (the group itself is visible to every reader).

- Marking a repeating to-do as done creates, in the same transaction, the next open to-do with the same title, assignee (if still a member), column and repeat and a due date of today (UTC) plus the interval; the response names it in `nextTodoId`. Reopening only clears the done mark and spawns nothing.
- Without a column a new to-do goes to the group's first column. `PATCH` uses optimistic locking like tickets. Deleting a to-do is a hard delete and removes its comments.
- Comments on to-dos are always internal.

## Columns

Each group has an ordered list of custom columns between the fixed **Inbox** (tickets with status `new`) and **Done** (done and declined tickets, done to-dos); those two are not rows. A new group starts with "To do" and "In progress". The lead or `working_groups.manage` replaces the list with `PUT /working-groups/{groupId}/columns`: entries with an `id` are renamed and reordered, entries without one are created, missing ids are deleted. The open tickets and to-dos of a deleted column move to the first column of the new list. Column names are 1–40 characters and unique ignoring case (409 `working_group_column_exists`); at least one column must remain (422 `working_group_column_required`), at most 20.

## Pinboard notes

A note is a short text (up to 500 characters) with an author. There are three kinds: a group note (only people inside the group see it), a public note of a group (everybody with `working_groups.read` sees it) and a makerspace note (no group; only `working_groups.manage` writes it). People inside a group pin group and public notes. The author, the group's lead and `working_groups.manage` remove a note; notes cannot be edited, remove and pin again instead.

## Status of machines and places

Every machine and place has a status: `ok` (shown as "Working"), `limited`, `maintenance` or `out_of_order`, with an optional note (up to 200 characters) and an optional "back around" date. People inside the owning group (members and management) change it; `ok` clears the note and the date. The change history feeds "days not ok in the last 90". A machine that leaves its group starts at `ok` again with no history.

## Budget

HTU gives the makerspace a budget per **budget period** (name, from, until, amount). Management shares it out: every group has a **share** ("Given") per period, and what is not given out is "kept back". Each group's figures are **Spent** (ordered, bought or booked), **Reserved** (approved, not paid yet) and **Free** (given minus both). A period can be closed; a closed period can no longer be changed, and a new period can start with the shares of the previous one. The figures and the purchases are visible only to the members of the group and to holders of `working_group_finances.manage` ("finance managers"; the budget of all groups and the kept-back amount: finance managers only). Members can also read the direct bookings of their groups; bookings are costs a finance manager booked directly against a group's budget (group, text, amount, date). A finance manager can delete a booking or replace its text with "Removed" (`redactWorkingGroupBooking`); both are allowed only in an open period, except the text removal, which also works in a closed one.

## Purchases

Members write down what the group wants as one or more items (item, link to the shop, amount, price each, optionally an offer or cart file) and say who buys it: **management** (a collective order) or **the requester** (buys it and gets the money back). A purchase moves from Waiting for approval to Approved (reserved), then to Ordered or Bought (spent) and to Arrived or Money returned; it can be declined with a reason. A purchase that reaches the **project threshold** "needs a project" and can only be declined or deleted. Whoever may act is told by the `can*` flags of the purchase: management approves and declines; the requester (or the group's lead) hands in the receipt of a purchase they bought themselves, with the actual amount (an amount that reaches the project threshold is refused); finance managers mark the money as returned. Offer, cart and receipt files are PDF, JPEG, PNG, GIF or WebP up to 10 MiB. While a purchase is waiting, its requester or the group's lead can attach or replace the offer or cart file. A finance manager can remove a purchase's personal data (`redactWorkingGroupPurchase`: the item text and link, the files, or both) in any status and in closed periods; no figure changes.

## Collective orders

Finance managers combine approved purchases of one period into a **collective order** (shop, optional invoice file, a project request when the total reaches the project threshold) and mark it as ordered; the purchases become ordered and count as spent. The invoice can be uploaded afterwards and deleted for good (`deleteWorkingGroupPurchaseOrderInvoice`, also in a closed period), and "It arrived" marks the order and its purchases as arrived.

## Rules

Finance managers set two limits: the **project threshold** (from this amount a purchase or order needs a project) and the **offers threshold**, and keep the standing **project requests** (number and label) an order can refer to. Writes are guarded by a version (`expectedVersion`), so a stale save is refused.

## Data protection

Tickets, to-dos and comments are one privacy category ("Working group tickets and to-dos"): the person links are unlinked when the person is deleted, the texts stay; subject requests export the subject's own tickets, assignments, to-dos, comments and follows (follows name only the group and the time). Audit events name ids and changed fields, never subjects, descriptions, titles, comments or answers. People merge moves tickets, assignments, to-dos and comments to the surviving person and drops follows that would duplicate or follow the merged person's own ticket. The staging anonymizer replaces subjects, descriptions, titles and comments with neutral text. Do not put personal data in tickets.

## In the app

- **Working groups → Overview** (`/working-groups`, side navigation, needs `working_groups.read`): one tab per group, the groups of the signed-in person first; the selected group is in the URL (`?group=<id>`). People inside the group (members and management) see stat tiles (People, Open tickets, Open to-dos, and "Machines, last 90 days" with the share of days each machine or place was not ok), the **Group pinboard** table (unassigned tickets, unassigned to-dos, overdue to-dos with an assignee, then notes newest first; the last three comments sit under a ticket or to-do, "Open" leads to the item on the tickets page via `?item=ticket:<id>` or `?item=todo:<id>`; "Pin a note" in the toolbar), and a side column with the next to-dos, the people (group lead first), the machines and places with their status and "Change status", and the group chat link. Everybody else sees the group's public notes ("Notes from this group", the description as sub line), "Write a ticket", the people and the machines and places with their status (read-only). Without groups, people with `working_groups.manage` get a button to set them up.
- **Dashboard** (people with `working_groups.read`): a lazily loaded **Pinboard** at the top of the dashboard lists what is yours (open tickets and to-dos assigned to the signed-in person that are overdue or due within 7 days), then every machine and place that is not ok (click a row for status since, who changed it and days not ok in the last 90; people inside the group change the status there), then makerspace notes, public notes and the group notes of the person's own groups. Below it, **All machines and places** shows every machine and place, not-ok first.
- **Working groups → Tickets & to-dos** (`/working-groups/tasks`, needs `working_groups.read`): one combined list of tickets and to-dos with the tabs "All groups" and one per group (`?group=<id>`, default the caller's first own group). The top row counts the open items (inbox, overdue, due this week, later) and shows the unassigned and the caller's own items; each of its columns and tiles filters the list. The list groups items by Inbox, Overdue, This week, Next week, Later, No due date and Done; on a group tab `?view=board` shows the board (Inbox, the group's columns, Done) whose cards people inside the group drag between columns (the detail panel's Column field does the same without dragging). The side panel plans, answers, closes and reopens tickets, edits assignee, due date and column inline (`expectedVersion`), shows comments and, for people outside, follows a ticket. Anybody writes a ticket; "New to-do" and the to-do list appear only for people inside a group; the lead and management edit the columns of a group.
- **Settings → Working groups** (`/settings/working-groups`, needs `working_groups.read`): the tile appears only for people who can edit at least one group, which are those with `working_groups.manage` and the leads of a group. Leads see a tab for each group they lead and reach it with "Manage group" on the overview; management sees every group and can also create a group, rename it, choose the lead and delete it. Each tab edits the description and chat link, the members, the machines and the places.
- **Working groups → Purchases** (`/working-groups/purchases`, for members of a group and for finance managers): tabs "All groups" (finance managers only) and one per group (`?group=<id>`); a budget card (free of given, period, Spent | Reserved | Free, Kept back on All groups) whose Spent and Reserved columns filter the list, the tiles "Waiting for approval" and "Your turn" (finance managers on All groups: "Collective order"), a searchable and filterable list grouped by stage with a detail panel, "Add purchases" and, for finance managers on All groups, "Rules and limits".
- **Working groups → Budget** (`/working-groups/budget`, finance managers only): the budget of the period, the tile "From HTU", the list of groups with their share and use, a panel to change a share, "Edit period" (with "Close this period") and "New budget period".
- The screens only hide what the person cannot do; the API enforces every rule above again.

## API

| Operation                  | Method and path                                       | Needs                              |
| -------------------------- | ----------------------------------------------------- | ---------------------------------- |
| `listWorkingGroups`        | `GET /working-groups`                                 | read                               |
| `createWorkingGroup`       | `POST /working-groups`                                | manage                             |
| `getWorkingGroup`          | `GET /working-groups/{groupId}`                       | read                               |
| `updateWorkingGroup`       | `PATCH /working-groups/{groupId}`                     | name: manage; rest: lead or manage |
| `deleteWorkingGroup`       | `DELETE /working-groups/{groupId}`                    | manage                             |
| `addWorkingGroupMember`    | `POST /working-groups/{groupId}/members`              | lead or manage                     |
| `removeWorkingGroupMember` | `DELETE /working-groups/{groupId}/members/{personId}` | lead or manage                     |
| `setWorkingGroupLead`      | `PUT /working-groups/{groupId}/lead`                  | manage                             |
| `setWorkingGroupMachines`  | `PUT /working-groups/{groupId}/machines`              | lead or manage                     |
| `addWorkingGroupPlace`     | `POST /working-groups/{groupId}/places`               | lead or manage                     |
| `removeWorkingGroupPlace`  | `DELETE /working-groups/{groupId}/places/{placeId}`   | lead or manage                     |
| `listWorkingGroupPeople`   | `GET /working-groups/people?search=`                  | manage or lead of any group        |
| `listWorkingGroupMachines` | `GET /working-groups/machines`                        | manage or lead of any group        |

| `setWorkingGroupColumns` | `PUT /working-groups/{groupId}/columns` | lead or manage |
| `listWorkingGroupTickets` | `GET /working-group-tickets?groupId=&status=` | read |
| `createWorkingGroupTicket` | `POST /working-group-tickets` | read |
| `getWorkingGroupTicket` | `GET /working-group-tickets/{ticketId}` | read (internal comments: inside) |
| `updateWorkingGroupTicket` | `PATCH /working-group-tickets/{ticketId}` | inside |
| `planWorkingGroupTicket` | `POST /working-group-tickets/{ticketId}/plan` | inside |
| `closeWorkingGroupTicket` | `POST /working-group-tickets/{ticketId}/close` | inside |
| `reopenWorkingGroupTicket` | `POST /working-group-tickets/{ticketId}/reopen` | inside |
| `followWorkingGroupTicket` | `PUT /working-group-tickets/{ticketId}/follow` | read |
| `unfollowWorkingGroupTicket` | `DELETE /working-group-tickets/{ticketId}/follow` | read |
| `addWorkingGroupTicketComment` | `POST /working-group-tickets/{ticketId}/comments` | read (internal: inside) |
| `listWorkingGroupTodos` | `GET /working-group-todos?groupId=` | inside (others: empty list) |
| `createWorkingGroupTodo` | `POST /working-group-todos` | inside |
| `getWorkingGroupTodo` | `GET /working-group-todos/{todoId}` | inside (others: 404) |
| `updateWorkingGroupTodo` | `PATCH /working-group-todos/{todoId}` | inside (others: 404) |
| `deleteWorkingGroupTodo` | `DELETE /working-group-todos/{todoId}` | inside (others: 404) |
| `markWorkingGroupTodoDone` | `POST /working-group-todos/{todoId}/done` | inside (others: 404) |
| `reopenWorkingGroupTodo` | `POST /working-group-todos/{todoId}/reopen` | inside (others: 404) |
| `addWorkingGroupTodoComment` | `POST /working-group-todos/{todoId}/comments` | inside (others: 404) |

| `listWorkingGroupNotes` | `GET /working-group-notes?groupId=` | read (group notes: inside) |
| `createWorkingGroupNote` | `POST /working-group-notes` | inside; makerspace note: manage |
| `deleteWorkingGroupNote` | `DELETE /working-group-notes/{noteId}` | author, group lead or manage |
| `setWorkingGroupMachineStatus` | `PUT /working-groups/{groupId}/machines/{machineId}/status` | inside |
| `setWorkingGroupPlaceStatus` | `PUT /working-groups/{groupId}/places/{placeId}/status` | inside |
| `listWorkingGroupStatus` | `GET /working-group-status` | read |
| `listWorkingGroupBudgetPeriods` | `GET /working-group-budget-periods` | read (members of a group and finance managers; others: empty list) |
| `createWorkingGroupBudgetPeriod` | `POST /working-group-budget-periods` | finance manager |
| `updateWorkingGroupBudgetPeriod` | `PATCH /working-group-budget-periods/{periodId}` | finance manager (closed: 409) |
| `closeWorkingGroupBudgetPeriod` | `POST /working-group-budget-periods/{periodId}/close` | finance manager |
| `setWorkingGroupBudgetShare` | `PUT /working-group-budget-periods/{periodId}/shares/{groupId}` | finance manager |
| `getWorkingGroupBudget` | `GET /working-group-budget?periodId=` | member (own groups), finance manager (all groups and totals); others: 404 |
| `listWorkingGroupPurchases` | `GET /working-group-purchases?groupId=&periodId=&status=` | member (own groups), finance manager (all) |
| `createWorkingGroupPurchases` | `POST /working-group-purchases` | member of the group (`working_groups.manage` is not enough) |
| `getWorkingGroupPurchase` | `GET /working-group-purchases/{purchaseId}` | member, finance manager; others: 404 |
| `deleteWorkingGroupPurchase` | `DELETE /working-group-purchases/{purchaseId}` | requester while wanted; finance manager while wanted or declined |
| `approveWorkingGroupPurchase` | `POST /working-group-purchases/{purchaseId}/approve` | finance manager (wanted; not above the project threshold) |
| `declineWorkingGroupPurchase` | `POST /working-group-purchases/{purchaseId}/decline` | finance manager (wanted) |
| `arrivedWorkingGroupPurchase` | `POST /working-group-purchases/{purchaseId}/arrived` | member of the group or finance manager (ordered) |
| `refundedWorkingGroupPurchase` | `POST /working-group-purchases/{purchaseId}/refunded` | finance manager (bought) |
| `handInWorkingGroupPurchaseReceipt` | `POST /working-group-purchases/{purchaseId}/receipt` (raw body, `X-Receipt-Amount`, `X-Expected-Version`) | requester of an approved purchase bought by themselves, lead or finance manager |
| `downloadWorkingGroupPurchaseReceipt` | `GET /working-group-purchases/{purchaseId}/receipt` | member, finance manager |
| `uploadWorkingGroupPurchaseAttachment` | `PUT /working-group-purchases/{purchaseId}/attachment` | requester, lead or finance manager (wanted or approved) |
| `downloadWorkingGroupPurchaseAttachment` | `GET /working-group-purchases/{purchaseId}/attachment` | member, finance manager |
| `redactWorkingGroupPurchase` | `POST /working-group-purchases/{purchaseId}/redact` | finance manager (any status, also closed periods) |
| `listWorkingGroupPurchaseOrders` | `GET /working-group-purchase-orders` | finance manager |
| `createWorkingGroupPurchaseOrder` | `POST /working-group-purchase-orders` | finance manager |
| `getWorkingGroupPurchaseOrder` | `GET /working-group-purchase-orders/{orderId}` | finance manager |
| `arrivedWorkingGroupPurchaseOrder` | `POST /working-group-purchase-orders/{orderId}/arrived` | finance manager |
| `uploadWorkingGroupPurchaseOrderInvoice` | `PUT /working-group-purchase-orders/{orderId}/invoice` | finance manager |
| `downloadWorkingGroupPurchaseOrderInvoice` | `GET /working-group-purchase-orders/{orderId}/invoice` | finance manager |
| `deleteWorkingGroupPurchaseOrderInvoice` | `DELETE /working-group-purchase-orders/{orderId}/invoice` | finance manager (also in a closed period) |
| `listWorkingGroupBookings` | `GET /working-group-bookings?groupId=&periodId=` | member (own groups), finance manager (all) |
| `createWorkingGroupBooking` | `POST /working-group-bookings` | finance manager |
| `deleteWorkingGroupBooking` | `DELETE /working-group-bookings/{bookingId}` | finance manager |
| `redactWorkingGroupBooking` | `POST /working-group-bookings/{bookingId}/redact` | finance manager (also in a closed period) |
| `getWorkingGroupFinanceRules` | `GET /working-group-finance-rules` | member of a group or finance manager |
| `setWorkingGroupFinanceRules` | `PUT /working-group-finance-rules` | finance manager |
| `createWorkingGroupProjectRequest` | `POST /working-group-project-requests` | finance manager |
| `updateWorkingGroupProjectRequest` | `PUT /working-group-project-requests/{requestId}` | finance manager |
| `deleteWorkingGroupProjectRequest` | `DELETE /working-group-project-requests/{requestId}` | finance manager |

All operations also need `working_groups.read`. The two picker lists return the minimum: people as id and display name (no e-mail, no matriculation number), machines with the group they already belong to.

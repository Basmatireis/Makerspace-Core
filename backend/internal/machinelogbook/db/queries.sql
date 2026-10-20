-- name: CreateMachineType :one
INSERT INTO machine_types (id, name, process) VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(process)) RETURNING *;

-- name: ListMachineTypes :many
SELECT * FROM machine_types ORDER BY active DESC, lower(name), id;

-- name: GetMachineType :one
SELECT * FROM machine_types WHERE id = sqlc.arg(id);

-- name: GetMachineTypeForUpdate :one
SELECT * FROM machine_types WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: UpdateMachineType :one
UPDATE machine_types SET name = sqlc.arg(name), active = sqlc.arg(active), process = sqlc.arg(process),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: CreateMachine :one
INSERT INTO machines (id, machine_type_id, name, status, external_identifier, automatic_collection_enabled)
VALUES (sqlc.arg(id), sqlc.arg(machine_type_id), sqlc.arg(name), sqlc.arg(status), sqlc.narg(external_identifier), sqlc.arg(automatic_collection_enabled))
RETURNING *;

-- name: GetMachine :one
SELECT m.*, mt.name AS machine_type_name, mt.active AS machine_type_active, mt.process AS machine_type_process, mt.version AS machine_type_version,
       mt.created_at AS machine_type_created_at, mt.updated_at AS machine_type_updated_at,
       count(j.id)::bigint AS job_count,
       COALESCE(sum(s.runtime_seconds)::bigint, 0)::bigint AS runtime_seconds,
       COALESCE(round(100.0 * count(j.id) FILTER (WHERE NOT s.running AND COALESCE(j.outcome_override, s.derived_outcome) IN ('failed', 'partial_failure')) / NULLIF(count(j.id), 0), 2), 0)::numeric AS failure_rate
FROM machines m
JOIN machine_types mt ON mt.id = m.machine_type_id
LEFT JOIN machine_jobs j ON j.machine_id = m.id AND j.deleted_at IS NULL
LEFT JOIN machine_job_run_summaries s ON s.job_id = j.id
WHERE m.id = sqlc.arg(id)
GROUP BY m.id, mt.id;

-- name: GetMachineForUpdate :one
SELECT * FROM machines WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: ListMachines :many
SELECT m.*, mt.name AS machine_type_name, mt.active AS machine_type_active, mt.process AS machine_type_process, mt.version AS machine_type_version,
       mt.created_at AS machine_type_created_at, mt.updated_at AS machine_type_updated_at,
       count(j.id)::bigint AS job_count,
       COALESCE(sum(s.runtime_seconds)::bigint, 0)::bigint AS runtime_seconds,
       COALESCE(round(100.0 * count(j.id) FILTER (WHERE NOT s.running AND COALESCE(j.outcome_override, s.derived_outcome) IN ('failed', 'partial_failure')) / NULLIF(count(j.id), 0), 2), 0)::numeric AS failure_rate
FROM machines m
JOIN machine_types mt ON mt.id = m.machine_type_id
LEFT JOIN machine_jobs j ON j.machine_id = m.id AND j.deleted_at IS NULL
LEFT JOIN machine_job_run_summaries s ON s.job_id = j.id
WHERE (sqlc.arg(search)::text = '' OR lower(m.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%' OR lower(mt.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND (sqlc.narg(status)::text IS NULL OR m.status = sqlc.narg(status)::text)
GROUP BY m.id, mt.id
ORDER BY CASE m.status WHEN 'active' THEN 0 WHEN 'maintenance' THEN 1 ELSE 2 END, lower(m.name), m.id
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountMachines :one
SELECT count(*) FROM machines m JOIN machine_types mt ON mt.id = m.machine_type_id
WHERE (sqlc.arg(search)::text = '' OR lower(m.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%' OR lower(mt.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND (sqlc.narg(status)::text IS NULL OR m.status = sqlc.narg(status)::text);

-- name: UpdateMachine :one
UPDATE machines SET machine_type_id = sqlc.arg(machine_type_id), name = sqlc.arg(name), status = sqlc.arg(status),
    external_identifier = sqlc.narg(external_identifier), automatic_collection_enabled = sqlc.arg(automatic_collection_enabled),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: CreateOrganization :one
INSERT INTO organizations (id, name, kind, address_line, postal_code, locality, country_code, contact_name, contact_email)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(kind), sqlc.arg(address_line), sqlc.arg(postal_code), sqlc.arg(locality),
        sqlc.arg(country_code), sqlc.arg(contact_name), sqlc.arg(contact_email))
RETURNING *;

-- name: GetOrganization :one
SELECT * FROM organizations WHERE id = sqlc.arg(id);

-- name: GetOrganizationForUpdate :one
SELECT * FROM organizations WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: OrganizationIsReferenced :one
-- True while any historical record points at the organization. Soft-deleted
-- jobs count: their foreign key would otherwise be nulled out by the delete.
SELECT (EXISTS (SELECT 1 FROM machine_jobs j WHERE j.customer_organization_id = sqlc.arg(id)::uuid)
    OR EXISTS (SELECT 1 FROM orders o WHERE o.customer_organization_id = sqlc.arg(id)::uuid)
    OR EXISTS (SELECT 1 FROM external_invoice_request_details d WHERE d.recipient_organization_id = sqlc.arg(id)::uuid))::boolean AS referenced;

-- name: DeleteOrganization :execrows
-- Members, the pricing group assignment and invoicing requirements go with it
-- through ON DELETE CASCADE.
DELETE FROM organizations WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version);

-- name: GetOrganizationDetail :one
SELECT o.*, pg.id AS pricing_group_id, pg.name AS pricing_group_name,
       COALESCE(a.version, 0)::bigint AS pricing_group_assignment_version,
       (SELECT count(*) FROM organization_members m WHERE m.organization_id = o.id)::bigint AS member_count
FROM organizations o
LEFT JOIN organization_pricing_group_assignments a ON a.organization_id = o.id
LEFT JOIN pricing_groups pg ON pg.id = a.pricing_group_id
WHERE o.id = sqlc.arg(id);

-- name: ListOrganizations :many
SELECT o.*, pg.id AS pricing_group_id, pg.name AS pricing_group_name,
       COALESCE(a.version, 0)::bigint AS pricing_group_assignment_version,
       (SELECT count(*) FROM organization_members m WHERE m.organization_id = o.id)::bigint AS member_count
FROM organizations o
LEFT JOIN organization_pricing_group_assignments a ON a.organization_id = o.id
LEFT JOIN pricing_groups pg ON pg.id = a.pricing_group_id
WHERE (sqlc.arg(search)::text = '' OR lower(o.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND (sqlc.narg(active)::boolean IS NULL OR o.active = sqlc.narg(active)::boolean)
  AND (sqlc.narg(kind)::text IS NULL OR o.kind = sqlc.narg(kind)::text)
  AND (sqlc.narg(pricing_group_id)::uuid IS NULL OR a.pricing_group_id = sqlc.narg(pricing_group_id)::uuid)
ORDER BY o.active DESC, lower(o.name), o.id
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountOrganizations :one
SELECT count(*) FROM organizations o
LEFT JOIN organization_pricing_group_assignments a ON a.organization_id = o.id
WHERE (sqlc.arg(search)::text = '' OR lower(o.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND (sqlc.narg(active)::boolean IS NULL OR o.active = sqlc.narg(active)::boolean)
  AND (sqlc.narg(kind)::text IS NULL OR o.kind = sqlc.narg(kind)::text)
  AND (sqlc.narg(pricing_group_id)::uuid IS NULL OR a.pricing_group_id = sqlc.narg(pricing_group_id)::uuid);

-- name: UpdateOrganization :one
UPDATE organizations SET name = sqlc.arg(name), kind = sqlc.arg(kind), active = sqlc.arg(active),
    address_line = sqlc.arg(address_line), postal_code = sqlc.arg(postal_code), locality = sqlc.arg(locality),
    country_code = sqlc.arg(country_code), contact_name = sqlc.arg(contact_name), contact_email = sqlc.arg(contact_email),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: ListOrganizationMembers :many
SELECT m.person_id, btrim(p.first_name || ' ' || p.last_name) AS display_name, m.added_at
FROM organization_members m JOIN people p ON p.id = m.person_id
WHERE m.organization_id = sqlc.arg(organization_id)
ORDER BY lower(p.last_name), lower(p.first_name), p.id;

-- name: AddOrganizationMember :one
INSERT INTO organization_members (organization_id, person_id)
VALUES (sqlc.arg(organization_id), sqlc.arg(person_id))
RETURNING added_at;

-- name: RemoveOrganizationMember :one
DELETE FROM organization_members
WHERE organization_id = sqlc.arg(organization_id) AND person_id = sqlc.arg(person_id)
RETURNING person_id;

-- name: ListActiveOrganizationsOfPeople :many
SELECT m.person_id, o.id AS organization_id, o.name AS organization_name
FROM organization_members m JOIN organizations o ON o.id = m.organization_id
WHERE o.active AND m.person_id = ANY(sqlc.arg(person_ids)::uuid[])
ORDER BY m.person_id, lower(o.name), o.id;

-- name: SearchBillingParties :many
SELECT party_kind, party_id, display_name, organization_kind, pricing_group_id, pricing_group_name,
       pricing_group_assignment_version FROM (
    SELECT 'person'::text AS party_kind, p.id AS party_id, btrim(p.first_name || ' ' || p.last_name) AS display_name,
           NULL::text AS organization_kind, NULL::uuid AS pricing_group_id, NULL::text AS pricing_group_name,
           0::bigint AS pricing_group_assignment_version,
           lower(p.last_name || ' ' || p.first_name) AS ordering
    FROM people p
    WHERE sqlc.arg(search)::text = '' OR lower(p.first_name || ' ' || p.last_name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
    UNION ALL
    SELECT 'organization'::text, o.id, o.name, o.kind, pg.id, pg.name,
           COALESCE(a.version, 0)::bigint, lower(o.name)
    FROM organizations o
    LEFT JOIN organization_pricing_group_assignments a ON a.organization_id = o.id
    LEFT JOIN pricing_groups pg ON pg.id = a.pricing_group_id
    WHERE o.active AND (sqlc.arg(search)::text = '' OR lower(o.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
) parties
ORDER BY ordering, party_id
LIMIT sqlc.arg(page_limit);

-- name: SearchMachineJobOperators :many
SELECT p.id AS person_id, btrim(p.first_name || ' ' || p.last_name) AS display_name
FROM people p JOIN accounts a ON a.person_id = p.id AND a.status = 'enabled'
WHERE sqlc.arg(search)::text = '' OR lower(p.first_name || ' ' || p.last_name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
ORDER BY lower(p.last_name), lower(p.first_name), p.id
LIMIT sqlc.arg(page_limit);

-- name: GetBillingPerson :one
SELECT p.id, btrim(p.first_name || ' ' || p.last_name) AS display_name
FROM people p
WHERE p.id = sqlc.arg(id);

-- name: GetBillingOrganization :one
SELECT o.id, o.name AS display_name, o.kind AS organization_kind,
       pg.id AS pricing_group_id, pg.name AS pricing_group_name,
       COALESCE(a.version, 0)::bigint AS pricing_group_assignment_version
FROM organizations o
LEFT JOIN organization_pricing_group_assignments a ON a.organization_id = o.id
LEFT JOIN pricing_groups pg ON pg.id = a.pricing_group_id
WHERE o.id = sqlc.arg(id);

-- name: GetMachineJobOperator :one
SELECT p.id AS person_id, btrim(p.first_name || ' ' || p.last_name) AS display_name
FROM people p
WHERE p.id = sqlc.arg(id);

-- name: OperatorExists :one
SELECT EXISTS (SELECT 1 FROM accounts WHERE person_id = sqlc.arg(person_id) AND status = 'enabled');

-- name: BillingPersonExists :one
SELECT EXISTS (SELECT 1 FROM people WHERE id = sqlc.arg(id));

-- name: ActiveOrganizationExists :one
SELECT EXISTS (SELECT 1 FROM organizations WHERE id = sqlc.arg(id) AND active);

-- name: CreatePricingGroup :one
INSERT INTO pricing_groups (id, name, description, is_default)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.narg(description), sqlc.arg(is_default)) RETURNING *;

-- name: ClearDefaultPricingGroup :exec
UPDATE pricing_groups SET is_default = false, version = version + 1, updated_at = now()
WHERE is_default AND id <> sqlc.arg(except_id);

-- name: ListPricingGroups :many
SELECT * FROM pricing_groups ORDER BY active DESC, is_default DESC, lower(name), id;

-- name: GetPricingGroup :one
SELECT * FROM pricing_groups WHERE id = sqlc.arg(id);

-- name: GetPricingGroupForUpdate :one
SELECT * FROM pricing_groups WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: GetDefaultPricingGroup :one
SELECT * FROM pricing_groups WHERE is_default AND active;

-- name: UpdatePricingGroup :one
UPDATE pricing_groups SET name = sqlc.arg(name), description = sqlc.narg(description), active = sqlc.arg(active),
    is_default = sqlc.arg(is_default), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: CreatePricingRule :one
INSERT INTO pricing_rules (id, pricing_group_id, kind, machine_type_id, material_type_id, material_unit, measure, block_size, rate)
VALUES (sqlc.arg(id), sqlc.arg(pricing_group_id), sqlc.arg(kind), sqlc.narg(machine_type_id), sqlc.narg(material_type_id), sqlc.narg(material_unit), sqlc.narg(measure), sqlc.narg(block_size), sqlc.arg(rate))
RETURNING *;

-- name: ListPricingRulesByGroup :many
SELECT r.*, mt.name AS material_type_name FROM pricing_rules r
LEFT JOIN material_types mt ON mt.id = r.material_type_id
WHERE r.pricing_group_id = sqlc.arg(pricing_group_id)
ORDER BY r.active DESC, r.kind, lower(mt.name) NULLS FIRST, r.machine_type_id NULLS FIRST, r.measure NULLS FIRST, r.id;

-- name: GetPricingRuleForUpdate :one
SELECT * FROM pricing_rules WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: UpdatePricingRule :one
UPDATE pricing_rules SET kind = sqlc.arg(kind), machine_type_id = sqlc.narg(machine_type_id),
    material_type_id = sqlc.narg(material_type_id), material_unit = sqlc.narg(material_unit), measure = sqlc.narg(measure),
    block_size = sqlc.narg(block_size), rate = sqlc.arg(rate),
    active = sqlc.arg(active), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: GetActivePricingRulesByGroup :many
SELECT * FROM pricing_rules WHERE pricing_group_id = sqlc.arg(pricing_group_id) AND active
ORDER BY kind, material_type_id NULLS FIRST, machine_type_id NULLS FIRST, id;

-- The active group of the person's highest-priority mapped role (larger priority wins).
-- name: GetPersonRolePricingGroup :one
SELECT pg.* FROM person_roles pr
JOIN role_pricing_groups rpg ON rpg.role_id = pr.role_id
JOIN pricing_groups pg ON pg.id = rpg.pricing_group_id
WHERE pr.person_id = sqlc.arg(person_id) AND pg.active
ORDER BY rpg.priority DESC
LIMIT 1;

-- name: LockRolePricingGroups :exec
SELECT pg_advisory_xact_lock(hashtextextended('role_pricing_groups', 0));

-- name: ListRolePricingGroups :many
SELECT rpg.role_id, r.name AS role_name, rpg.pricing_group_id, pg.name AS pricing_group_name, rpg.priority
FROM role_pricing_groups rpg
JOIN roles r ON r.id = rpg.role_id
JOIN pricing_groups pg ON pg.id = rpg.pricing_group_id
ORDER BY rpg.priority DESC, rpg.role_id;

-- name: DeleteRolePricingGroups :exec
DELETE FROM role_pricing_groups;

-- name: InsertRolePricingGroup :exec
INSERT INTO role_pricing_groups (role_id, pricing_group_id, priority, updated_by_account_id)
VALUES (sqlc.arg(role_id), sqlc.arg(pricing_group_id), sqlc.arg(priority), sqlc.arg(updated_by_account_id));

-- name: RoleExists :one
SELECT EXISTS (SELECT 1 FROM roles WHERE id = sqlc.arg(id));

-- name: GetOrganizationPricingGroup :one
SELECT pg.* FROM organization_pricing_group_assignments a JOIN pricing_groups pg ON pg.id = a.pricing_group_id
WHERE a.organization_id = sqlc.arg(organization_id) AND pg.active;

-- name: UpsertOrganizationPricingAssignment :one
INSERT INTO organization_pricing_group_assignments (organization_id, pricing_group_id, assigned_by_account_id)
VALUES (sqlc.arg(organization_id), sqlc.arg(pricing_group_id), sqlc.arg(assigned_by_account_id))
ON CONFLICT (organization_id) DO UPDATE SET pricing_group_id = EXCLUDED.pricing_group_id,
    assigned_by_account_id = EXCLUDED.assigned_by_account_id, version = organization_pricing_group_assignments.version + 1, updated_at = now()
WHERE organization_pricing_group_assignments.version = sqlc.arg(expected_version)
RETURNING *;

-- name: DeleteOrganizationPricingAssignment :one
DELETE FROM organization_pricing_group_assignments WHERE organization_id = sqlc.arg(organization_id) AND version = sqlc.arg(expected_version) RETURNING organization_id;

-- name: CreateMaterial :one
INSERT INTO materials (id, name, material_type_id, color_name, color_hex, unit, low_stock_threshold, variant, manufacturer, sale_price, package_size, storage_location, notes)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(material_type_id), sqlc.narg(color_name), sqlc.narg(color_hex), sqlc.arg(unit), sqlc.narg(low_stock_threshold),
    sqlc.narg(variant), sqlc.narg(manufacturer), sqlc.narg(sale_price), sqlc.narg(package_size), sqlc.narg(storage_location), sqlc.narg(notes)) RETURNING *;

-- name: CreateMaterialBalance :one
INSERT INTO material_balances (material_id) VALUES (sqlc.arg(material_id)) RETURNING *;

-- name: UpsertMaterialFilamentProperties :one
INSERT INTO material_filament_properties (material_id, diameter_mm)
VALUES (sqlc.arg(material_id), sqlc.arg(diameter_mm))
ON CONFLICT (material_id) DO UPDATE SET diameter_mm=EXCLUDED.diameter_mm, updated_at=now()
RETURNING *;

-- name: DeleteMaterialFilamentProperties :exec
DELETE FROM material_filament_properties WHERE material_id=sqlc.arg(material_id);

-- name: GetMaterial :one
SELECT m.*, mt.name AS material_type_name, mt.kind AS material_kind, b.quantity, b.inventory_value, b.average_unit_cost, b.version AS inventory_version, b.updated_at AS balance_updated_at,
       COALESCE(-sum(t.quantity_delta) FILTER (WHERE t.quantity_delta < 0 AND t.occurred_at >= now() - interval '30 days'), 0)::numeric AS recent_consumption,
       fp.diameter_mm,
       COALESCE((SELECT sum(
           COALESCE((SELECT sum(it.quantity_delta) FROM inventory_transactions it WHERE it.fill_id=f.id), 0::numeric)
           + COALESCE((SELECT sum(it.transfer_quantity) FROM inventory_transactions it WHERE it.to_fill_id=f.id), 0::numeric)
           - COALESCE((SELECT sum(it.transfer_quantity) FROM inventory_transactions it WHERE it.from_fill_id=f.id), 0::numeric))
           FROM filament_spool_fills f WHERE f.material_id=m.id AND f.closed_at IS NULL),0)::numeric AS assigned_quantity
FROM materials m JOIN material_balances b ON b.material_id = m.id
JOIN material_types mt ON mt.id = m.material_type_id
LEFT JOIN material_filament_properties fp ON fp.material_id=m.id
LEFT JOIN inventory_transactions t ON t.material_id = m.id
WHERE m.id = sqlc.arg(id)
GROUP BY m.id, mt.id, b.material_id, fp.material_id;

-- name: GetMaterialForUpdate :one
SELECT m.*, b.quantity, b.inventory_value, b.average_unit_cost, b.version AS inventory_version, b.updated_at AS balance_updated_at
FROM materials m JOIN material_balances b ON b.material_id = m.id
WHERE m.id = sqlc.arg(id)
FOR UPDATE OF b, m;

-- name: ListMaterials :many
SELECT m.*, mt.name AS material_type_name, mt.kind AS material_kind, b.quantity, b.inventory_value, b.average_unit_cost, b.version AS inventory_version, b.updated_at AS balance_updated_at,
       COALESCE(-sum(t.quantity_delta) FILTER (WHERE t.quantity_delta < 0 AND t.occurred_at >= now() - interval '30 days'), 0)::numeric AS recent_consumption,
       fp.diameter_mm,
       COALESCE((SELECT sum(
           COALESCE((SELECT sum(it.quantity_delta) FROM inventory_transactions it WHERE it.fill_id=f.id), 0::numeric)
           + COALESCE((SELECT sum(it.transfer_quantity) FROM inventory_transactions it WHERE it.to_fill_id=f.id), 0::numeric)
           - COALESCE((SELECT sum(it.transfer_quantity) FROM inventory_transactions it WHERE it.from_fill_id=f.id), 0::numeric))
           FROM filament_spool_fills f WHERE f.material_id=m.id AND f.closed_at IS NULL),0)::numeric AS assigned_quantity
FROM materials m JOIN material_balances b ON b.material_id = m.id
JOIN material_types mt ON mt.id = m.material_type_id
LEFT JOIN material_filament_properties fp ON fp.material_id=m.id
LEFT JOIN inventory_transactions t ON t.material_id = m.id
WHERE (sqlc.arg(search)::text = '' OR lower(m.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%' OR lower(mt.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(m.variant, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%' OR lower(COALESCE(m.manufacturer, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND (sqlc.narg(material_type_id)::uuid IS NULL OR m.material_type_id = sqlc.narg(material_type_id)::uuid)
  AND (sqlc.arg(kind)::text = '' OR mt.kind = sqlc.arg(kind)::text)
  AND (sqlc.arg(stock_state)::text = '' OR
       (sqlc.arg(stock_state)::text = 'empty' AND b.quantity = 0) OR
       (sqlc.arg(stock_state)::text = 'low_stock' AND b.quantity > 0 AND m.low_stock_threshold IS NOT NULL AND b.quantity <= m.low_stock_threshold) OR
       (sqlc.arg(stock_state)::text = 'in_stock' AND b.quantity > 0 AND (m.low_stock_threshold IS NULL OR b.quantity > m.low_stock_threshold)))
GROUP BY m.id, mt.id, b.material_id, fp.material_id
ORDER BY m.active DESC, lower(m.name), m.id
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountMaterials :one
SELECT count(*) FROM materials m JOIN material_balances b ON b.material_id = m.id
JOIN material_types mt ON mt.id = m.material_type_id
WHERE (sqlc.arg(search)::text = '' OR lower(m.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%' OR lower(mt.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(m.variant, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%' OR lower(COALESCE(m.manufacturer, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND (sqlc.narg(material_type_id)::uuid IS NULL OR m.material_type_id = sqlc.narg(material_type_id)::uuid)
  AND (sqlc.arg(kind)::text = '' OR mt.kind = sqlc.arg(kind)::text)
  AND (sqlc.arg(stock_state)::text = '' OR
       (sqlc.arg(stock_state)::text = 'empty' AND b.quantity = 0) OR
       (sqlc.arg(stock_state)::text = 'low_stock' AND b.quantity > 0 AND m.low_stock_threshold IS NOT NULL AND b.quantity <= m.low_stock_threshold) OR
       (sqlc.arg(stock_state)::text = 'in_stock' AND b.quantity > 0 AND (m.low_stock_threshold IS NULL OR b.quantity > m.low_stock_threshold)));

-- name: TotalInventoryValue :one
SELECT COALESCE(sum(inventory_value), 0)::numeric FROM material_balances;

-- name: UpdateMaterial :one
UPDATE materials SET name = sqlc.arg(name), material_type_id = sqlc.arg(material_type_id), color_name = sqlc.narg(color_name), color_hex = sqlc.narg(color_hex), unit = sqlc.arg(unit),
    active = sqlc.arg(active), low_stock_threshold = sqlc.narg(low_stock_threshold), variant = sqlc.narg(variant), manufacturer = sqlc.narg(manufacturer),
    sale_price = sqlc.narg(sale_price), package_size = sqlc.narg(package_size), storage_location = sqlc.narg(storage_location), notes = sqlc.narg(notes),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: UpdateMaterialBalance :one
UPDATE material_balances SET quantity = sqlc.arg(quantity), inventory_value = sqlc.arg(inventory_value),
    average_unit_cost = sqlc.arg(average_unit_cost), version = version + 1, updated_at = now()
WHERE material_id = sqlc.arg(material_id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: InsertInventoryTransaction :one
INSERT INTO inventory_transactions (id, material_id, kind, quantity_delta, unit_acquisition_cost, inventory_value_delta,
    total_purchase_price, occurred_at, supplier, note, adjustment_reason, run_usage_id, actor_account_id, purchase_reference)
VALUES (sqlc.arg(id), sqlc.arg(material_id), sqlc.arg(kind), sqlc.arg(quantity_delta), sqlc.arg(unit_acquisition_cost), sqlc.arg(inventory_value_delta),
    sqlc.narg(total_purchase_price), sqlc.arg(occurred_at), sqlc.narg(supplier), sqlc.narg(note), sqlc.narg(adjustment_reason), sqlc.narg(run_usage_id), sqlc.narg(actor_account_id), sqlc.narg(purchase_reference))
RETURNING *;

-- name: ListInventoryTransactions :many
SELECT t.*, j.id AS machine_job_id, j.display_id AS machine_job_display_id,
       pe.first_name AS actor_first_name, pe.last_name AS actor_last_name
FROM inventory_transactions t
LEFT JOIN accounts ac ON ac.id = t.actor_account_id
LEFT JOIN people pe ON pe.id = ac.person_id
LEFT JOIN machine_run_usages u ON u.id = t.run_usage_id
LEFT JOIN machine_runs ur ON ur.id = u.run_id
LEFT JOIN machine_jobs j ON j.id = ur.job_id AND j.deleted_at IS NULL
WHERE t.material_id = sqlc.arg(material_id)
ORDER BY t.occurred_at DESC, t.id DESC
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountInventoryTransactions :one
SELECT count(*) FROM inventory_transactions WHERE material_id = sqlc.arg(material_id);

-- name: NextFilamentSpoolSequence :one
SELECT nextval('filament_spool_display_sequence')::bigint;

-- name: CreateFilamentSpool :one
INSERT INTO filament_spools (id, display_id, kind, label, tare_weight_g, acquired_on, acquisition_reference, storage_location, notes)
VALUES (sqlc.arg(id), sqlc.arg(display_id), sqlc.arg(kind), sqlc.narg(label), sqlc.narg(tare_weight_g), sqlc.narg(acquired_on),
    sqlc.narg(acquisition_reference), sqlc.narg(storage_location), sqlc.narg(notes))
RETURNING *;

-- name: InsertFilamentSpoolFill :one
INSERT INTO filament_spool_fills (id, spool_id, fill_number, material_id, manufacturer, product_name, initial_net_weight_g, filled_at)
VALUES (sqlc.arg(id), sqlc.arg(spool_id), sqlc.arg(fill_number), sqlc.arg(material_id), sqlc.narg(manufacturer),
    sqlc.narg(product_name), sqlc.arg(initial_net_weight_g), sqlc.arg(filled_at))
RETURNING *;

-- name: NextFilamentSpoolFillNumber :one
SELECT (COALESCE(max(fill_number), 0) + 1)::integer FROM filament_spool_fills WHERE spool_id = sqlc.arg(spool_id);

-- name: GetOpenFilamentSpoolFill :one
SELECT f.*,
       (COALESCE((SELECT sum(t.quantity_delta) FROM inventory_transactions t WHERE t.fill_id=f.id), 0::numeric)
       + COALESCE((SELECT sum(t.transfer_quantity) FROM inventory_transactions t WHERE t.to_fill_id=f.id), 0::numeric)
       - COALESCE((SELECT sum(t.transfer_quantity) FROM inventory_transactions t WHERE t.from_fill_id=f.id), 0::numeric))::numeric AS remaining_quantity
FROM filament_spool_fills f
WHERE f.spool_id=sqlc.arg(spool_id) AND f.closed_at IS NULL;

-- name: GetFilamentSpoolFill :one
SELECT f.*,
       (COALESCE((SELECT sum(t.quantity_delta) FROM inventory_transactions t WHERE t.fill_id=f.id), 0::numeric)
       + COALESCE((SELECT sum(t.transfer_quantity) FROM inventory_transactions t WHERE t.to_fill_id=f.id), 0::numeric)
       - COALESCE((SELECT sum(t.transfer_quantity) FROM inventory_transactions t WHERE t.from_fill_id=f.id), 0::numeric))::numeric AS remaining_quantity
FROM filament_spool_fills f
WHERE f.id=sqlc.arg(id);

-- name: CloseFilamentSpoolFill :one
UPDATE filament_spool_fills SET closed_at=sqlc.arg(closed_at), leftover_g=sqlc.arg(leftover_g), leftover_outcome=sqlc.arg(leftover_outcome)
WHERE id=sqlc.arg(id) AND closed_at IS NULL
RETURNING *;

-- name: UpdateOpenFilamentSpoolFillSnapshot :execrows
UPDATE filament_spool_fills SET manufacturer=sqlc.narg(manufacturer), product_name=sqlc.narg(product_name)
WHERE spool_id=sqlc.arg(spool_id) AND closed_at IS NULL;

-- name: ListClosedFilamentSpoolFills :many
SELECT f.*, m.name AS material_name,
       COALESCE((SELECT -sum(t.quantity_delta) FROM inventory_transactions t
                 WHERE t.fill_id=f.id AND t.kind IN ('machine_run_consumption', 'manual_consumption')), 0::numeric)::numeric AS used_g
FROM filament_spool_fills f JOIN materials m ON m.id=f.material_id
WHERE f.spool_id=sqlc.arg(spool_id) AND f.closed_at IS NOT NULL
ORDER BY f.fill_number DESC;

-- name: GetFilamentSpool :one
SELECT s.id, s.display_id, s.kind, s.label, s.lifecycle, s.archived_at, s.tare_weight_g, s.acquired_on, s.acquisition_reference,
       s.storage_location, s.notes, s.version, s.created_at, s.updated_at,
       COALESCE(f.fill_number, (SELECT max(x.fill_number) FROM filament_spool_fills x WHERE x.spool_id=s.id), 0)::integer AS fill_number,
       f.id AS fill_id, f.filled_at, f.material_id, f.manufacturer, f.product_name, f.initial_net_weight_g,
       m.name AS material_name, mt.name AS material_type_name, m.color_name, m.color_hex, m.unit,
       (COALESCE((SELECT sum(t.quantity_delta) FROM inventory_transactions t WHERE t.fill_id=f.id), 0::numeric)
       + COALESCE((SELECT sum(t.transfer_quantity) FROM inventory_transactions t WHERE t.to_fill_id=f.id), 0::numeric)
       - COALESCE((SELECT sum(t.transfer_quantity) FROM inventory_transactions t WHERE t.from_fill_id=f.id), 0::numeric))::numeric AS remaining_quantity,
       (pa.id IS NOT NULL)::boolean AS mounted,
       mu.machine_id AS mount_machine_id, mc.name AS mount_machine_name, mu.name AS mount_input_unit_name,
       pl.id AS mount_slot_id, pl.name AS mount_slot_name
FROM filament_spools s
LEFT JOIN filament_spool_fills f ON f.spool_id=s.id AND f.closed_at IS NULL
LEFT JOIN materials m ON m.id=f.material_id
LEFT JOIN material_types mt ON mt.id=m.material_type_id
LEFT JOIN printer_spool_assignments pa ON pa.spool_id=s.id AND pa.unmounted_at IS NULL
LEFT JOIN printer_slots pl ON pl.id=pa.slot_id
LEFT JOIN printer_input_units mu ON mu.id=pl.input_unit_id
LEFT JOIN machines mc ON mc.id=mu.machine_id
WHERE s.id=sqlc.arg(id);

-- name: GetFilamentSpoolForUpdate :one
SELECT * FROM filament_spools WHERE id=sqlc.arg(id) FOR UPDATE;

-- name: ListFilamentSpools :many
SELECT s.id, s.display_id, s.kind, s.label, s.lifecycle, s.archived_at, s.tare_weight_g, s.acquired_on, s.acquisition_reference,
       s.storage_location, s.notes, s.version, s.created_at, s.updated_at,
       COALESCE(f.fill_number, (SELECT max(x.fill_number) FROM filament_spool_fills x WHERE x.spool_id=s.id), 0)::integer AS fill_number,
       f.id AS fill_id, f.filled_at, f.material_id, f.manufacturer, f.product_name, f.initial_net_weight_g,
       m.name AS material_name, mt.name AS material_type_name, m.color_name, m.color_hex, m.unit,
       (COALESCE((SELECT sum(t.quantity_delta) FROM inventory_transactions t WHERE t.fill_id=f.id), 0::numeric)
       + COALESCE((SELECT sum(t.transfer_quantity) FROM inventory_transactions t WHERE t.to_fill_id=f.id), 0::numeric)
       - COALESCE((SELECT sum(t.transfer_quantity) FROM inventory_transactions t WHERE t.from_fill_id=f.id), 0::numeric))::numeric AS remaining_quantity,
       (pa.id IS NOT NULL)::boolean AS mounted,
       mu.machine_id AS mount_machine_id, mc.name AS mount_machine_name, mu.name AS mount_input_unit_name,
       pl.id AS mount_slot_id, pl.name AS mount_slot_name
FROM filament_spools s
LEFT JOIN filament_spool_fills f ON f.spool_id=s.id AND f.closed_at IS NULL
LEFT JOIN materials m ON m.id=f.material_id
LEFT JOIN material_types mt ON mt.id=m.material_type_id
LEFT JOIN printer_spool_assignments pa ON pa.spool_id=s.id AND pa.unmounted_at IS NULL
LEFT JOIN printer_slots pl ON pl.id=pa.slot_id
LEFT JOIN printer_input_units mu ON mu.id=pl.input_unit_id
LEFT JOIN machines mc ON mc.id=mu.machine_id
WHERE (sqlc.arg(search)::text='' OR lower(s.display_id) LIKE '%'||lower(sqlc.arg(search)::text)||'%'
    OR lower(COALESCE(s.label,'')) LIKE '%'||lower(sqlc.arg(search)::text)||'%'
    OR lower(COALESCE(m.name,'')) LIKE '%'||lower(sqlc.arg(search)::text)||'%'
    OR lower(COALESCE(f.manufacturer,'')) LIKE '%'||lower(sqlc.arg(search)::text)||'%'
    OR lower(COALESCE(f.product_name,'')) LIKE '%'||lower(sqlc.arg(search)::text)||'%')
  AND (sqlc.narg(material_id)::uuid IS NULL OR f.material_id=sqlc.narg(material_id))
  AND (sqlc.arg(lifecycle)::text='' OR s.lifecycle=sqlc.arg(lifecycle)::text)
  AND (sqlc.arg(location)::text='' OR lower(COALESCE(s.storage_location,'')) LIKE '%'||lower(sqlc.arg(location)::text)||'%')
  AND (sqlc.arg(kind)::text='' OR s.kind=sqlc.arg(kind)::text)
  AND (cardinality(sqlc.arg(statuses)::text[])=0 OR
       (CASE WHEN s.lifecycle='archived' THEN 'archived' WHEN s.kind='single_use' THEN 'active' WHEN f.id IS NOT NULL THEN 'loaded' ELSE 'needs_refill' END) = ANY(sqlc.arg(statuses)::text[]))
  AND (sqlc.narg(mounted)::boolean IS NULL OR EXISTS(SELECT 1 FROM printer_spool_assignments a WHERE a.spool_id=s.id AND a.unmounted_at IS NULL) = sqlc.narg(mounted)::boolean)
  AND (sqlc.arg(manufacturer)::text='' OR lower(COALESCE(f.manufacturer,''))=lower(sqlc.arg(manufacturer)::text))
  AND (NOT sqlc.arg(consumable)::boolean OR (f.id IS NOT NULL AND s.lifecycle='active'))
ORDER BY s.lifecycle, lower(s.display_id), s.id
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountFilamentSpools :one
SELECT count(*)
FROM filament_spools s
LEFT JOIN filament_spool_fills f ON f.spool_id=s.id AND f.closed_at IS NULL
LEFT JOIN materials m ON m.id=f.material_id
WHERE (sqlc.arg(search)::text='' OR lower(s.display_id) LIKE '%'||lower(sqlc.arg(search)::text)||'%'
    OR lower(COALESCE(s.label,'')) LIKE '%'||lower(sqlc.arg(search)::text)||'%'
    OR lower(COALESCE(m.name,'')) LIKE '%'||lower(sqlc.arg(search)::text)||'%'
    OR lower(COALESCE(f.manufacturer,'')) LIKE '%'||lower(sqlc.arg(search)::text)||'%'
    OR lower(COALESCE(f.product_name,'')) LIKE '%'||lower(sqlc.arg(search)::text)||'%')
  AND (sqlc.narg(material_id)::uuid IS NULL OR f.material_id=sqlc.narg(material_id))
  AND (sqlc.arg(lifecycle)::text='' OR s.lifecycle=sqlc.arg(lifecycle)::text)
  AND (sqlc.arg(location)::text='' OR lower(COALESCE(s.storage_location,'')) LIKE '%'||lower(sqlc.arg(location)::text)||'%')
  AND (sqlc.arg(kind)::text='' OR s.kind=sqlc.arg(kind)::text)
  AND (cardinality(sqlc.arg(statuses)::text[])=0 OR
       (CASE WHEN s.lifecycle='archived' THEN 'archived' WHEN s.kind='single_use' THEN 'active' WHEN f.id IS NOT NULL THEN 'loaded' ELSE 'needs_refill' END) = ANY(sqlc.arg(statuses)::text[]))
  AND (sqlc.narg(mounted)::boolean IS NULL OR EXISTS(SELECT 1 FROM printer_spool_assignments a WHERE a.spool_id=s.id AND a.unmounted_at IS NULL) = sqlc.narg(mounted)::boolean)
  AND (sqlc.arg(manufacturer)::text='' OR lower(COALESCE(f.manufacturer,''))=lower(sqlc.arg(manufacturer)::text))
  AND (NOT sqlc.arg(consumable)::boolean OR (f.id IS NOT NULL AND s.lifecycle='active'));

-- name: CountMaterialFills :one
SELECT count(*) FROM filament_spool_fills WHERE material_id=sqlc.arg(material_id);

-- name: UpdateFilamentSpool :one
UPDATE filament_spools SET kind=sqlc.arg(kind), label=sqlc.narg(label),
    tare_weight_g=sqlc.narg(tare_weight_g), acquired_on=sqlc.narg(acquired_on), acquisition_reference=sqlc.narg(acquisition_reference),
    storage_location=sqlc.narg(storage_location), notes=sqlc.narg(notes), lifecycle=sqlc.arg(lifecycle), archived_at=sqlc.narg(archived_at),
    version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND version=sqlc.arg(expected_version)
RETURNING *;

-- name: BumpFilamentSpoolVersion :one
UPDATE filament_spools SET version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND version=sqlc.arg(expected_version) RETURNING *;

-- name: ArchiveFilamentSpool :one
UPDATE filament_spools SET lifecycle='archived', archived_at=sqlc.arg(archived_at), version=version+1, updated_at=now()
WHERE id=sqlc.arg(id) AND version=sqlc.arg(expected_version) RETURNING *;

-- name: UnmountFilamentSpool :execrows
UPDATE printer_spool_assignments SET unmounted_at=GREATEST(sqlc.arg(unmounted_at)::timestamptz, mounted_at + interval '1 microsecond'),
    unmounted_by_account_id=sqlc.narg(actor_account_id)
WHERE spool_id=sqlc.arg(spool_id) AND unmounted_at IS NULL;

-- name: AddFilamentSpoolIdentifier :one
INSERT INTO filament_spool_identifiers (id, spool_id, fill_id, kind, value)
VALUES (sqlc.arg(id), sqlc.arg(spool_id), sqlc.arg(fill_id), sqlc.arg(kind), sqlc.arg(value)) RETURNING *;

-- name: DeleteFilamentSpoolIdentifier :execrows
DELETE FROM filament_spool_identifiers WHERE id=sqlc.arg(id) AND spool_id=sqlc.arg(spool_id) AND retired_at IS NULL;

-- name: ListFilamentSpoolIdentifiers :many
SELECT * FROM filament_spool_identifiers WHERE spool_id=sqlc.arg(spool_id) AND retired_at IS NULL ORDER BY kind, id;

-- name: ListRetiredFilamentSpoolIdentifiers :many
SELECT * FROM filament_spool_identifiers WHERE spool_id=sqlc.arg(spool_id) AND retired_at IS NOT NULL ORDER BY fill_id, kind, id;

-- name: RetireFillIdentifiers :exec
UPDATE filament_spool_identifiers SET retired_at=sqlc.arg(retired_at) WHERE fill_id=sqlc.arg(fill_id) AND retired_at IS NULL;

-- name: FindFilamentSpoolByIdentifier :one
SELECT spool_id FROM filament_spool_identifiers WHERE kind=sqlc.arg(kind) AND lower(value)=lower(sqlc.arg(value)) AND retired_at IS NULL;

-- name: FilamentSpoolIdentifierInUse :one
SELECT EXISTS(SELECT 1 FROM filament_spool_identifiers WHERE kind=sqlc.arg(kind) AND lower(value)=lower(sqlc.arg(value)) AND retired_at IS NULL);

-- name: FilamentSpoolMounted :one
SELECT EXISTS(SELECT 1 FROM printer_spool_assignments WHERE spool_id=sqlc.arg(spool_id) AND unmounted_at IS NULL);

-- name: InsertSpoolInventoryTransaction :one
INSERT INTO inventory_transactions (id, material_id, kind, quantity_delta, unit_acquisition_cost, inventory_value_delta,
    total_purchase_price, occurred_at, supplier, note, adjustment_reason, run_usage_id, actor_account_id,
    spool_id, fill_id, spool_display_id, fill_number, purchase_reference)
VALUES (sqlc.arg(id), sqlc.arg(material_id), sqlc.arg(kind), sqlc.arg(quantity_delta), sqlc.arg(unit_acquisition_cost),
    sqlc.arg(inventory_value_delta), sqlc.narg(total_purchase_price), sqlc.arg(occurred_at), sqlc.narg(supplier),
    sqlc.narg(note), sqlc.narg(adjustment_reason), sqlc.narg(run_usage_id), sqlc.narg(actor_account_id),
    sqlc.arg(spool_id), sqlc.arg(fill_id), sqlc.arg(spool_display_id), sqlc.arg(fill_number), sqlc.narg(purchase_reference))
RETURNING *;

-- name: InsertSpoolTransfer :one
INSERT INTO inventory_transactions (id, material_id, kind, quantity_delta, unit_acquisition_cost, inventory_value_delta,
    occurred_at, note, adjustment_reason, actor_account_id, from_spool_id, from_fill_id, from_spool_display_id, from_fill_number,
    to_spool_id, to_fill_id, to_spool_display_id, to_fill_number, transfer_quantity)
VALUES (sqlc.arg(id), sqlc.arg(material_id), 'spool_transfer', 0, 0, 0, sqlc.arg(occurred_at), sqlc.narg(note),
    sqlc.narg(adjustment_reason), sqlc.narg(actor_account_id), sqlc.narg(from_spool_id), sqlc.narg(from_fill_id),
    sqlc.narg(from_spool_display_id), sqlc.narg(from_fill_number), sqlc.narg(to_spool_id), sqlc.narg(to_fill_id),
    sqlc.narg(to_spool_display_id), sqlc.narg(to_fill_number), sqlc.arg(transfer_quantity))
RETURNING *;

-- name: ListFilamentSpoolTransactions :many
SELECT t.*, j.id AS machine_job_id, j.display_id AS machine_job_display_id,
       pe.first_name AS actor_first_name, pe.last_name AS actor_last_name
FROM inventory_transactions t
LEFT JOIN accounts ac ON ac.id = t.actor_account_id
LEFT JOIN people pe ON pe.id = ac.person_id
LEFT JOIN machine_run_usages u ON u.id=t.run_usage_id
LEFT JOIN machine_runs ur ON ur.id=u.run_id
LEFT JOIN machine_jobs j ON j.id=ur.job_id AND j.deleted_at IS NULL
WHERE t.spool_id=sqlc.arg(spool_id) OR t.from_spool_id=sqlc.arg(spool_id) OR t.to_spool_id=sqlc.arg(spool_id)
ORDER BY t.occurred_at DESC, t.id DESC
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountFilamentSpoolTransactions :one
SELECT count(*) FROM inventory_transactions
WHERE spool_id=sqlc.arg(spool_id) OR from_spool_id=sqlc.arg(spool_id) OR to_spool_id=sqlc.arg(spool_id);

-- name: AllocatedMaterialQuantity :one
SELECT COALESCE(sum(
        COALESCE((SELECT sum(t.quantity_delta) FROM inventory_transactions t WHERE t.fill_id=f.id), 0::numeric)
        + COALESCE((SELECT sum(t.transfer_quantity) FROM inventory_transactions t WHERE t.to_fill_id=f.id), 0::numeric)
        - COALESCE((SELECT sum(t.transfer_quantity) FROM inventory_transactions t WHERE t.from_fill_id=f.id), 0::numeric)), 0)::numeric
FROM filament_spool_fills f
WHERE f.material_id=sqlc.arg(material_id) AND f.closed_at IS NULL;

-- name: ListFilamentSpoolCleanupCandidates :many
SELECT s.id, s.display_id, s.label, s.archived_at
FROM filament_spools s
WHERE s.kind='single_use' AND s.lifecycle='archived' AND s.archived_at < sqlc.arg(cutoff)::timestamptz
  AND NOT EXISTS(SELECT 1 FROM filament_spool_fills f WHERE f.spool_id=s.id AND f.closed_at IS NULL)
ORDER BY s.archived_at, s.id;

-- name: LockFilamentSpoolCleanupCandidates :many
SELECT s.id, s.display_id, s.label, s.archived_at
FROM filament_spools s
WHERE s.id = ANY(sqlc.arg(ids)::uuid[]) AND s.kind='single_use' AND s.lifecycle='archived' AND s.archived_at < sqlc.arg(cutoff)::timestamptz
  AND NOT EXISTS(SELECT 1 FROM filament_spool_fills f WHERE f.spool_id=s.id AND f.closed_at IS NULL)
ORDER BY s.id
FOR UPDATE OF s;

-- name: DeleteFilamentSpool :execrows
DELETE FROM filament_spools WHERE id=sqlc.arg(id);

-- name: NextMachineJobSequence :one
SELECT nextval('machine_job_display_sequence')::bigint;

-- name: NextMachineRunSequence :one
SELECT nextval('machine_run_display_sequence')::bigint;

-- name: CreateMachineJob :one
INSERT INTO machine_jobs (id, display_id, machine_id, customer_person_id, customer_organization_id, operator_person_id, title, notes)
VALUES (sqlc.arg(id), sqlc.arg(display_id), sqlc.arg(machine_id), sqlc.narg(customer_person_id), sqlc.narg(customer_organization_id),
        sqlc.narg(operator_person_id), sqlc.narg(title), sqlc.narg(notes))
RETURNING *;

-- name: GetMachineJobBase :one
SELECT * FROM machine_jobs WHERE id = sqlc.arg(id) AND deleted_at IS NULL;

-- name: GetArtifactReference :one
SELECT id, encode(sha256, 'hex')::text AS sha256, parser_status
FROM print_artifacts WHERE id = sqlc.arg(id);

-- name: GetMachineJobForUpdate :one
SELECT * FROM machine_jobs WHERE id = sqlc.arg(id) AND deleted_at IS NULL FOR UPDATE;

-- name: GetMachineJobRunSummary :one
SELECT job_id, run_count, started_at, ended_at, expected_end_at, running, runtime_seconds, COALESCE(derived_outcome, 'unknown')::text AS derived_outcome
FROM machine_job_run_summaries WHERE job_id = sqlc.arg(job_id);

-- name: InsertRunUsage :one
INSERT INTO machine_run_usages (id, run_id, material_id, spool_id, fill_id, spool_display_id, fill_number, ownership, external_material_name, quantity_basis, quantity, source_printer_event_id,
    estimation_method, calculation_version, estimate_quality, report_revision, staff_corrected)
VALUES (sqlc.arg(id), sqlc.arg(run_id), sqlc.narg(material_id), sqlc.narg(spool_id), sqlc.narg(fill_id), sqlc.narg(spool_display_id), sqlc.narg(fill_number), sqlc.arg(ownership),
    sqlc.narg(external_material_name), sqlc.arg(quantity_basis), sqlc.arg(quantity), sqlc.narg(source_printer_event_id),
    sqlc.narg(estimation_method), sqlc.narg(calculation_version), sqlc.narg(estimate_quality), sqlc.narg(report_revision), sqlc.arg(staff_corrected)) RETURNING *;

-- name: ListRunUsagesForRuns :many
SELECT u.*, COALESCE(m.name, u.external_material_name) AS material_name,
       m.material_type_id, COALESCE(mt.name, 'External') AS material_type_name, COALESCE(m.unit, 'g') AS unit
FROM machine_run_usages u
LEFT JOIN materials m ON m.id = u.material_id
LEFT JOIN material_types mt ON mt.id = m.material_type_id
WHERE u.run_id = ANY(sqlc.arg(run_ids)::uuid[]) AND u.active
ORDER BY lower(COALESCE(m.name, u.external_material_name)), u.id;

-- name: ListLatestReportedUsageItemsForRuns :many
SELECT i.* FROM machine_run_reported_usage_items i
WHERE i.run_id = ANY(sqlc.arg(run_ids)::uuid[])
  AND i.report_revision = (SELECT max(x.report_revision) FROM machine_run_reported_usage_items x WHERE x.run_id = i.run_id)
ORDER BY i.run_id, i.line_number;

-- name: ListActiveRunUsagesForUpdate :many
SELECT * FROM machine_run_usages WHERE run_id = sqlc.arg(run_id) AND active
ORDER BY material_id NULLS LAST, spool_id NULLS LAST, id FOR UPDATE;

-- name: GetRunUsageProvenance :one
-- Whether staff ever set the run's usage, whether a report was applied, and
-- whether a machine report is currently active.
SELECT
    EXISTS (SELECT 1 FROM machine_run_usages u WHERE u.run_id = sqlc.arg(run_id) AND u.source_printer_event_id IS NULL) AS staff_usage,
    EXISTS (SELECT 1 FROM machine_run_usages u WHERE u.run_id = sqlc.arg(run_id) AND u.source_printer_event_id = sqlc.arg(event_id)) AS report_applied,
    EXISTS (SELECT 1 FROM machine_run_usages u WHERE u.run_id = sqlc.arg(run_id)) AS any_usage,
    EXISTS (SELECT 1 FROM machine_run_usages u WHERE u.run_id = sqlc.arg(run_id) AND u.active AND u.source_printer_event_id IS NOT NULL) AS active_machine_usage;

-- name: DeactivateRunUsage :exec
UPDATE machine_run_usages SET active = false, updated_at = now() WHERE id = sqlc.arg(id) AND active;

-- name: CountRunUsages :one
SELECT count(*) FROM machine_run_usages WHERE run_id = sqlc.arg(run_id);

-- name: ListActiveJobRunIDs :many
SELECT id FROM machine_runs WHERE job_id = sqlc.arg(job_id) AND state IS DISTINCT FROM 'replaced' ORDER BY id;

-- name: ListJobRunsForUpdate :many
SELECT * FROM machine_runs WHERE job_id = sqlc.arg(job_id) ORDER BY id FOR UPDATE;

-- name: GetRunForUpdate :one
SELECT * FROM machine_runs WHERE id = sqlc.arg(id) AND deleted_at IS NULL FOR UPDATE;

-- name: GetRunBase :one
SELECT * FROM machine_runs WHERE id = sqlc.arg(id) AND deleted_at IS NULL;

-- name: InsertManualRun :one
INSERT INTO machine_runs (id, display_id, machine_id, source, job_id, started_at, ended_at, outcome, history_complete)
VALUES (sqlc.arg(id), sqlc.arg(display_id), sqlc.arg(machine_id), 'manual', sqlc.arg(job_id), sqlc.arg(started_at), sqlc.arg(ended_at), sqlc.narg(outcome), true)
RETURNING *;

-- name: UpdateManualRunFacts :one
UPDATE machine_runs SET started_at = sqlc.arg(started_at), ended_at = sqlc.arg(ended_at), outcome = sqlc.narg(outcome),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND source = 'manual' AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: UpdateRecordedRunOutcome :one
UPDATE machine_runs SET outcome = sqlc.narg(outcome), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND source = 'recorded' AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: BumpRunVersion :one
UPDATE machine_runs SET version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: CancelManualRun :one
UPDATE machine_runs SET ended_at = sqlc.arg(ended_at), state = 'cancelled', outcome = 'cancelled', version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND source = 'manual' AND state IS NULL AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: MarkManualRunReplaced :exec
UPDATE machine_runs SET state = 'replaced', version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND source = 'manual';

-- name: DeleteManualRun :execrows
DELETE FROM machine_runs WHERE id = sqlc.arg(id) AND source = 'manual';

-- name: AssignRunToJob :one
UPDATE machine_runs SET job_id = sqlc.arg(job_id), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND source = 'recorded' AND job_id IS NULL AND machine_id = sqlc.arg(machine_id)
RETURNING *;

-- name: DetachRunFromJob :one
UPDATE machine_runs SET job_id = NULL, version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND source = 'recorded' AND job_id IS NOT NULL
RETURNING *;

-- name: SetRecordedRunOutcomeFromMachine :one
UPDATE machine_runs SET outcome = CASE state WHEN 'finished' THEN 'successful' WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' END,
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND source = 'recorded' AND outcome IS NULL AND state IN ('finished', 'failed', 'cancelled')
RETURNING *;

-- name: ListRuns :many
WITH runs AS (
    SELECT r.id, r.display_id, r.machine_id, m.name AS machine_name, r.source,
           (CASE WHEN r.source = 'manual' THEN COALESCE(r.state, CASE WHEN r.ended_at > sqlc.arg(now)::timestamptz THEN 'running' ELSE 'finished' END)
                 ELSE r.state END)::text AS run_state,
           r.job_id, j.display_id AS job_display_id, j.title AS job_title,
           c.name AS connector_name, r.file_name,
           COALESCE(r.started_at, r.first_observed_at)::timestamptz AS run_started_at, r.ended_at, r.estimated_end_at, r.progress_percent, r.outcome,
           r.reported_quantity_g, r.reported_quantity_basis, r.reported_spool_id, sp.display_id AS spool_display_id,
           mat.id AS material_id, mat.name AS material_name, r.version,
           r.artifact_id, COALESCE(encode(pa.sha256, 'hex'), '')::text AS artifact_sha256, pa.parser_status AS artifact_parser_status,
           EXISTS (SELECT 1 FROM machine_run_usages u WHERE u.run_id = r.id AND u.active AND u.source_printer_event_id IS NOT NULL) AS usages_from_machine
    FROM machine_runs r
    JOIN machines m ON m.id = r.machine_id
    LEFT JOIN machine_jobs j ON j.id = r.job_id
    LEFT JOIN printer_connector_assignments a ON a.id = r.assignment_id
    LEFT JOIN printer_connectors c ON c.id = a.connector_id
    LEFT JOIN filament_spools sp ON sp.id = r.reported_spool_id
    LEFT JOIN filament_spool_fills pf ON pf.id = COALESCE(
        (SELECT x.id FROM filament_spool_fills x WHERE x.spool_id = sp.id AND x.filled_at <= COALESCE(r.last_observed_at, r.ended_at) ORDER BY x.fill_number DESC LIMIT 1),
        (SELECT x.id FROM filament_spool_fills x WHERE x.spool_id = sp.id ORDER BY x.fill_number DESC LIMIT 1))
    LEFT JOIN materials mat ON mat.id = pf.material_id
    LEFT JOIN print_artifacts pa ON pa.id = r.artifact_id
    WHERE r.deleted_at IS NULL
      AND (sqlc.narg(run_id)::uuid IS NULL OR r.id = sqlc.narg(run_id)::uuid)
      AND (sqlc.narg(job_id)::uuid IS NULL OR r.job_id = sqlc.narg(job_id)::uuid)
      AND (sqlc.arg(search)::text = '' OR r.display_id ILIKE '%' || sqlc.arg(search)::text || '%' OR r.file_name ILIKE '%' || sqlc.arg(search)::text || '%')
      AND (sqlc.narg(machine_id)::uuid IS NULL OR r.machine_id = sqlc.narg(machine_id)::uuid)
      AND (sqlc.narg(source)::text IS NULL OR r.source = sqlc.narg(source)::text)
      AND (sqlc.narg(assigned)::boolean IS NULL OR (r.job_id IS NOT NULL) = sqlc.narg(assigned)::boolean)
      AND (sqlc.narg(from_time)::timestamptz IS NULL OR COALESCE(r.started_at, r.first_observed_at) >= sqlc.narg(from_time)::timestamptz)
      AND (sqlc.narg(to_time)::timestamptz IS NULL OR COALESCE(r.started_at, r.first_observed_at) < sqlc.narg(to_time)::timestamptz)
)
SELECT *, count(*) OVER ()::bigint AS total FROM runs
WHERE cardinality(sqlc.arg(states)::text[]) = 0 OR run_state = ANY(sqlc.arg(states)::text[])
ORDER BY CASE WHEN sqlc.arg(oldest_first)::boolean THEN run_started_at END ASC,
         CASE WHEN NOT sqlc.arg(oldest_first)::boolean THEN run_started_at END DESC,
         CASE WHEN sqlc.arg(oldest_first)::boolean THEN id END ASC,
         CASE WHEN NOT sqlc.arg(oldest_first)::boolean THEN id END DESC
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: ListRunEvents :many
SELECT id, kind, occurred_at, payload FROM printer_events
WHERE run_id = sqlc.arg(run_id)
  AND kind NOT IN ('slot_observation', 'progress')
ORDER BY occurred_at, id
LIMIT 200;

-- name: ListMachineJobIDs :many
SELECT j.id FROM machine_jobs j
JOIN machines m ON m.id = j.machine_id
LEFT JOIN machine_job_run_summaries s ON s.job_id = j.id
LEFT JOIN people cp ON cp.id = j.customer_person_id
LEFT JOIN organizations co ON co.id = j.customer_organization_id
LEFT JOIN people op ON op.id = j.operator_person_id
WHERE j.deleted_at IS NULL
  AND (sqlc.arg(search)::text = '' OR lower(j.display_id) LIKE '%' || lower(sqlc.arg(search)::text) || '%' OR lower(m.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(cp.first_name || ' ' || cp.last_name, co.name, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(op.first_name || ' ' || op.last_name, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR EXISTS (SELECT 1 FROM machine_run_usages u JOIN machine_runs ur ON ur.id = u.run_id JOIN materials mat ON mat.id = u.material_id
                  WHERE ur.job_id = j.id AND ur.state IS DISTINCT FROM 'replaced' AND u.active AND lower(mat.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'))
  AND (sqlc.narg(machine_id)::uuid IS NULL OR j.machine_id = sqlc.narg(machine_id)::uuid)
  AND (sqlc.narg(customer_id)::uuid IS NULL OR j.customer_person_id = sqlc.narg(customer_id)::uuid OR j.customer_organization_id = sqlc.narg(customer_id)::uuid)
  AND (sqlc.narg(operator_id)::uuid IS NULL OR j.operator_person_id = sqlc.narg(operator_id)::uuid)
  AND (sqlc.narg(material_id)::uuid IS NULL OR EXISTS (SELECT 1 FROM machine_run_usages u JOIN machine_runs ur ON ur.id = u.run_id
                  WHERE ur.job_id = j.id AND ur.state IS DISTINCT FROM 'replaced' AND u.active AND u.material_id = sqlc.narg(material_id)::uuid))
  AND (sqlc.narg(outcome)::text IS NULL OR (CASE WHEN s.running THEN 'unknown' ELSE COALESCE(j.outcome_override, s.derived_outcome, 'unknown') END) = sqlc.narg(outcome)::text)
  AND (sqlc.narg(from_time)::timestamptz IS NULL OR s.started_at >= sqlc.narg(from_time)::timestamptz)
  AND (sqlc.narg(to_time)::timestamptz IS NULL OR s.started_at < sqlc.narg(to_time)::timestamptz)
ORDER BY s.started_at DESC NULLS LAST, j.id DESC
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountMachineJobs :one
SELECT count(*) FROM machine_jobs j
JOIN machines m ON m.id = j.machine_id
LEFT JOIN machine_job_run_summaries s ON s.job_id = j.id
LEFT JOIN people cp ON cp.id = j.customer_person_id
LEFT JOIN organizations co ON co.id = j.customer_organization_id
LEFT JOIN people op ON op.id = j.operator_person_id
WHERE j.deleted_at IS NULL
  AND (sqlc.arg(search)::text = '' OR lower(j.display_id) LIKE '%' || lower(sqlc.arg(search)::text) || '%' OR lower(m.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(cp.first_name || ' ' || cp.last_name, co.name, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(op.first_name || ' ' || op.last_name, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR EXISTS (SELECT 1 FROM machine_run_usages u JOIN machine_runs ur ON ur.id = u.run_id JOIN materials mat ON mat.id = u.material_id
                  WHERE ur.job_id = j.id AND ur.state IS DISTINCT FROM 'replaced' AND u.active AND lower(mat.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'))
  AND (sqlc.narg(machine_id)::uuid IS NULL OR j.machine_id = sqlc.narg(machine_id)::uuid)
  AND (sqlc.narg(customer_id)::uuid IS NULL OR j.customer_person_id = sqlc.narg(customer_id)::uuid OR j.customer_organization_id = sqlc.narg(customer_id)::uuid)
  AND (sqlc.narg(operator_id)::uuid IS NULL OR j.operator_person_id = sqlc.narg(operator_id)::uuid)
  AND (sqlc.narg(material_id)::uuid IS NULL OR EXISTS (SELECT 1 FROM machine_run_usages u JOIN machine_runs ur ON ur.id = u.run_id
                  WHERE ur.job_id = j.id AND ur.state IS DISTINCT FROM 'replaced' AND u.active AND u.material_id = sqlc.narg(material_id)::uuid))
  AND (sqlc.narg(outcome)::text IS NULL OR (CASE WHEN s.running THEN 'unknown' ELSE COALESCE(j.outcome_override, s.derived_outcome, 'unknown') END) = sqlc.narg(outcome)::text)
  AND (sqlc.narg(from_time)::timestamptz IS NULL OR s.started_at >= sqlc.narg(from_time)::timestamptz)
  AND (sqlc.narg(to_time)::timestamptz IS NULL OR s.started_at < sqlc.narg(to_time)::timestamptz);

-- name: UpdateMachineJobFacts :one
-- The runs of the job move with it in the same statement: the composite
-- foreign key (job_id, machine_id) is checked at the end of the statement.
WITH moved AS (
    UPDATE machine_runs SET machine_id = sqlc.arg(machine_id), updated_at = now()
    WHERE job_id = sqlc.arg(id) AND machine_id <> sqlc.arg(machine_id)
    RETURNING id
)
UPDATE machine_jobs SET machine_id = sqlc.arg(machine_id),
    customer_person_id = sqlc.narg(customer_person_id), customer_organization_id = sqlc.narg(customer_organization_id),
    operator_person_id = sqlc.arg(operator_person_id), outcome_override = sqlc.narg(outcome_override), title = sqlc.narg(title), notes = sqlc.narg(notes),
    version = version + 1, updated_at = now()
WHERE machine_jobs.id = sqlc.arg(id) AND machine_jobs.version = sqlc.arg(expected_version)
RETURNING *;

-- name: CountJobRecordedRuns :one
SELECT count(*) FROM machine_runs WHERE job_id = sqlc.arg(job_id) AND source = 'recorded';

-- name: BumpMachineJobVersion :one
UPDATE machine_jobs SET version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: CreatePricingSnapshot :one
INSERT INTO machine_job_pricing_snapshots (id, machine_job_id, revision, pricing_group_id, pricing_group_name, reason,
    complete, calculated_amount, captured_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(machine_job_id), sqlc.arg(revision), sqlc.narg(pricing_group_id), sqlc.arg(pricing_group_name),
    sqlc.arg(reason), sqlc.arg(complete), sqlc.narg(calculated_amount), sqlc.narg(captured_by_account_id)) RETURNING *;

-- name: InsertPricingSnapshotRule :one
INSERT INTO machine_job_pricing_snapshot_rules (id, snapshot_id, source_rule_id, kind, label, selector, material_type_id, measure, block_size, unit, rate, missing)
VALUES (sqlc.arg(id), sqlc.arg(snapshot_id), sqlc.narg(source_rule_id), sqlc.arg(kind), sqlc.arg(label), sqlc.arg(selector), sqlc.narg(material_type_id),
    sqlc.narg(measure), sqlc.narg(block_size), sqlc.arg(unit), sqlc.narg(rate), sqlc.arg(missing)) RETURNING *;

-- name: GetPricingSnapshot :one
SELECT * FROM machine_job_pricing_snapshots WHERE id = sqlc.arg(id);

-- name: ListPricingSnapshotRules :many
SELECT * FROM machine_job_pricing_snapshot_rules WHERE snapshot_id = sqlc.arg(snapshot_id) ORDER BY kind, label, id;

-- name: NextPricingSnapshotRevision :one
SELECT COALESCE(max(revision), 0)::integer + 1 FROM machine_job_pricing_snapshots WHERE machine_job_id = sqlc.arg(machine_job_id);

-- name: ActivatePricingSnapshot :one
UPDATE machine_jobs SET active_pricing_snapshot_id = sqlc.arg(snapshot_id), pricing_status = sqlc.arg(pricing_status),
    calculated_price = sqlc.narg(calculated_price), effective_price = sqlc.narg(effective_price), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: RecalculateMachineJobPrice :one
UPDATE machine_jobs SET pricing_status = sqlc.arg(pricing_status), calculated_price = sqlc.narg(calculated_price),
    effective_price = sqlc.narg(effective_price), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: RefreshMachineJobPrice :one
-- Keeps the price of a running job current without bumping its version.
UPDATE machine_jobs SET pricing_status = sqlc.arg(pricing_status), calculated_price = sqlc.narg(calculated_price),
    effective_price = sqlc.narg(effective_price), updated_at = now()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: SetMachineJobPriceAdjustment :one
UPDATE machine_jobs SET price_adjustment_kind = sqlc.arg(kind), price_adjustment_value = sqlc.arg(value),
    price_adjustment_reason = sqlc.arg(reason), price_adjusted_by_account_id = sqlc.arg(actor_account_id),
    price_adjusted_at = sqlc.arg(adjusted_at), effective_price = sqlc.narg(effective_price), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: ClearMachineJobPriceAdjustment :one
UPDATE machine_jobs SET price_adjustment_kind = NULL, price_adjustment_value = NULL, price_adjustment_reason = NULL,
    price_adjusted_by_account_id = NULL, price_adjusted_at = NULL, effective_price = calculated_price,
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: CountOverviewJobs :one
SELECT count(*) FILTER (WHERE s.started_at >= date_trunc('day', now()))::bigint AS jobs_today,
       count(*) FILTER (WHERE s.started_at >= date_trunc('week', now()))::bigint AS jobs_this_week,
       count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM order_job_claims c WHERE c.machine_job_id=j.id))::bigint AS unassigned_jobs,
       COALESCE(sum(j.effective_price) FILTER (WHERE NOT EXISTS(SELECT 1 FROM order_job_claims c WHERE c.machine_job_id=j.id)), 0)::numeric AS unassigned_estimated_amount,
       count(*) FILTER (WHERE s.started_at >= date_trunc('week', now()) AND NOT s.running AND COALESCE(j.outcome_override, s.derived_outcome) IN ('failed', 'partial_failure'))::bigint AS failed_or_partial_this_week
FROM machine_jobs j
LEFT JOIN machine_job_run_summaries s ON s.job_id = j.id
WHERE j.deleted_at IS NULL;

-- name: ListRecentJobIDs :many
SELECT j.id FROM machine_jobs j
LEFT JOIN machine_job_run_summaries s ON s.job_id = j.id
WHERE j.deleted_at IS NULL
ORDER BY s.started_at DESC NULLS LAST, j.id DESC LIMIT sqlc.arg(page_limit);

-- name: ListLowStockMaterialIDs :many
SELECT m.id FROM materials m JOIN material_balances b ON b.material_id = m.id
WHERE m.active AND (b.quantity = 0 OR (m.low_stock_threshold IS NOT NULL AND b.quantity <= m.low_stock_threshold))
ORDER BY b.quantity = 0 DESC, b.quantity, lower(m.name), m.id LIMIT sqlc.arg(page_limit);

-- name: CountLowStockMaterials :one
SELECT count(*) FROM materials m JOIN material_balances b ON b.material_id = m.id
WHERE m.active AND (b.quantity = 0 OR (m.low_stock_threshold IS NOT NULL AND b.quantity <= m.low_stock_threshold));

-- name: OverviewDailyActivity :many
SELECT day::date AS activity_date, count(s.job_id)::bigint AS job_count
FROM generate_series(date_trunc('day', now()) - interval '6 days', date_trunc('day', now()), interval '1 day') day
LEFT JOIN machine_job_run_summaries s ON s.started_at >= day AND s.started_at < day + interval '1 day'
GROUP BY day ORDER BY day;

-- name: StatisticMaterialUsage :many
SELECT mt.id::text AS key, mt.name AS label, COALESCE(-sum(t.quantity_delta), 0)::numeric AS value
FROM inventory_transactions t JOIN materials m ON m.id = t.material_id JOIN material_types mt ON mt.id = m.material_type_id
WHERE (t.kind IN ('machine_run_consumption', 'manual_consumption') OR (t.kind = 'adjustment' AND t.adjustment_reason = 'job_corrected'))
  AND t.occurred_at >= sqlc.arg(from_time) AND t.occurred_at < sqlc.arg(to_time)
GROUP BY mt.id, mt.name ORDER BY lower(mt.name), mt.id;

-- name: StatisticMachineRuntime :many
SELECT m.id::text AS key, m.name AS label, COALESCE(sum(rt.seconds) / 3600.0, 0)::numeric AS value
FROM machines m
LEFT JOIN machine_jobs j ON j.machine_id = m.id AND j.deleted_at IS NULL
LEFT JOIN machine_job_run_summaries s ON s.job_id = j.id AND s.started_at >= sqlc.arg(from_time) AND s.started_at < sqlc.arg(to_time)
LEFT JOIN LATERAL (
    SELECT sum(GREATEST(EXTRACT(EPOCH FROM (LEAST(CASE WHEN r.source = 'manual' THEN r.ended_at ELSE COALESCE(r.ended_at, sqlc.arg(now)::timestamptz) END, sqlc.arg(now)::timestamptz)
                                            - COALESCE(r.started_at, r.first_observed_at))), 0)) AS seconds
    FROM machine_runs r WHERE r.job_id = j.id AND r.state IS DISTINCT FROM 'replaced' AND s.job_id IS NOT NULL
) rt ON true
GROUP BY m.id, m.name ORDER BY value DESC, lower(m.name);

-- name: StatisticMachineJobCounts :many
SELECT m.id::text AS key, m.name AS label, count(s.job_id)::numeric AS value
FROM machines m
LEFT JOIN machine_jobs j ON j.machine_id = m.id AND j.deleted_at IS NULL
LEFT JOIN machine_job_run_summaries s ON s.job_id = j.id AND s.started_at >= sqlc.arg(from_time) AND s.started_at < sqlc.arg(to_time)
GROUP BY m.id, m.name ORDER BY value DESC, lower(m.name);

-- name: StatisticAcquisitionCost :many
SELECT to_char(date_trunc('month', occurred_at), 'YYYY-MM') AS label, COALESCE(-sum(inventory_value_delta) FILTER (WHERE inventory_value_delta < 0), 0)::numeric AS value
FROM inventory_transactions WHERE occurred_at >= sqlc.arg(from_time) AND occurred_at < sqlc.arg(to_time)
GROUP BY date_trunc('month', occurred_at) ORDER BY date_trunc('month', occurred_at);

-- name: StatisticCustomerCharges :many
SELECT to_char(date_trunc('month', s.started_at), 'YYYY-MM') AS label, COALESCE(sum(j.effective_price), 0)::numeric AS value
FROM machine_jobs j JOIN machine_job_run_summaries s ON s.job_id = j.id
WHERE s.started_at >= sqlc.arg(from_time) AND s.started_at < sqlc.arg(to_time)
GROUP BY date_trunc('month', s.started_at) ORDER BY date_trunc('month', s.started_at);

-- name: StatisticAdjustmentLoss :many
SELECT to_char(date_trunc('month', occurred_at), 'YYYY-MM') AS label, COALESCE(-sum(quantity_delta) FILTER (WHERE quantity_delta < 0), 0)::numeric AS value
FROM inventory_transactions WHERE kind IN ('adjustment', 'disposal') AND occurred_at >= sqlc.arg(from_time) AND occurred_at < sqlc.arg(to_time)
GROUP BY date_trunc('month', occurred_at) ORDER BY date_trunc('month', occurred_at);

-- name: StatisticMachineFailureRates :many
SELECT m.id::text AS key, m.name AS label,
       COALESCE(round(100.0 * count(s.job_id) FILTER (WHERE NOT s.running AND COALESCE(j.outcome_override, s.derived_outcome) IN ('failed', 'partial_failure')) / NULLIF(count(s.job_id), 0), 2), 0)::numeric AS value
FROM machines m
LEFT JOIN machine_jobs j ON j.machine_id = m.id AND j.deleted_at IS NULL
LEFT JOIN machine_job_run_summaries s ON s.job_id = j.id AND s.started_at >= sqlc.arg(from_time) AND s.started_at < sqlc.arg(to_time)
GROUP BY m.id, m.name ORDER BY value DESC, lower(m.name);

-- name: ListWorkItems :many
WITH items AS (
    SELECT 'run'::text AS kind, r.id, r.display_id, NULL::text AS title, r.file_name,
           1::integer AS run_count,
           r.machine_id, m.name AS machine_name,
           NULL::uuid AS customer_id, NULL::text AS customer_kind, NULL::text AS customer_name, NULL::text AS customer_organization_kind,
           NULL::uuid AS customer_pricing_group_id, NULL::text AS customer_pricing_group_name, 0::bigint AS customer_pricing_group_assignment_version,
           NULL::uuid AS operator_person_id, NULL::text AS operator_name,
           (CASE WHEN r.state = 'running' THEN 'running_unassigned' ELSE 'unassigned' END)::text AS status,
           'recorded'::text AS source,
           COALESCE(r.started_at, r.first_observed_at)::timestamptz AS started_at,
           COALESCE(r.ended_at, r.estimated_end_at) AS ends_at, r.estimated_end_at, r.progress_percent,
           NULL::numeric AS effective_price,
           NULL::text AS billing_state, NULL::uuid AS billing_order_id, NULL::text AS billing_order_reference,
           r.version,
           (r.display_id || ' ' || COALESCE(r.file_name, ''))::text AS search_text,
           COALESCE(r.file_name, r.display_id)::text AS name_key,
           EXISTS (SELECT 1 FROM machine_run_usages u WHERE u.run_id = r.id AND u.active AND u.material_id = ANY(sqlc.arg(material_ids)::uuid[]))
               OR COALESCE(pf.material_id = ANY(sqlc.arg(material_ids)::uuid[]), false) AS material_match
    FROM machine_runs r
    JOIN machines m ON m.id = r.machine_id
    LEFT JOIN filament_spool_fills pf ON pf.id = COALESCE(
        (SELECT x.id FROM filament_spool_fills x WHERE x.spool_id = r.reported_spool_id AND x.filled_at <= r.last_observed_at ORDER BY x.fill_number DESC LIMIT 1),
        (SELECT x.id FROM filament_spool_fills x WHERE x.spool_id = r.reported_spool_id ORDER BY x.fill_number DESC LIMIT 1))
    WHERE r.job_id IS NULL AND r.source = 'recorded' AND r.deleted_at IS NULL
    UNION ALL
    SELECT 'job'::text, j.id, j.display_id, j.title, lr.file_name,
           COALESCE(s.run_count, 0)::integer,
           j.machine_id, m.name,
           COALESCE(j.customer_person_id, j.customer_organization_id),
           (CASE WHEN j.customer_person_id IS NOT NULL THEN 'person' WHEN j.customer_organization_id IS NOT NULL THEN 'organization' END)::text,
           COALESCE(btrim(cp.first_name || ' ' || cp.last_name), co.name)::text,
           co.kind,
           cog.id,
           cog.name,
           COALESCE(coa.version, 0)::bigint,
           j.operator_person_id, btrim(op.first_name || ' ' || op.last_name)::text,
           (CASE WHEN COALESCE(s.running, false) THEN 'running'
                 ELSE COALESCE(j.outcome_override, NULLIF(s.derived_outcome, 'unknown'), 'needs_outcome') END)::text,
           (CASE WHEN EXISTS (SELECT 1 FROM machine_runs rr WHERE rr.job_id = j.id AND rr.source = 'recorded') THEN 'recorded' ELSE 'manual' END)::text,
           s.started_at, COALESCE(s.ended_at, s.expected_end_at), CASE WHEN s.running THEN s.expected_end_at END,
           CASE WHEN s.running THEN lr.progress_percent END,
           j.effective_price,
           (CASE WHEN oc.machine_job_id IS NOT NULL THEN
                    (CASE WHEN oi.source_job_version IS NOT NULL AND oi.source_job_version <> j.version THEN 'order_outdated' ELSE 'on_order' END)
                 WHEN j.pricing_status = 'pending' THEN 'pending'
                 WHEN j.pricing_status = 'incomplete' THEN 'price_incomplete'
                 ELSE 'not_on_order' END)::text,
           oo.id, oo.reference,
           j.version,
           COALESCE((SELECT string_agg(sr.display_id || ' ' || COALESCE(sr.file_name, ''), ' ') FROM machine_runs sr WHERE sr.job_id = j.id), '')::text,
           COALESCE(j.title, lr.file_name, j.display_id)::text,
           EXISTS (SELECT 1 FROM machine_run_usages u JOIN machine_runs ur ON ur.id = u.run_id
                   WHERE ur.job_id = j.id AND ur.state IS DISTINCT FROM 'replaced' AND u.active AND u.material_id = ANY(sqlc.arg(material_ids)::uuid[]))
    FROM machine_jobs j
    JOIN machines m ON m.id = j.machine_id
    LEFT JOIN machine_job_run_summaries s ON s.job_id = j.id
    LEFT JOIN LATERAL (
        SELECT lrr.file_name, lrr.progress_percent FROM machine_runs lrr
        WHERE lrr.job_id = j.id AND lrr.source = 'recorded' AND lrr.state IS DISTINCT FROM 'replaced'
        ORDER BY COALESCE(lrr.started_at, lrr.first_observed_at) DESC, lrr.id DESC LIMIT 1
    ) lr ON true
    LEFT JOIN people cp ON cp.id = j.customer_person_id
    LEFT JOIN organizations co ON co.id = j.customer_organization_id
    LEFT JOIN organization_pricing_group_assignments coa ON coa.organization_id = co.id
    LEFT JOIN pricing_groups cog ON cog.id = coa.pricing_group_id
    LEFT JOIN people op ON op.id = j.operator_person_id
    LEFT JOIN order_job_claims oc ON oc.machine_job_id = j.id
    LEFT JOIN order_items oi ON oi.id = oc.order_item_id
    LEFT JOIN orders oo ON oo.id = oi.order_id
    WHERE j.deleted_at IS NULL
)
SELECT i.kind, i.id, i.display_id, i.title, i.file_name, i.run_count, i.machine_id, i.machine_name,
       i.customer_id, i.customer_kind, i.customer_name, i.customer_organization_kind, i.customer_pricing_group_id,
       i.customer_pricing_group_name, i.customer_pricing_group_assignment_version, i.operator_person_id, i.operator_name,
       i.status, i.source, i.started_at, i.ends_at, i.estimated_end_at, i.progress_percent, i.effective_price,
       i.billing_state, i.billing_order_id, i.billing_order_reference, i.version,
       count(*) OVER ()::bigint AS total
FROM items i
WHERE (cardinality(sqlc.arg(statuses)::text[]) = 0 OR i.status = ANY(sqlc.arg(statuses)::text[]))
  AND (cardinality(sqlc.arg(machine_ids)::uuid[]) = 0 OR i.machine_id = ANY(sqlc.arg(machine_ids)::uuid[]))
  AND (cardinality(sqlc.arg(sources)::text[]) = 0 OR i.source = ANY(sqlc.arg(sources)::text[]))
  AND (cardinality(sqlc.arg(material_ids)::uuid[]) = 0 OR i.material_match)
  AND (cardinality(sqlc.arg(billing_states)::text[]) = 0 OR i.billing_state = ANY(sqlc.arg(billing_states)::text[]))
  AND (sqlc.narg(customer_id)::uuid IS NULL OR i.customer_id = sqlc.narg(customer_id)::uuid)
  AND (sqlc.narg(operator_person_id)::uuid IS NULL OR i.operator_person_id = sqlc.narg(operator_person_id)::uuid)
  AND (sqlc.narg(from_time)::timestamptz IS NULL OR i.started_at >= sqlc.narg(from_time)::timestamptz)
  AND (sqlc.narg(to_time)::timestamptz IS NULL OR i.started_at < sqlc.narg(to_time)::timestamptz)
  AND (sqlc.arg(search)::text = '' OR i.title ILIKE '%' || sqlc.arg(search)::text || '%' OR i.display_id ILIKE '%' || sqlc.arg(search)::text || '%'
       OR i.search_text ILIKE '%' || sqlc.arg(search)::text || '%')
ORDER BY
    CASE WHEN sqlc.arg(active_order)::boolean THEN (CASE i.status WHEN 'running' THEN 1 WHEN 'running_unassigned' THEN 2 WHEN 'unassigned' THEN 3 ELSE 4 END) END ASC,
    CASE WHEN sqlc.arg(sort_key)::text = 'startedAt' AND sqlc.arg(sort_direction)::text = 'asc' THEN i.started_at END ASC,
    CASE WHEN sqlc.arg(sort_key)::text = 'startedAt' AND sqlc.arg(sort_direction)::text = 'desc' THEN i.started_at END DESC,
    CASE WHEN sqlc.arg(sort_key)::text = 'name' AND sqlc.arg(sort_direction)::text = 'asc' THEN lower(i.name_key) END ASC,
    CASE WHEN sqlc.arg(sort_key)::text = 'name' AND sqlc.arg(sort_direction)::text = 'desc' THEN lower(i.name_key) END DESC,
    CASE WHEN sqlc.arg(sort_key)::text = 'machine' AND sqlc.arg(sort_direction)::text = 'asc' THEN lower(i.machine_name) END ASC,
    CASE WHEN sqlc.arg(sort_key)::text = 'machine' AND sqlc.arg(sort_direction)::text = 'desc' THEN lower(i.machine_name) END DESC,
    CASE WHEN sqlc.arg(sort_key)::text = 'customer' AND sqlc.arg(sort_direction)::text = 'asc' THEN lower(i.customer_name) END ASC NULLS LAST,
    CASE WHEN sqlc.arg(sort_key)::text = 'customer' AND sqlc.arg(sort_direction)::text = 'desc' THEN lower(i.customer_name) END DESC NULLS LAST,
    CASE WHEN sqlc.arg(sort_key)::text = 'price' AND sqlc.arg(sort_direction)::text = 'asc' THEN i.effective_price END ASC NULLS LAST,
    CASE WHEN sqlc.arg(sort_key)::text = 'price' AND sqlc.arg(sort_direction)::text = 'desc' THEN i.effective_price END DESC NULLS LAST,
    CASE WHEN sqlc.arg(active_order)::boolean THEN i.started_at END DESC,
    CASE WHEN sqlc.arg(sort_direction)::text = 'asc' THEN i.id END ASC,
    CASE WHEN sqlc.arg(sort_direction)::text = 'desc' THEN i.id END DESC
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: ListRunningMachineNames :many
SELECT DISTINCT name::text AS name FROM (
    SELECT m.name FROM machine_runs r JOIN machines m ON m.id = r.machine_id
    WHERE r.deleted_at IS NULL
      AND ((r.source = 'manual' AND r.state IS NULL AND r.ended_at > sqlc.arg(now)::timestamptz)
           OR (r.source = 'recorded' AND r.state = 'running'))
) running ORDER BY 1;

-- name: ListMachineActivityMachines :many
SELECT id, status FROM machines ORDER BY lower(name), id;

-- name: ListMachineRunningRuns :many
SELECT DISTINCT ON (r.machine_id) r.machine_id, r.id, r.display_id, r.file_name, j.id AS job_id, j.display_id AS job_display_id, j.title AS job_title,
       COALESCE(r.started_at, r.first_observed_at)::timestamptz AS started_at,
       COALESCE(r.ended_at, r.estimated_end_at) AS ends_at
FROM machine_runs r
LEFT JOIN machine_jobs j ON j.id = r.job_id
WHERE r.deleted_at IS NULL
  AND ((r.source = 'manual' AND r.state IS NULL AND r.ended_at > sqlc.arg(now)::timestamptz)
       OR (r.source = 'recorded' AND r.state = 'running'))
ORDER BY r.machine_id, COALESCE(r.started_at, r.first_observed_at) DESC, r.id DESC;

-- name: ListMachineConnectorStates :many
SELECT DISTINCT ON (a.machine_id) a.machine_id, a.runtime_state, a.runtime_error_code, c.last_heartbeat_at
FROM printer_connector_assignments a JOIN printer_connectors c ON c.id = a.connector_id
WHERE a.ended_at IS NULL
ORDER BY a.machine_id, a.activated_at DESC, a.id DESC;

-- name: ListMachineLastJobStarts :many
SELECT j.machine_id, max(s.started_at)::timestamptz AS last_started_at
FROM machine_jobs j JOIN machine_job_run_summaries s ON s.job_id = j.id
WHERE s.started_at <= sqlc.arg(now)::timestamptz GROUP BY j.machine_id;

-- name: StatisticPeriodTotals :one
WITH jobs AS (
    SELECT CASE WHEN s.running THEN 'unknown' ELSE COALESCE(j.outcome_override, s.derived_outcome, 'unknown') END AS outcome, j.effective_price,
           COALESCE((SELECT sum(GREATEST(EXTRACT(EPOCH FROM (LEAST(CASE WHEN r.source = 'manual' THEN r.ended_at ELSE COALESCE(r.ended_at, sqlc.arg(now)::timestamptz) END, sqlc.arg(now)::timestamptz)
                                                                  - COALESCE(r.started_at, r.first_observed_at))), 0))
                     FROM machine_runs r WHERE r.job_id = j.id AND r.state IS DISTINCT FROM 'replaced'), 0) AS seconds
    FROM machine_jobs j JOIN machine_job_run_summaries s ON s.job_id = j.id
    WHERE s.started_at >= sqlc.arg(from_time) AND s.started_at < sqlc.arg(to_time)
), cost AS (
    SELECT COALESCE(-sum(inventory_value_delta) FILTER (WHERE kind IN ('machine_run_consumption', 'manual_consumption') OR (kind = 'adjustment' AND adjustment_reason = 'job_corrected')), 0) AS material_cost
    FROM inventory_transactions WHERE occurred_at >= sqlc.arg(from_time) AND occurred_at < sqlc.arg(to_time)
)
SELECT (SELECT count(*) FROM jobs)::bigint AS jobs,
       (SELECT round(COALESCE(sum(seconds), 0) / 3600.0, 4) FROM jobs)::numeric AS runtime_hours,
       (SELECT COALESCE(sum(effective_price), 0) FROM jobs)::numeric AS charges,
       (SELECT material_cost FROM cost)::numeric AS material_cost,
       (SELECT COALESCE(round(100.0 * count(*) FILTER (WHERE outcome IN ('failed', 'partial_failure')) / NULLIF(count(*) FILTER (WHERE outcome <> 'unknown'), 0), 2), 0) FROM jobs)::numeric AS failure_rate;

-- name: StatisticMonths :many
WITH months AS (
    SELECT generate_series(date_trunc('month', sqlc.arg(from_time)::timestamptz AT TIME ZONE 'UTC'),
                           date_trunc('month', (sqlc.arg(to_time)::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC'),
                           interval '1 month') AS month_start
), job_charges AS (
    SELECT date_trunc('month', s.started_at AT TIME ZONE 'UTC') AS month_start, sum(j.effective_price) AS charges
    FROM machine_jobs j JOIN machine_job_run_summaries s ON s.job_id = j.id
    WHERE s.started_at >= sqlc.arg(from_time) AND s.started_at < sqlc.arg(to_time)
    GROUP BY 1
), costs AS (
    SELECT date_trunc('month', occurred_at AT TIME ZONE 'UTC') AS month_start,
           -sum(inventory_value_delta) FILTER (WHERE kind IN ('machine_run_consumption', 'manual_consumption') OR (kind = 'adjustment' AND adjustment_reason = 'job_corrected')) AS material_cost,
           -sum(inventory_value_delta) FILTER (WHERE (kind = 'disposal' OR (kind = 'adjustment' AND adjustment_reason <> 'job_corrected')) AND inventory_value_delta < 0) AS losses
    FROM inventory_transactions WHERE occurred_at >= sqlc.arg(from_time) AND occurred_at < sqlc.arg(to_time)
    GROUP BY 1
)
SELECT to_char(m.month_start, 'YYYY-MM')::text AS month,
       COALESCE(jc.charges, 0)::numeric AS charges,
       COALESCE(c.material_cost, 0)::numeric AS material_cost,
       COALESCE(c.losses, 0)::numeric AS losses
FROM months m LEFT JOIN job_charges jc ON jc.month_start = m.month_start LEFT JOIN costs c ON c.month_start = m.month_start
ORDER BY m.month_start;

-- name: StatisticRuntimePoints :many
SELECT date_trunc(sqlc.arg(unit)::text, s.started_at AT TIME ZONE 'UTC')::date AS bucket_start, j.machine_id,
       round(sum(GREATEST(EXTRACT(EPOCH FROM (LEAST(CASE WHEN r.source = 'manual' THEN r.ended_at ELSE COALESCE(r.ended_at, sqlc.arg(now)::timestamptz) END, sqlc.arg(now)::timestamptz)
                                              - COALESCE(r.started_at, r.first_observed_at))), 0)) / 3600.0, 4)::numeric AS hours
FROM machine_jobs j
JOIN machine_job_run_summaries s ON s.job_id = j.id
JOIN machine_runs r ON r.job_id = j.id AND r.state IS DISTINCT FROM 'replaced'
WHERE s.started_at >= sqlc.arg(from_time) AND s.started_at < sqlc.arg(to_time)
GROUP BY 1, 2 ORDER BY 1, 2;

-- name: StatisticMaterialCostByType :many
SELECT mt.id::text AS key, mt.name AS label, (-sum(t.inventory_value_delta))::numeric AS value
FROM inventory_transactions t JOIN materials m ON m.id = t.material_id JOIN material_types mt ON mt.id = m.material_type_id
WHERE (t.kind IN ('machine_run_consumption', 'manual_consumption') OR (t.kind = 'adjustment' AND t.adjustment_reason = 'job_corrected'))
  AND t.occurred_at >= sqlc.arg(from_time) AND t.occurred_at < sqlc.arg(to_time)
GROUP BY mt.id, mt.name ORDER BY lower(mt.name), mt.id;

-- name: StatisticMachineSummaries :many
WITH jobs AS (
    SELECT j.id, j.machine_id, j.effective_price,
           CASE WHEN s.running THEN 'unknown' ELSE COALESCE(j.outcome_override, s.derived_outcome, 'unknown') END AS outcome,
           COALESCE((SELECT sum(GREATEST(EXTRACT(EPOCH FROM (LEAST(CASE WHEN r.source = 'manual' THEN r.ended_at ELSE COALESCE(r.ended_at, sqlc.arg(now)::timestamptz) END, sqlc.arg(now)::timestamptz)
                                                                  - COALESCE(r.started_at, r.first_observed_at))), 0))
                     FROM machine_runs r WHERE r.job_id = j.id AND r.state IS DISTINCT FROM 'replaced'), 0) AS seconds
    FROM machine_jobs j JOIN machine_job_run_summaries s ON s.job_id = j.id
    WHERE s.started_at >= sqlc.arg(from_time) AND s.started_at < sqlc.arg(to_time)
)
SELECT m.id AS machine_id, m.name, mt.name AS machine_type_name, count(j.id)::bigint AS jobs,
       round(COALESCE(sum(j.seconds), 0) / 3600.0, 4)::numeric AS runtime_hours,
       COALESCE(round(100.0 * count(j.id) FILTER (WHERE j.outcome IN ('failed', 'partial_failure')) / NULLIF(count(j.id) FILTER (WHERE j.outcome <> 'unknown'), 0), 2), 0)::numeric AS failure_rate,
       COALESCE(sum(j.effective_price), 0)::numeric AS charges
FROM machines m
JOIN machine_types mt ON mt.id = m.machine_type_id
JOIN jobs j ON j.machine_id = m.id
GROUP BY m.id, m.name, mt.name ORDER BY lower(m.name), m.id;

-- name: JobIsOnOrder :one
-- A job is on an order while an order item that was not removed references it
-- or while it is claimed, whatever the state of the order.
SELECT (EXISTS (SELECT 1 FROM order_job_claims c WHERE c.machine_job_id = sqlc.arg(job_id))
    OR EXISTS (SELECT 1 FROM order_items i WHERE i.source_machine_job_id = sqlc.arg(job_id) AND i.removed_at IS NULL))::boolean AS on_order;

-- name: SoftDeleteMachineJob :one
UPDATE machine_jobs SET deleted_at = sqlc.arg(deleted_at), deleted_by = sqlc.narg(deleted_by), version = version + 1, updated_at = sqlc.arg(deleted_at)
WHERE id = sqlc.arg(id) AND deleted_at IS NULL AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: SoftDeleteMachineRun :exec
-- A deleted run is detached from its job.
UPDATE machine_runs SET deleted_at = sqlc.arg(deleted_at), deleted_by = sqlc.narg(deleted_by), job_id = NULL, version = version + 1, updated_at = sqlc.arg(deleted_at)
WHERE id = sqlc.arg(id) AND deleted_at IS NULL;

-- name: SumRunUsageLedger :one
-- The net quantity and value the ledger holds for a run usage.
SELECT COALESCE(sum(quantity_delta), 0)::numeric AS quantity, COALESCE(sum(inventory_value_delta), 0)::numeric AS value
FROM inventory_transactions WHERE run_usage_id = sqlc.arg(run_usage_id);

-- name: CreateMaterialType :one
INSERT INTO material_types (id, name, unit, kind) VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(unit), sqlc.arg(kind)) RETURNING *;

-- name: InsertMaterialTypeProcess :exec
INSERT INTO material_type_processes (material_type_id, process) VALUES (sqlc.arg(material_type_id), sqlc.arg(process));

-- name: DeleteMaterialTypeProcesses :exec
DELETE FROM material_type_processes WHERE material_type_id = sqlc.arg(material_type_id);

-- name: ListMaterialTypeProcesses :many
SELECT material_type_id, process FROM material_type_processes
WHERE material_type_id = ANY(sqlc.arg(material_type_ids)::uuid[])
ORDER BY material_type_id, process;

-- name: GetMachineProcess :one
SELECT mt.process FROM machines m JOIN machine_types mt ON mt.id = m.machine_type_id WHERE m.id = sqlc.arg(machine_id);

-- name: ListMaterialsOutsideProcess :many
-- Materials of the given ones whose type is not usable for the process.
SELECT m.id, m.name FROM materials m
WHERE m.id = ANY(sqlc.arg(material_ids)::uuid[])
  AND NOT EXISTS (SELECT 1 FROM material_type_processes p WHERE p.material_type_id = m.material_type_id AND p.process = sqlc.arg(process)::text)
ORDER BY lower(m.name), m.id;

-- name: UpsertRunMeasure :exec
INSERT INTO machine_run_measures (run_id, measure, value) VALUES (sqlc.arg(run_id), sqlc.arg(measure), sqlc.arg(value))
ON CONFLICT (run_id, measure) DO UPDATE SET value = EXCLUDED.value;

-- name: DeleteRunMeasures :exec
DELETE FROM machine_run_measures WHERE run_id = sqlc.arg(run_id);

-- name: ListRunMeasuresForRuns :many
SELECT run_id, measure, value FROM machine_run_measures
WHERE run_id = ANY(sqlc.arg(run_ids)::uuid[])
ORDER BY run_id, measure;

-- name: ListMaterialTypes :many
SELECT t.*,
       (SELECT count(*) FROM materials m WHERE m.material_type_id = t.id)::bigint AS material_count,
       (SELECT count(*) FROM pricing_rules r WHERE r.material_type_id = t.id)::bigint AS pricing_rule_count
FROM material_types t
ORDER BY t.active DESC, lower(t.name), t.id;

-- name: GetMaterialType :one
SELECT t.*,
       (SELECT count(*) FROM materials m WHERE m.material_type_id = t.id)::bigint AS material_count,
       (SELECT count(*) FROM pricing_rules r WHERE r.material_type_id = t.id)::bigint AS pricing_rule_count
FROM material_types t WHERE t.id = sqlc.arg(id);

-- name: GetMaterialTypeForUpdate :one
SELECT * FROM material_types WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: GetMaterialTypeForShare :one
SELECT * FROM material_types WHERE id = sqlc.arg(id) FOR SHARE;

-- name: UpdateMaterialType :one
UPDATE material_types SET name = sqlc.arg(name), unit = sqlc.arg(unit), kind = sqlc.arg(kind), active = sqlc.arg(active), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: MaterialTypeIsReferenced :one
-- True while a material or a pricing rule (active or not) uses the type. Pricing
-- snapshots only keep a nullable pointer and their own label text.
SELECT (EXISTS (SELECT 1 FROM materials m WHERE m.material_type_id = sqlc.arg(id)::uuid)
    OR EXISTS (SELECT 1 FROM pricing_rules r WHERE r.material_type_id = sqlc.arg(id)::uuid))::boolean AS referenced;

-- name: DeleteMaterialType :execrows
DELETE FROM material_types WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version);

-- name: ListWorkItemMaterialTotals :many
-- Material of jobs (their runs that are not replaced) and of unassigned runs, summed per material type and unit.
SELECT COALESCE(r.job_id, r.id)::uuid AS item_id, COALESCE(mt.name, 'External')::text AS material_type_name, COALESCE(m.unit, 'g')::text AS unit, sum(u.quantity)::numeric AS quantity
FROM machine_run_usages u
JOIN machine_runs r ON r.id = u.run_id
LEFT JOIN materials m ON m.id = u.material_id
LEFT JOIN material_types mt ON mt.id = m.material_type_id
WHERE u.active AND r.deleted_at IS NULL AND r.state IS DISTINCT FROM 'replaced'
  AND COALESCE(r.job_id, r.id) = ANY(sqlc.arg(item_ids)::uuid[])
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- name: ListWorkItemMeasureTotals :many
SELECT COALESCE(r.job_id, r.id)::uuid AS item_id, me.measure, sum(me.value)::bigint AS value
FROM machine_run_measures me
JOIN machine_runs r ON r.id = me.run_id
WHERE r.deleted_at IS NULL AND r.state IS DISTINCT FROM 'replaced'
  AND COALESCE(r.job_id, r.id) = ANY(sqlc.arg(item_ids)::uuid[])
GROUP BY 1, 2
ORDER BY 1, 2;

-- name: MachineHasActiveWork :one
SELECT EXISTS (
    SELECT 1 FROM machine_jobs j WHERE j.machine_id = sqlc.arg(machine_id) AND j.deleted_at IS NULL
    UNION ALL
    SELECT 1 FROM machine_runs r WHERE r.machine_id = sqlc.arg(machine_id) AND r.deleted_at IS NULL
);

-- name: MachineHasMountedSpool :one
SELECT EXISTS (
    SELECT 1 FROM printer_spool_assignments a
    JOIN printer_slots s ON s.id = a.slot_id
    JOIN printer_input_units u ON u.id = s.input_unit_id
    WHERE u.machine_id = sqlc.arg(machine_id) AND a.unmounted_at IS NULL
);

-- name: MachineHasConnectorAssignments :one
SELECT EXISTS (SELECT 1 FROM printer_connector_assignments WHERE machine_id = sqlc.arg(machine_id));

-- name: BumpConnectorsOfDeletedMachine :exec
-- The connectors drop the machine's assignment on their next configuration pull.
UPDATE printer_connectors SET configuration_revision = configuration_revision + 1, version = version + 1, updated_at = now()
WHERE id IN (SELECT connector_id FROM printer_connector_assignments WHERE machine_id = sqlc.arg(machine_id) AND ended_at IS NULL);

-- name: DeleteMachineErrorOccurrences :exec
DELETE FROM printer_error_occurrences WHERE machine_id = sqlc.arg(machine_id);

-- name: DeleteMachineRunsOfMachine :exec
-- Only tombstoned runs are left at this point; usages, measures and reported items cascade.
DELETE FROM machine_runs WHERE machine_id = sqlc.arg(machine_id);

-- name: DeleteMachineJobsOfMachine :exec
DELETE FROM machine_jobs WHERE machine_id = sqlc.arg(machine_id);

-- name: DeleteMachinePrinterEvents :exec
DELETE FROM printer_events WHERE machine_id = sqlc.arg(machine_id)::uuid;

-- name: DeleteMachineSpoolMountHistory :exec
DELETE FROM printer_spool_assignments WHERE slot_id IN (
    SELECT s.id FROM printer_slots s JOIN printer_input_units u ON u.id = s.input_unit_id WHERE u.machine_id = sqlc.arg(machine_id)
);

-- name: DeleteMachineConnectorAssignments :exec
DELETE FROM printer_connector_assignments WHERE machine_id = sqlc.arg(machine_id);

-- name: DeleteMachine :execrows
-- The printer profile, its input units, slots and live statuses go with it through ON DELETE CASCADE.
DELETE FROM machines WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version);

-- name: CountMaterialsOfType :one
SELECT count(*) FROM materials WHERE material_type_id = sqlc.arg(material_type_id);

-- name: FindMaterialByName :one
SELECT id FROM materials WHERE lower(name) = lower(sqlc.arg(name)::text);

-- name: ListMaterialTypeProcessNames :many
SELECT process FROM material_type_processes WHERE material_type_id = sqlc.arg(material_type_id) ORDER BY process;

-- name: ListInventoryVariantSuggestions :many
-- Distinct variants by frequency, optionally restricted to one material type.
SELECT m.variant::text AS value FROM materials m
WHERE m.variant IS NOT NULL AND (sqlc.narg(material_type_id)::uuid IS NULL OR m.material_type_id = sqlc.narg(material_type_id)::uuid)
GROUP BY m.variant ORDER BY count(*) DESC, lower(m.variant), m.variant
LIMIT 50;

-- name: ListInventoryManufacturerSuggestions :many
SELECT m.manufacturer::text AS value FROM materials m
WHERE m.manufacturer IS NOT NULL
GROUP BY m.manufacturer ORDER BY count(*) DESC, lower(m.manufacturer), m.manufacturer
LIMIT 50;

-- name: ListInventorySupplierSuggestions :many
SELECT t.supplier::text AS value FROM inventory_transactions t
WHERE t.kind = 'purchase' AND t.supplier IS NOT NULL
GROUP BY t.supplier ORDER BY count(*) DESC, lower(t.supplier), t.supplier
LIMIT 50;

-- name: ListInventoryStorageLocationSuggestions :many
SELECT value::text FROM (
    SELECT storage_location AS value FROM materials WHERE storage_location IS NOT NULL
    UNION ALL
    SELECT storage_location FROM filament_spools WHERE storage_location IS NOT NULL
) x
GROUP BY value ORDER BY count(*) DESC, lower(value), value
LIMIT 50;

-- name: CountActivePricingRulesOfMaterialType :one
SELECT count(*) FROM pricing_rules WHERE material_type_id = sqlc.arg(id) AND active;

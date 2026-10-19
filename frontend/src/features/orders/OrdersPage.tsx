import { Button, Tag } from "@carbon/react";
import { keepPreviousData, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { createOrder, listOrders } from "../../api/generated/orders/orders";
import type { Order } from "../../api/generated/models";
import { RefLink } from "../../app/RefLink";
import { useCurrentUser } from "../auth/auth";
import { hasPermission, PermissionId } from "../auth/permissions";
import { PageShell } from "../../app/PageShell";
import { FullPageLoading, ErrorState } from "../../app/PageState";
import { DirectoryTable, useServerTableState, type Column, type Option } from "../machinelogbook/shared/DirectoryTable";
import { FinancialError } from "./shared";
import { financeKeys } from "./operations";
import { formatMoney } from "./formatting";

const PAGE_SIZES = [10, 25, 50, 100];
const STATUS_OPTIONS: Option[] = ["draft", "finalized", "cancelled", "reversed"].map((value) => ({ id: value, label: value }));

const columns: Column<Order>[] = [
  {
    key: "reference", header: "Order",
    render: (o) => (
      <div className="mj-cell-stack">
        <RefLink reference={o.reference} id={o.id} />
        {o.replacedByOrderReference && <span className="mj-secondary">Replaced by <RefLink reference={o.replacedByOrderReference} id={o.replacedByOrderId} /></span>}
        {o.replacesOrderReference && <span className="mj-secondary">Replaces <RefLink reference={o.replacesOrderReference} id={o.replacesOrderId} /></span>}
      </div>
    ),
  },
  { key: "customer", header: "Customer", render: (o) => o.customerName || o.customerKind },
  { key: "status", header: "Lifecycle", render: (o) => <Tag>{o.status}</Tag> },
  { key: "settlement", header: "Settlement", narrow: true, render: (o) => o.settlementState },
  { key: "total", header: "Charge", narrow: true, render: (o) => formatMoney(o.totalAmount) },
  { key: "outstanding", header: "Outstanding", render: (o) => formatMoney(o.outstandingAmount) },
];

export function OrdersPage() {
  const navigate = useNavigate();
  const user = useCurrentUser();
  const client = useQueryClient();
  const table = useServerTableState("", { key: "", direction: "ASC" }, PAGE_SIZES, 25);
  const status = table.url.get("status");
  const filters = {
    page: table.page,
    pageSize: table.pageSize,
    search: table.search || undefined,
    status: status || undefined,
  };
  const query = useQuery({
    placeholderData: keepPreviousData,
    queryKey: [...financeKeys, "list", filters],
    queryFn: () => listOrders(filters),
  });
  const create = useMutation({
    mutationFn: () => createOrder({ fulfillmentMode: "immediate" }),
    onSuccess: async (o) => {
      await client.invalidateQueries({ queryKey: financeKeys });
      navigate(`/orders/${o.id}`);
    },
  });
  if (query.isPending) return <FullPageLoading label="Loading orders" />;
  if (query.isError)
    return (
      <ErrorState
        message="Orders could not be loaded."
        onRetry={() => query.refetch()}
      />
    );
  return (
    <PageShell
      title="Orders"
      description="Internal charge records. Invoices are issued externally by wiRef."
      width="wide"
      actions={
        hasPermission(user, PermissionId.orderswrite) ? (
          <>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              New draft
            </Button>
            {hasPermission(user, PermissionId.ordersfinalize) &&
              hasPermission(user, PermissionId.paymentsrecord) &&
              hasPermission(user, PermissionId.paymentsread) && (
                <Button kind="secondary" as={Link} to="/orders/counter-sale">
                  Counter sale
                </Button>
              )}
          </>
        ) : undefined
      }
    >
      <FinancialError error={create.error} />
      <DirectoryTable<Order>
        mode="server" id="orders" urlPrefix="" label="Orders" columns={columns}
        rows={query.data.items} total={query.data.total} pageSizes={PAGE_SIZES} defaultPageSize={25}
        filterCategories={[{ key: "status", label: "Lifecycle", options: STATUS_OPTIONS, single: true }]}
        empty={{ title: "No orders yet", description: "Orders appear here once a draft has been created." }}
      />
    </PageShell>
  );
}

package surveys

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// DeliveryBatchLimit bounds how many invitations one delivery pass claims.
const DeliveryBatchLimit int32 = 100

// Deliverer sends due survey invitations; *Service implements it.
type Deliverer interface {
	DeliverDue(ctx context.Context, limit int32) (int, error)
}

// RunDelivery calls DeliverDue every interval until ctx is cancelled. An interval of zero or less
// disables the loop. DeliverDue claims rows with FOR UPDATE SKIP LOCKED and sends outside any
// transaction, so several API replicas may run this loop at once. Errors are logged without
// invitation, recipient or token data and never stop the loop.
func RunDelivery(ctx context.Context, deliverer Deliverer, interval time.Duration, limit int32, logger *slog.Logger) {
	if interval <= 0 {
		logger.Info("automatic survey delivery disabled")
		return
	}
	logger.Info("automatic survey delivery enabled", "interval", interval.String(), "batch_limit", limit)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			deliverOnce(ctx, deliverer, limit, logger)
		}
	}
}

func deliverOnce(ctx context.Context, deliverer Deliverer, limit int32, logger *slog.Logger) {
	count, err := deliverer.DeliverDue(ctx, limit)
	if err != nil {
		if ctx.Err() == nil {
			logger.Error("survey delivery failed", "error_type", fmt.Sprintf("%T", err), "delivered", count)
		}
		return
	}
	if count > 0 {
		logger.Info("survey invitations delivered", "count", count)
		return
	}
	logger.Debug("no survey invitations due")
}

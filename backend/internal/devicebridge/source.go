package devicebridge

import "context"

type Source interface {
	Run(context.Context, *Broker)
	Capability() Capability
}

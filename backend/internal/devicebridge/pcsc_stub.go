//go:build !pcsc || !cgo

package devicebridge

import "context"

type PCSCSource struct{}

func NewPCSCSource() *PCSCSource { return &PCSCSource{} }

func (*PCSCSource) Run(context.Context, *Broker) {}

func (*PCSCSource) Capability() Capability {
	return Capability{ID: "nfc", Available: false, State: "unsupported", Detail: "Bridge was built without the pcsc build tag or CGO"}
}

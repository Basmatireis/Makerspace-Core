package machinelogbook

// NothingToBill says whether a job has nothing chargeable: it has ended, its price is complete and its final price
// (after any adjustment, so a waived job too) is exactly zero. Such a job never goes on an order and is not
// unbilled work. A job whose price is not known yet (running, planned, pending or incomplete) is never
// nothing to bill. The nothing_to_bill billing state of the work-item and own-job queries mirrors this definition.
func (j MachineJob) NothingToBill() bool {
	if j.Status == JobStatusRunning || j.Status == JobStatusPlanned || j.PricingStatus != PricingComplete ||
		j.EffectivePrice == nil {
		return false
	}
	value, err := parseDecimal(*j.EffectivePrice, false)
	return err == nil && value.IsZero()
}

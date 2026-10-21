// Package configtransfer exports the configuration of this makerspace as a versioned JSON file and imports such a
// file section by section, in overwrite or insert mode, after a dry-run preview. Every write goes through the owning
// feature's service in one transaction, so the import keeps the same permission and business rules as the UI.
package configtransfer

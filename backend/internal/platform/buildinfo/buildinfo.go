// Package buildinfo holds facts about the running Core build.
package buildinfo

// Version is Core's release version, set at link time (-X); development builds report "dev". The
// printer connectors are offered updates to exactly this version.
var Version = "dev"

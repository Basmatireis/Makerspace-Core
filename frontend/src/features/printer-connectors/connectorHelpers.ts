export function isIPv4Unicast(value: string): boolean {
  const octets = value.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return false;
  const first = Number(octets[0]);
  return first > 0 && first !== 127 && first < 224;
}

export function connectorDiagnostic(code: string): string {
  const normalized = code.toLowerCase();
  if (normalized.includes('serial') && (normalized.includes('mismatch') || normalized.includes('identity'))) return 'The printer certificate does not match the configured serial number. Check the printer IP and serial number.';
  if (normalized.includes('expired') && (normalized.includes('tls') || normalized.includes('cert'))) return 'The printer certificate is expired or not yet valid. Check the printer date, firmware, and connector host clock.';
  if (normalized.includes('tls') || normalized.includes('certificate') || normalized.includes('unknown_ca') || normalized.includes('chain')) return 'The secure printer connection could not be verified. Check the printer firmware, address, and certificate chain.';
  if (normalized.includes('auth') || normalized.includes('access_code') || normalized.includes('unauthorized')) return 'The printer rejected the LAN access code. Rotate the code in the assignment settings.';
  if (normalized.includes('mqtt')) return 'Printer status is unavailable over MQTT. Check LAN-only mode, port 8883, and local network routing.';
  if (normalized.includes('snapshot_timeout')) return 'The printer connected but did not provide a complete status snapshot within 15 seconds. Check firmware compatibility and retry the connection.';
  if (normalized.includes('artifact_ambiguous')) return 'More than one exact print-file match was found. Remove or rename the duplicate printer files; the run remains recorded.';
  if (normalized.includes('artifact_not_available')) return 'The exact print file is not available in the printer root or cache. Check attached printer storage; the run remains recorded.';
  if (normalized.includes('ftps_control_connect')) return 'The printer accepted status connections, but its FTPS control port could not be reached. Check port 990, LAN-only mode, and local network routing.';
  if (normalized.includes('ftps_data_connect') || normalized.includes('ftps_passive')) return 'The printer opened FTPS, but its protected data connection failed. Check local firewall and Docker routing for the printer’s passive data port.';
  if (normalized.includes('ftps_control_tls') || normalized.includes('ftps_data_tls')) return 'The printer’s protected FTPS channel could not be negotiated. Check printer firmware and the connector certificate diagnostics.';
  if (normalized.includes('ftps_listing')) return 'The printer’s FTPS directory listing was not in a supported format. The print run is still recorded.';
  if (normalized.includes('ftps_transfer')) return 'The printer interrupted the protected print-file transfer. The connector will retry independently.';
  if (normalized.includes('ftps') || normalized.includes('artifact') && !normalized.includes('backlog')) return 'Print files are unavailable over FTPS. The run is still recorded; check port 990 and printer storage.';
  if (normalized.includes('backlog') || normalized.includes('capacity')) return 'Artifact delivery is at capacity. Restore Core connectivity or storage before more files accumulate.';
  if (normalized.includes('unsupported') || normalized.includes('model')) return 'This printer model or firmware is not supported by the H2D adapter.';
  if (normalized.includes('config') || normalized.includes('invalid')) return 'The assignment configuration is invalid. Review the IP address, serial number, and adapter settings.';
  return 'The assignment needs attention. Use the diagnostic code when checking connector logs.';
}

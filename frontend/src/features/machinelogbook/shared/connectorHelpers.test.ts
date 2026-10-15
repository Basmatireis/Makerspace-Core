import { describe, expect, it } from 'vitest';
import { connectorDiagnostic, isIPv4Unicast } from './connectorHelpers';

describe('connector diagnostics', () => {
  it('recognizes stable failure families and IPv4 unicast literals', () => {
    expect(connectorDiagnostic('MQTT_CONNECTION_TIMEOUT')).toMatch(/port 8883/);
    expect(connectorDiagnostic('FTPS_AUTH_FAILED')).toMatch(/access code/i);
    expect(connectorDiagnostic('ARTIFACT_BACKLOG_CAPACITY')).toMatch(/capacity/i);
    expect(connectorDiagnostic('ARTIFACT_AMBIGUOUS')).toMatch(/more than one exact/i);
    expect(connectorDiagnostic('ARTIFACT_NOT_AVAILABLE')).toMatch(/root or cache/i);
    expect(connectorDiagnostic('SNAPSHOT_TIMEOUT')).toMatch(/15 seconds/i);
    expect(connectorDiagnostic('TLS_SERIAL_MISMATCH')).toMatch(/does not match the configured serial number/i);
    expect(isIPv4Unicast('192.168.1.42')).toBe(true);
    expect(isIPv4Unicast('127.0.0.1')).toBe(false);
    expect(isIPv4Unicast('999.1.1.1')).toBe(false);
    expect(isIPv4Unicast('224.0.0.1')).toBe(false);
  });
});

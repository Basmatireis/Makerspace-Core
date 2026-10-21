import { SettingsPageLayout } from '../settings/SettingsPageLayout';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { ExportPanel } from './ExportPanel';
import { ImportPanel } from './ImportPanel';
import { canExportSection, canImportSection, sectionDefinitions } from './sections';

export function ConfigurationTransferPage() {
  const currentUser = useCurrentUser();
  const exportable = hasPermission(currentUser, PermissionId.configurationexport)
    ? sectionDefinitions.filter((section) => canExportSection(currentUser, section))
    : [];
  const importable = hasPermission(currentUser, PermissionId.configurationimport)
    ? sectionDefinitions.filter((section) => canImportSection(currentUser, section))
    : [];

  return (
    <SettingsPageLayout
      page="configuration-transfer"
      description="Move the configuration of this makerspace between instances as a file."
    >
      <div className="configuration-transfer">
        {exportable.length > 0 && <ExportPanel sections={exportable} />}
        {importable.length > 0 && <ImportPanel sections={importable} />}
        {exportable.length === 0 && importable.length === 0 && (
          <p>Your account cannot export or import any configuration section.</p>
        )}
      </div>
    </SettingsPageLayout>
  );
}

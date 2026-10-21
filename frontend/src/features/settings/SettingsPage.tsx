import { Column, Grid, Stack, ClickableTile as CarbonClickableTile } from '@carbon/react';
import {
  DataBase,
  Devices,
  Document,
  Group,
  UserMultiple,
  IbmCloudKeyProtect,
  Email,
  PaintBrush,
  Calendar,
  Timer,
  QuestionAnswering,
  VideoChat,
  Migrate,
} from '@carbon/icons-react';
import type { ComponentProps, ComponentType } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { hasAnyPermission, hasPermission, PermissionId } from '../auth/permissions';

type RouterClickableTileProps = Omit<ComponentProps<typeof CarbonClickableTile>, 'href'> & {
  as: typeof Link;
  to: string;
};

// Carbon's ClickableTile forwards polymorphic Link props at runtime, but its
// current public type omits them.
const ClickableTile = CarbonClickableTile as ComponentType<RouterClickableTileProps>;

export function SettingsPage() {
  const currentUser = useCurrentUser();
  const canUseRoles = hasAnyPermission(currentUser, [PermissionId.rolesread]);
  const canUseDevices = hasAnyPermission(currentUser, [PermissionId.managed_devicesread]);
  const canManageSessionPolicies = hasPermission(currentUser, PermissionId.session_policiesmanage);
  const canUseSurveys =
    hasPermission(currentUser, PermissionId.surveysread) || hasPermission(currentUser, PermissionId.surveysmanage);
  const canUseLaborordnung = hasAnyPermission(currentUser, [
    PermissionId.laborordnungread,
    PermissionId.laborordnungmanage,
    PermissionId.laborordnungrequestsread,
  ]);
  const canManageOIDC = hasAnyPermission(currentUser, [PermissionId.oidcmanage]);
  const canManageSCIM = hasAnyPermission(currentUser, [PermissionId.scimmanage]);
  const canManageVisitorEnrollment = hasAnyPermission(currentUser, [PermissionId.visitor_enrollmentmanage]);
  const canManageMail = hasAnyPermission(currentUser, [PermissionId.mailmanage]);
  const canManageBranding = hasAnyPermission(currentUser, [PermissionId.brandingmanage]);
  const canManageLocalServices = hasPermission(currentUser, PermissionId.local_servicesmanage);
  const canManageOpenDays = hasPermission(currentUser, PermissionId.open_daysmanage);
  const canConfigureMachineLogbook = hasPermission(currentUser, PermissionId.pricingread);
  const canTransferConfiguration = hasAnyPermission(currentUser, [
    PermissionId.configurationexport,
    PermissionId.configurationimport,
  ]);

  return (
    <PageShell title="Settings" description="Administration tools available to your account.">
      <Grid condensed className="settings-grid">
        {canUseRoles && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile as={Link} to="/settings/roles" className="settings-tile">
              <Stack gap={5}>
                <Group size={32} />
                <div>
                  <h2>Roles</h2>
                  <p>Configure reusable permission sets for accounts.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canManageOpenDays && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile as={Link} to="/settings/open-days" className="settings-tile">
              <Stack gap={5}>
                <Calendar size={32} />
                <div>
                  <h2>Open day requirements</h2>
                  <p>Set how many open days supervisors and trainees staff per semester.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canUseDevices && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile as={Link} to="/settings/managed-devices" className="settings-tile">
              <Stack gap={5}>
                <Devices size={32} />
                <div>
                  <h2>Managed devices</h2>
                  <p>Register trusted terminals and device types.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canManageSessionPolicies && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile as={Link} to="/settings/session-policies" className="settings-tile">
              <Stack gap={5}>
                <Timer size={32} />
                <div>
                  <h2>Session policies</h2>
                  <p>Set idle limits, absolute lifetimes, and timeout destinations.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canUseSurveys && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile as={Link} to="/settings/surveys" className="settings-tile">
              <Stack gap={5}>
                <QuestionAnswering size={32} />
                <div>
                  <h2>Surveys</h2>
                  <p>Build surveys and configure post-visit delivery.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canUseLaborordnung && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile as={Link} to="/settings/laborordnung" className="settings-tile">
              <Stack gap={5}>
                <Document size={32} />
                <div>
                  <h2>Lab Rules</h2>
                  <p>Publish PDFs and verify physical evidence.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canManageOIDC && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile as={Link} to="/settings/oidc" className="settings-tile">
              <Stack gap={5}>
                <IbmCloudKeyProtect size={32} />
                <div>
                  <h2>OpenID Connect</h2>
                  <p>Configure external identity providers and trusted assurance.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canManageSCIM && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile as={Link} to="/settings/scim" className="settings-tile">
              <Stack gap={5}>
                <DataBase size={32} />
                <div>
                  <h2>SCIM provisioning</h2>
                  <p>Manage connectors, bearer tokens, and Account reconciliation.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canManageVisitorEnrollment && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile as={Link} to="/settings/visitor-enrollment" className="settings-tile">
              <Stack gap={5}>
                <UserMultiple size={32} />
                <div>
                  <h2>Visitor enrollment</h2>
                  <p>Configure approved terminals, the initial Role, and authentication methods.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canManageMail && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile as={Link} to="/settings/mail" className="settings-tile">
              <Stack gap={5}>
                <Email size={32} />
                <div>
                  <h2>Email delivery</h2>
                  <p>Configure SMTP, sender identity, and recovery-link delivery.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canManageBranding && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile as={Link} to="/settings/branding-legal" className="settings-tile">
              <Stack gap={5}>
                <PaintBrush size={32} />
                <div>
                  <h2>Branding &amp; legal</h2>
                  <p>Configure organization identity, colors, assets, and public legal documents.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canManageLocalServices && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile as={Link} to="/settings/local-services" className="settings-tile">
              <Stack gap={5}>
                <VideoChat size={32} />
                <div>
                  <h2>Local services</h2>
                  <p>Streaming gateways and printer cameras for digital signage.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canTransferConfiguration && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile as={Link} to="/settings/configuration-transfer" className="settings-tile">
              <Stack gap={5}>
                <Migrate size={32} />
                <div>
                  <h2>Export &amp; import</h2>
                  <p>Move roles, machines, pricing and settings between instances as a file.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canConfigureMachineLogbook && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile as={Link} to="/pricing" className="settings-tile">
              <Stack gap={5}>
                <DataBase size={32} />
                <div>
                  <h2>Pricing</h2>
                  <p>Pricing groups and rates now live under Sales &amp; payments.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
      </Grid>
    </PageShell>
  );
}

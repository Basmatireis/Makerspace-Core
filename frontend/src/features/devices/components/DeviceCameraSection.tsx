import {
  Button,
  InlineNotification,
  Modal,
  NumberInput,
  Select,
  SelectItem,
  Stack,
  StructuredListBody,
  StructuredListWrapper,
  Tag,
  Toggle,
} from '@carbon/react';
import { Camera, Close, Edit } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  closeManagedDeviceCameraCalibration,
  getManagedDeviceCamera,
  startManagedDeviceCameraCalibration,
  updateManagedDeviceCamera,
} from '../../../api/generated/managed-devices/managed-devices';
import type {
  KioskCameraIndicatorEdge,
  KioskCameraSettings,
  ManagedDevice,
  ManagedDeviceCamera,
} from '../../../api/generated/models';
import { apiErrorCode } from '../../../api/http-client';
import { DetailRow, DetailSection } from '../../../app/DetailSection';
import { formatTime } from '../../../app/dateTime';
import { SettingsLoading } from '../../settings/SettingsPageLayout';
import { keys } from './deviceShared';

const edgeLabels: Record<KioskCameraIndicatorEdge, string> = {
  top: 'Top',
  right: 'Right',
  bottom: 'Bottom',
  left: 'Left',
};

/** A fraction shown as a percentage with at most one decimal. */
const percent = (fraction: number) => `${Number((fraction * 100).toFixed(1))} %`;

function describeCrop(camera: KioskCameraSettings): string {
  const { crop } = camera;
  if (!crop) return 'Default: the centred largest square';
  return `Centre ${percent(crop.centerX)} from the left, ${percent(crop.centerY)} from the top · size ${percent(crop.size)}`;
}

function describeIndicator(camera: KioskCameraSettings): string {
  const { indicator } = camera;
  if (!indicator) return 'Off';
  const along = indicator.edge === 'top' || indicator.edge === 'bottom' ? 'from the left' : 'from the top';
  return `${edgeLabels[indicator.edge]} edge, ${Number(indicator.offset.toFixed(1))} % ${along}`;
}

/**
 * The kiosk camera's photo square and lens pointer. Staff start a short calibration window here and finish it on the
 * tablet with a live preview, or type the values directly. Shown only for devices configured with a camera.
 */
export function DeviceCameraSection({ device, canManage }: { device: ManagedDevice; canManage: boolean }) {
  const queryClient = useQueryClient();
  const cameraKey = [...keys.devices, device.id, 'camera'] as const;
  const query = useQuery({
    queryKey: cameraKey,
    queryFn: ({ signal }) => getManagedDeviceCamera(device.id, { signal }),
    // While the tablet calibrates, follow it so the page shows when it saved or cancelled.
    refetchInterval: (current) => (current.state.data?.calibrationExpiresAt ? 10_000 : false),
  });
  const [editing, setEditing] = useState(false);
  const apply = (camera: ManagedDeviceCamera) => queryClient.setQueryData(cameraKey, camera);
  const start = useMutation({ mutationFn: () => startManagedDeviceCameraCalibration(device.id), onSuccess: apply });
  const close = useMutation({ mutationFn: () => closeManagedDeviceCameraCalibration(device.id), onSuccess: apply });
  const update = useMutation({
    mutationFn: (settings: KioskCameraSettings) => updateManagedDeviceCamera(device.id, settings),
    onSuccess: (camera) => {
      apply(camera);
      setEditing(false);
    },
  });
  const camera = query.data;
  const open = camera?.calibrationExpiresAt && new Date(camera.calibrationExpiresAt) > new Date();
  const canCalibrate = device.status === 'active' && device.terminalEnabled;
  const actionError = start.error ?? close.error;

  return (
    <DetailSection
      title="Kiosk camera"
      description="Which part of the camera image becomes the profile photo, and where the kiosk points people to look. Tablets differ, so calibrate on the tablet itself."
    >
      {query.isPending && <SettingsLoading label="Loading camera settings" />}
      {query.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Camera settings unavailable"
          subtitle="They could not be loaded."
        />
      )}
      {camera && (
        <Stack gap={5}>
          <StructuredListWrapper isCondensed>
            <StructuredListBody>
              <DetailRow label="Photo square" value={describeCrop(camera)} />
              <DetailRow label="Camera pointer" value={describeIndicator(camera)} />
              <DetailRow label="Mirror image" value={camera.mirror ? 'On' : 'Off'} />
              <DetailRow
                label="Calibration on the tablet"
                value={
                  open && camera.calibrationExpiresAt ? (
                    <Tag size="sm" type="blue">
                      Open until {formatTime(camera.calibrationExpiresAt)}
                    </Tag>
                  ) : (
                    'Not open'
                  )
                }
              />
            </StructuredListBody>
          </StructuredListWrapper>
          {actionError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Calibration not changed"
              subtitle={
                apiErrorCode(actionError) === 'camera_not_configured'
                  ? 'This device is not configured with a camera.'
                  : 'Only an active entrance kiosk can calibrate its camera.'
              }
            />
          )}
          {canManage && (
            <div className="button-cluster">
              {open ? (
                <Button kind="tertiary" renderIcon={Close} disabled={close.isPending} onClick={() => close.mutate()}>
                  Close calibration
                </Button>
              ) : (
                <Button
                  kind="tertiary"
                  renderIcon={Camera}
                  disabled={!canCalibrate || start.isPending}
                  onClick={() => start.mutate()}
                >
                  Calibrate on the tablet
                </Button>
              )}
              <Button kind="ghost" renderIcon={Edit} onClick={() => setEditing(true)}>
                Edit values
              </Button>
            </div>
          )}
          {canManage && (
            <p className="settings-section__description">
              {canCalibrate
                ? 'Calibrating opens the calibration screen on the tablet for ten minutes, within about 20 seconds. Saving or cancelling there closes it.'
                : 'Only an active device used as an entrance kiosk can calibrate on the tablet.'}
            </p>
          )}
        </Stack>
      )}
      {editing && camera && (
        <CameraValuesModal
          camera={camera}
          pending={update.isPending}
          failed={update.isError}
          onClose={() => {
            setEditing(false);
            update.reset();
          }}
          onSubmit={(settings) => update.mutate(settings)}
        />
      )}
    </DetailSection>
  );
}

const inRange = (value: number, min: number, max: number) => !Number.isNaN(value) && value >= min && value <= max;

function CameraValuesModal({
  camera,
  pending,
  failed,
  onClose,
  onSubmit,
}: {
  camera: KioskCameraSettings;
  pending: boolean;
  failed: boolean;
  onClose: () => void;
  onSubmit: (settings: KioskCameraSettings) => void;
}) {
  // Values in percent, as typed; NaN while a field is empty.
  const [cropOn, setCropOn] = useState(Boolean(camera.crop));
  const [centerX, setCenterX] = useState((camera.crop?.centerX ?? 0.5) * 100);
  const [centerY, setCenterY] = useState((camera.crop?.centerY ?? 0.5) * 100);
  const [size, setSize] = useState((camera.crop?.size ?? 1) * 100);
  const [indicatorOn, setIndicatorOn] = useState(Boolean(camera.indicator));
  const [edge, setEdge] = useState<KioskCameraIndicatorEdge>(camera.indicator?.edge ?? 'top');
  const [offset, setOffset] = useState(camera.indicator?.offset ?? 50);
  const [mirror, setMirror] = useState(camera.mirror);
  const cropValid = !cropOn || (inRange(centerX, 0, 100) && inRange(centerY, 0, 100) && inRange(size, 20, 100));
  const offsetValid = !indicatorOn || inRange(offset, 0, 100);
  const number = (set: (value: number) => void) => (_event: unknown, state: { value: number | string }) =>
    set(state.value === '' ? Number.NaN : Number(state.value));

  return (
    <Modal
      open
      modalHeading="Kiosk camera values"
      primaryButtonText={pending ? 'Saving…' : 'Save'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending || !cropValid || !offsetValid}
      onRequestClose={onClose}
      onRequestSubmit={() =>
        onSubmit({
          crop: cropOn ? { centerX: centerX / 100, centerY: centerY / 100, size: size / 100 } : null,
          indicator: indicatorOn ? { edge, offset } : null,
          mirror,
        })
      }
    >
      <Stack gap={6}>
        <Toggle
          id="camera-crop-custom"
          labelText="Photo square"
          labelA="Default (centred, largest)"
          labelB="Custom"
          toggled={cropOn}
          onToggle={setCropOn}
        />
        {cropOn && (
          <div className="device-camera__fields">
            <NumberInput
              id="camera-crop-x"
              label="Centre from the left (%)"
              min={0}
              max={100}
              step={0.5}
              allowEmpty
              value={Number.isNaN(centerX) ? '' : centerX}
              invalid={!inRange(centerX, 0, 100)}
              invalidText="Enter 0 to 100."
              onChange={number(setCenterX)}
            />
            <NumberInput
              id="camera-crop-y"
              label="Centre from the top (%)"
              min={0}
              max={100}
              step={0.5}
              allowEmpty
              value={Number.isNaN(centerY) ? '' : centerY}
              invalid={!inRange(centerY, 0, 100)}
              invalidText="Enter 0 to 100."
              onChange={number(setCenterY)}
            />
            <NumberInput
              id="camera-crop-size"
              label="Size (% of the shorter side)"
              min={20}
              max={100}
              step={1}
              allowEmpty
              value={Number.isNaN(size) ? '' : size}
              invalid={!inRange(size, 20, 100)}
              invalidText="Enter 20 to 100."
              onChange={number(setSize)}
            />
          </div>
        )}
        <Toggle
          id="camera-mirror"
          labelText="Mirror image"
          labelA="Off"
          labelB="On"
          toggled={mirror}
          onToggle={setMirror}
        />
        <Toggle
          id="camera-indicator-on"
          labelText="Camera pointer"
          labelA="Off"
          labelB="On"
          toggled={indicatorOn}
          onToggle={setIndicatorOn}
        />
        {indicatorOn && (
          <div className="device-camera__fields">
            <Select
              id="camera-indicator-edge"
              labelText="Screen edge next to the lens"
              value={edge}
              onChange={(event) => setEdge(event.target.value as KioskCameraIndicatorEdge)}
            >
              {(Object.keys(edgeLabels) as KioskCameraIndicatorEdge[]).map((value) => (
                <SelectItem key={value} value={value} text={edgeLabels[value]} />
              ))}
            </Select>
            <NumberInput
              id="camera-indicator-offset"
              label={edge === 'top' || edge === 'bottom' ? 'Position from the left (%)' : 'Position from the top (%)'}
              min={0}
              max={100}
              step={0.5}
              allowEmpty
              value={Number.isNaN(offset) ? '' : offset}
              invalid={!inRange(offset, 0, 100)}
              invalidText="Enter 0 to 100."
              onChange={number(setOffset)}
            />
          </div>
        )}
        <div>
          <Button
            kind="ghost"
            size="sm"
            onClick={() => {
              setCropOn(false);
              setIndicatorOn(false);
              setMirror(false);
            }}
          >
            Reset to default
          </Button>
        </div>
        {failed && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Values not saved"
            subtitle="Check the values and try again."
          />
        )}
      </Stack>
    </Modal>
  );
}

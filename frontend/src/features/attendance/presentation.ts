const methodLabels: Record<string, string> = {
  pin: 'Tablet · PIN',
  password: 'Tablet · password',
  supervisor: 'Assisted',
  oidc: 'Single sign-on',
  nfc: 'Card',
  enrollment: 'Enrollment',
};

export function checkInMethodLabel(method: string) {
  return methodLabels[method] ?? method;
}

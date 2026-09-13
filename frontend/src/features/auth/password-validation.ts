export function validatePasswordLength(password: string): true | string {
  const characterCount = Array.from(password).length;
  if (characterCount < 12) {
    return 'Use at least 12 characters.';
  }
  if (characterCount > 128) {
    return 'Use at most 128 characters.';
  }
  return true;
}

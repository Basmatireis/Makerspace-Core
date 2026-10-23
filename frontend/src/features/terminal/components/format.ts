export function formatTime(value: Date | string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** Display names are full names; the greeting uses the first word. */
export function firstName(name: string) {
  return name.split(/\s+/)[0] ?? name;
}

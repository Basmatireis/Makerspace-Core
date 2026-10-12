import { useEffect, useState } from 'react';
const phoneQuery = '(max-width: 41.98rem)';
export function useInventoryLayout() {
  const [isPhone, setIsPhone] = useState(() => window.matchMedia(phoneQuery).matches);
  useEffect(() => {
    const query = window.matchMedia(phoneQuery);
    const update = () => setIsPhone(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);
  return { isPhone };
}

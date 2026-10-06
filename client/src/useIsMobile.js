// True on phone-sized screens — the lobby and call screen swap to their
// mobile layouts below this width.

import { useEffect, useState } from 'react';

const MOBILE_QUERY = '(max-width: 560px)';

export default function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

// useMediaQuery — subscribe to a CSS media query from React.
//
// Layout decisions belong in Tailwind classes wherever CSS can express them
// (MOBILE_FIRST.md). This exists for the cases CSS cannot reach: when the
// BREAKPOINT CHANGES WHAT IS RENDERED, not just how it looks — e.g. Flightdeck
// picking which panels exist on a phone, where hiding the developer panes with
// `hidden` would still mount CodeMirror and a PTY behind them.
//
// Reach for a Tailwind prefix first; use this only when the component must
// actually branch.

import { useEffect, useState } from 'react';

const supported = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (supported() ? window.matchMedia(query).matches : false));

  useEffect(() => {
    if (!supported()) return undefined;
    const mql = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    setMatches(mql.matches);
    // addListener is the Safari <14 spelling; keep both so an older iPad still
    // tracks rotation instead of freezing on its first-render value.
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);

  return matches;
}

// Phone-sized: everything below Tailwind's `md` (768px), which is exactly where
// the dashboard swaps the fixed sidebar for the drawer.
export function useIsMobile() {
  return useMediaQuery('(max-width: 767px)');
}

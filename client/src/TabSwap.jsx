// What's under a tab bar, switching smoothly: when the tab changes, the new
// content fades in while sliding from the side you're heading to — going
// right (Chat → Poll) it comes in from the right, going left from the left.
//
//   <TabSwap tab={panelTab} order={['chat', 'qa', 'poll']}>…</TabSwap>
//
// `key={tab}` gives each tab a fresh element, so the CSS animation
// (.tab-swap in index.css) plays once per switch. The direction rides in a
// CSS variable (--from), so later re-renders don't restart it.

import { useState } from 'react';

const SHIFT_PX = 16; // how far the new content slides

export default function TabSwap({ tab, order, className = '', children }) {
  const idx = order.indexOf(tab);
  // Which way we last moved: -1 left, 1 right, 0 = first showing (just fade).
  const [move, setMove] = useState({ idx, dir: 0 });
  if (move.idx !== idx) setMove({ idx, dir: idx > move.idx ? 1 : -1 });
  return (
    <div
      key={tab}
      className={`tab-swap ${className}`.trim()}
      style={{ '--from': `${move.dir * SHIFT_PX}px` }}
    >
      {children}
    </div>
  );
}

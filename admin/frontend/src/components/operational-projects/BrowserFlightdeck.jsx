import { useEffect, useId, useRef, useState } from 'react';
import { Globe, Maximize2, Minimize2 } from 'lucide-react';
import { Action } from './shared';
import { createBrowserFullscreen } from './browser-fullscreen';

// Presentation only: changing panels/fullscreen never remounts the viewer,
// starts work, grants control, or approves a request.
export function BrowserFlightdeck({ title, state, browser, actions, activity, details, review, reviewCount = 0 }) {
  const id = useId(), box = useRef(null), full = useRef(null), [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState('browser'), [rail, setRail] = useState(reviewCount ? 'review' : 'activity');
  const previousCount = useRef(reviewCount);
  useEffect(() => {
    full.current = createBrowserFullscreen({ element: box.current, onChange: setExpanded });
    return () => { full.current?.close(); full.current = null; };
  }, []);
  useEffect(() => {
    if (reviewCount > previousCount.current) setRail('review');
    previousCount.current = reviewCount;
  }, [reviewCount]);
  function select(name) { if (name === 'browser') setPanel(name); else { setPanel('rail'); setRail(name); } }
  const tabs = [['browser', 'Browser'], ['activity', 'Activity'], ['details', 'Details'], ['review', reviewCount ? `Review (${reviewCount})` : 'Review']];
  const chosen = panel === 'browser' ? 'browser' : rail;
  return <section ref={box} tabIndex={-1} aria-label="Browser Flightdeck" data-browser-flightdeck data-browser-fullscreen={expanded}
    className={expanded ? 'fixed inset-0 z-[60] flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-background p-3' : 'min-w-0 rounded-md border bg-card overflow-hidden'}>
    <header className="shrink-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b p-3">
      <div className="min-w-0"><h3 className="flex items-center gap-2 text-lg font-semibold"><Globe className="h-4 w-4 shrink-0" aria-hidden="true"/><span className="break-words">{title}</span></h3><p role="status" className="text-sm text-muted-foreground capitalize">{state}</p></div>
      <div className="flex flex-wrap items-center gap-2">{actions}<Action variant="outline" className="!min-h-11 !min-w-11 !px-3" data-exit-browser-fullscreen={expanded || undefined}
        aria-label={expanded ? 'Exit fullscreen browser' : 'Open fullscreen browser'} onClick={() => expanded ? full.current.exit() : full.current.enter()}>{expanded ? <Minimize2 className="h-4 w-4" aria-hidden="true"/> : <Maximize2 className="h-4 w-4" aria-hidden="true"/>}</Action></div>
    </header>
    <nav aria-label="Browser panels" className="shrink-0 flex border-b lg:hidden">{tabs.map(([name, label]) => <button key={name} type="button" aria-pressed={chosen === name} aria-controls={`${id}-${name === 'browser' ? 'browser' : 'rail'}`} onClick={() => select(name)}
      className={`min-h-11 min-w-0 flex-1 px-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${chosen === name ? 'bg-muted font-semibold' : 'text-muted-foreground'}`}>{label}</button>)}</nav>
    {reviewCount > 0 && <p role="status" className="shrink-0 border-b border-amber-500/50 bg-amber-500/10 p-3 text-sm">{reviewCount} review item{reviewCount === 1 ? '' : 's'} {reviewCount === 1 ? 'needs' : 'need'} your attention. <button className="min-h-11 underline font-medium px-2" onClick={() => select('review')}>Inspect review</button></p>}
    <div className={`min-w-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(280px,32%)] ${expanded ? 'min-h-0 flex-1' : ''}`}>
      <div id={`${id}-browser`} className={`min-w-0 p-3 ${panel === 'browser' ? 'block' : 'hidden'} lg:block ${expanded ? 'min-h-0 overflow-y-auto' : ''}`}>{browser}</div>
      <aside id={`${id}-rail`} aria-label="Run information" className={`min-w-0 border-t lg:border-t-0 lg:border-l ${panel === 'rail' ? 'block' : 'hidden'} lg:block ${expanded ? 'min-h-0 overflow-y-auto' : 'lg:max-h-[650px] lg:overflow-y-auto'}`}>
        <nav aria-label="Run information panels" className="hidden lg:flex border-b">{tabs.slice(1).map(([name, label]) => <button key={name} type="button" aria-pressed={rail === name} onClick={() => setRail(name)} className={`min-h-11 min-w-0 flex-1 px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${rail === name ? 'bg-muted font-semibold' : 'text-muted-foreground'}`}>{label}</button>)}</nav>
        <div className="space-y-3 p-3 text-sm" hidden={rail !== 'activity'}>{activity}</div>
        <div className="space-y-3 p-3 text-sm" hidden={rail !== 'details'}>{details}</div>
        <div className="space-y-3 p-3 text-sm" hidden={rail !== 'review'}>{review}</div>
      </aside>
    </div>
  </section>;
}

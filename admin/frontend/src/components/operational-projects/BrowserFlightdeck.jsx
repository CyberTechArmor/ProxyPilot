import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Clock3, FileText, Globe, Maximize2, Minimize2 } from 'lucide-react';
import { Action } from './shared';
import { createBrowserFullscreen } from './browser-fullscreen';

// Panel changes and fullscreen keep the same mounted viewer and approval forms.
// This composition never starts work, grants control or approves a request.
export function BrowserFlightdeck({ title, subtitle, state, browser, actions, activity, details, review, task, recent, reviewCount = 0, initialReview = false }) {
  const id = useId(), box = useRef(null), full = useRef(null), [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState(initialReview?'rail':'browser'), [rail, setRail] = useState(initialReview||reviewCount ? 'review' : 'activity');
  const previousCount = useRef(reviewCount);
  useEffect(() => {
    full.current = createBrowserFullscreen({ element: box.current, onChange: setExpanded });
    return () => { full.current?.close(); full.current = null; };
  }, []);
  useEffect(() => {
    if (reviewCount > previousCount.current) setRail('review');
    previousCount.current = reviewCount;
  }, [reviewCount]);
  useEffect(()=>{if(initialReview){setPanel('rail');setRail('review');}},[initialReview]);
  function select(name) { if (name === 'browser') setPanel(name); else { setPanel('rail'); setRail(name); } }
  const tabs = [['browser', 'Browser'], ['activity', 'Activity'], ['details', 'Details'], ['review', reviewCount ? `Review (${reviewCount})` : 'Review']];
  const chosen = panel === 'browser' ? 'browser' : rail;
  const tabClass = selected => `min-h-11 min-w-0 flex-1 border-b-2 px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-primary text-primary font-medium' : 'border-transparent text-muted-foreground'}`;
  return <section ref={box} tabIndex={-1} aria-label="Browser Flightdeck" data-browser-flightdeck data-browser-fullscreen={expanded}
    className={expanded ? 'fixed inset-0 z-[60] flex h-[100dvh] min-h-0 flex-col gap-3 overflow-hidden bg-background p-3' : 'flex min-w-0 flex-col gap-4'}>
    <header className="shrink-0 min-w-0 space-y-1" data-browser-deck-title>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2"><h2 className="text-[28px] sm:text-[32px] font-semibold leading-tight tracking-tight break-words [overflow-wrap:anywhere]">{title}</h2>
        <p role="status" className={`rounded-full border px-3 py-1 text-sm capitalize ${reviewCount ? 'border-amber-500/70 bg-amber-500/10 text-foreground' : 'text-muted-foreground'}`}>{reviewCount ? 'Needs your help' : state}</p></div>
      {subtitle && <p className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">{subtitle}</p>}
      <div className="flex flex-wrap gap-2 pt-2">{actions}</div>
    </header>
    <nav aria-label="Browser panels" className="shrink-0 flex border-b lg:hidden">{tabs.map(([name, label]) => <button key={name} type="button" aria-pressed={chosen === name} aria-controls={`${id}-${name === 'browser' ? 'browser' : 'rail'}`} onClick={() => select(name)} className={tabClass(chosen === name)}>{label}</button>)}</nav>
    {reviewCount>0&&<p role="status" className="lg:hidden shrink-0 rounded-md border border-amber-500 bg-amber-500/5 px-3 text-sm">{reviewCount} review item{reviewCount===1?'':'s'} {reviewCount===1?'needs':'need'} your attention. <button type="button" className="min-h-11 px-2 underline font-medium" onClick={()=>select('review')}>Inspect review</button></p>}
    <div className={`min-w-0 grid grid-cols-1 lg:grid-cols-[minmax(0,0.64fr)_minmax(0,0.36fr)] gap-4 ${expanded ? 'min-h-0 flex-1 overflow-y-auto' : ''}`} data-browser-deck-columns>
      <div id={`${id}-browser`} className={`min-w-0 space-y-3 ${panel === 'browser' ? 'block' : 'hidden'} lg:block`}>
        <div className="min-w-0 rounded-md border bg-card overflow-hidden" data-browser-view-card>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3">
            <div className="flex min-w-0 items-center gap-2 text-sm font-medium"><Globe className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true"/>Live browser<span className="font-normal text-muted-foreground capitalize">· {state}</span></div>
            <div className="flex flex-wrap items-center gap-2"><Action variant="ghost" className="!min-h-11 !min-w-11 !px-2 sm:!min-h-9" data-exit-browser-fullscreen={expanded || undefined}
              aria-label={expanded ? 'Exit fullscreen browser' : 'Open fullscreen browser'} onClick={() => expanded ? full.current.exit() : full.current.enter()}>{expanded ? <Minimize2 className="h-4 w-4" aria-hidden="true"/> : <Maximize2 className="h-4 w-4" aria-hidden="true"/>}<span className="hidden xl:inline">{expanded ? 'Exit viewer' : 'Expand viewer'}</span></Action></div>
          </div>
          <div className="min-w-0 p-3 pt-0">{browser}</div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,0.38fr)_minmax(0,0.62fr)] gap-3" data-browser-deck-summary>
          <section className="min-w-0 rounded-md border bg-card p-4"><h3 className="mb-2 flex items-center gap-3 text-sm font-semibold"><FileText className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true"/>Task</h3><div className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">{task || 'Inspect the website within this run’s approved scope.'}</div></section>
          <section className="min-w-0 rounded-md border bg-card p-4"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-3 text-sm font-semibold"><Clock3 className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true"/>Recent activity</h3><button type="button" className="min-h-11 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => select('activity')}>View activity</button></div><div className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">{recent || `Current recorded state: ${state}.`}</div></section>
        </div>
      </div>
      <aside id={`${id}-rail`} aria-label="Run information" className={`min-w-0 space-y-3 ${panel === 'rail'||reviewCount>0 ? 'block' : 'hidden'} lg:block`}>
        {reviewCount > 0 && <section className="hidden lg:block rounded-md border border-amber-500 bg-amber-500/5 p-4" data-browser-review-summary><div className="flex items-start gap-3"><AlertTriangle className="h-6 w-6 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true"/><div className="min-w-0"><h3 className="text-lg font-semibold">Review needed</h3><p role="status" className="mt-1 text-sm">{reviewCount} review item{reviewCount === 1 ? '' : 's'} {reviewCount === 1 ? 'needs' : 'need'} your attention.</p><button type="button" className="min-h-11 text-sm underline font-medium" onClick={() => select('review')}>Inspect review</button></div></div></section>}
        <div className="min-w-0 rounded-md border bg-card overflow-hidden">
          <nav aria-label="Run information panels" className="hidden lg:flex border-b px-3">{tabs.slice(1).map(([name, label]) => <button key={name} type="button" aria-pressed={rail === name} onClick={() => setRail(name)} className={tabClass(rail === name)}>{label}</button>)}</nav>
          <div className="p-4 lg:max-h-[650px] lg:overflow-y-auto" data-browser-information-scroll>
            <div className="space-y-3 text-sm" hidden={rail !== 'activity'}>{activity}</div>
            <div className="space-y-3 text-sm" hidden={rail !== 'details'}>{details}</div>
            <div className="space-y-3 text-sm" hidden={rail !== 'review'}>{review}</div>
          </div>
        </div>
      </aside>
    </div>
  </section>;
}

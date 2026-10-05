import { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, BookOpen, Globe, Maximize2, Minimize2 } from 'lucide-react';
import MobilePanelBar from '@/components/mock2/MobilePanelBar';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Action } from './shared';
import { createBrowserFullscreen } from './browser-fullscreen';

// One mounted viewer and one mounted feed: tabs change visibility, never the run.
export function BrowserProjectDeck({ workspace, browser, actions, activity, details, review, reviewActions, reviewCount = 0, reviewComplete = 0, runHistory, training, state }) {
  const [reviewOpen, setReviewOpen] = useState(false), [expanded, setExpanded] = useState(false);
  const box = useRef(null), fullscreen = useRef(null), previousCompletion = useRef(reviewComplete);
  const panel = workspace.panel, select = workspace.onSelect;
  useEffect(() => {
    fullscreen.current = createBrowserFullscreen({ element: box.current, onChange: setExpanded });
    return () => fullscreen.current?.close();
  }, []);
  useEffect(() => { if (workspace.initialReview) { select('activity'); setReviewOpen(true); } }, [workspace.initialReview]);
  useEffect(() => {
    if (reviewComplete > previousCompletion.current) { setReviewOpen(false); select('browser'); }
    previousCompletion.current = reviewComplete;
  }, [reviewComplete, select]);
  const inspect = () => { select('activity'); setReviewOpen(true); };
  const tabs = [{key:'activity',label:'Activity',icon:Activity,badge:reviewCount},{key:'browser',label:'Browser',icon:Globe},{key:'resources',label:'Resources',icon:BookOpen}];
  return <section ref={box} tabIndex={-1} aria-label="Browser Flightdeck" data-browser-flightdeck data-browser-fullscreen={expanded}
    className={`browser-project-deck flex min-h-0 min-w-0 flex-1 flex-col bg-background ${expanded ? 'fixed inset-0 z-[60] h-viewport p-3' : ''}`}>
    <header className="shrink-0 border-b p-4 space-y-2" data-browser-deck-title>
      <div className="flex flex-wrap items-center gap-3"><h1 className="min-w-0 break-words text-[28px] sm:text-[32px] font-semibold tracking-tight">{workspace.project.name}</h1>
        <span role="status" className={`rounded-full border px-3 py-1 text-sm ${reviewCount ? 'border-amber-500/70 bg-amber-500/10' : 'text-primary'}`}>{reviewCount ? 'Needs your help' : state || (workspace.project.current_version ? 'Guide saved' : 'No guide')}</span></div>
      {workspace.runLabel && <p className="text-xs text-muted-foreground">{workspace.runLabel}</p>}
      {actions && <div className="hidden flex-wrap gap-2 lg:flex">{actions}</div>}
      {workspace.notice}
    </header>
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,0.64fr)_minmax(0,0.36fr)] gap-4 lg:pt-4" data-browser-deck-columns>
      <div className={`min-w-0 min-h-0 overflow-y-auto p-4 lg:p-0 ${panel === 'browser' ? '' : 'hidden'} lg:block`} data-browser-view-scroll>
        <section className="rounded-lg border bg-card overflow-hidden" data-browser-view-card>
          <header className="flex items-center justify-between gap-3 p-3"><h2 className="flex items-center gap-2 text-sm font-semibold"><Globe className="h-5 w-5" aria-hidden="true"/>Live browser</h2>
            <Action variant="ghost" className="!min-h-11 !min-w-11 !px-2" aria-label={expanded?'Exit fullscreen browser':'Open fullscreen browser'} onClick={() => expanded ? fullscreen.current.exit() : fullscreen.current.enter()}>{expanded?<Minimize2 className="h-4 w-4" aria-hidden="true"/>:<Maximize2 className="h-4 w-4" aria-hidden="true"/>}</Action></header>
          <div className="p-3 pt-0">{browser || <div className="flex aspect-[16/10] items-center justify-center rounded-md bg-muted/30 p-6 text-center"><div className="space-y-2"><h3 className="font-semibold">Ready when you are</h3><p className="text-sm text-muted-foreground">Run this project from Activity to watch the browser here.</p><Action variant="outline" onClick={() => select('activity')}>Go to Activity</Action></div></div>}</div>
        </section>
        {reviewCount > 0 && <div role="status" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500 bg-amber-500/5 p-3 text-sm"><span>{reviewCount} items need your review</span><Action variant="outline" onClick={inspect}>Review requests</Action></div>}
        {actions && <div className="mt-3 flex flex-wrap gap-2 lg:hidden">{actions}</div>}
        <button type="button" onClick={() => select('activity')} className="min-h-11 w-full text-sm text-primary lg:hidden">Back to activity</button>
      </div>
      <aside className={`min-h-0 min-w-0 flex-col rounded-lg lg:border lg:bg-card ${panel === 'browser' ? 'hidden' : 'flex'} lg:flex`} aria-label="Project information">
        <nav className="hidden shrink-0 border-b lg:flex" aria-label="Project panels">{['activity','resources','details'].map(name => <button key={name} type="button" aria-pressed={panel === name || panel === 'browser' && name === 'activity'} onClick={() => select(name)} className={`min-h-11 min-w-0 flex-1 border-b-2 px-2 text-sm capitalize ${panel === name || panel === 'browser' && name === 'activity' ? 'border-primary text-foreground font-semibold' : 'border-transparent text-muted-foreground'}`}>{name}{name === 'activity' && reviewCount > 0 && <span className="ml-1 rounded-full bg-amber-400 px-1 text-xs text-black">{reviewCount}</span>}</button>)}</nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4" data-browser-information-scroll>
          <div hidden={!['activity','browser'].includes(panel)} className="space-y-4" data-project-activity>
            {reviewCount > 0 && <section className="rounded-md border border-amber-500 bg-amber-500/5 p-4 space-y-3" data-browser-review-summary><h2 className="flex gap-2 text-base font-semibold"><AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" aria-hidden="true"/>Review needed · {reviewCount} items</h2><p className="text-sm">Review the requests or outcomes that need your decision.</p><Action onClick={inspect}>Review requests</Action></section>}
            {workspace.activity}
            {activity}
          </div>
          <div hidden={panel !== 'resources'} className="space-y-4">{workspace.resources}{workspace.resourceTab === 'training' && training}{workspace.resourceTab === 'history' && runHistory}</div>
          <div hidden={panel !== 'details'} className="space-y-4">{workspace.details}{details}</div>
        </div>
      </aside>
    </div>
    <nav className="shrink-0 lg:hidden" aria-label="Project panels"><MobilePanelBar panels={tabs} current={panel} onSelect={select} onOpenNav={workspace.onOpenNav} onShowDetails={() => select('details')} detailsActive={panel === 'details'}/></nav>
    {workspace.dialogs}
    <Dialog open={reviewOpen} onOpenChange={value=>{if(!workspace.busy)setReviewOpen(value);}}><DialogContent onInteractOutside={event=>{if(workspace.busy)event.preventDefault();}} onEscapeKeyDown={event=>{if(workspace.busy)event.preventDefault();}} className="operations-dialog flex h-[90dvh] max-h-[90dvh] flex-col overflow-clip sm:max-w-2xl [&>button]:h-11 [&>button]:w-11">
      <DialogHeader className="shrink-0 pr-9"><DialogTitle>Review {reviewCount} {reviewCount === 1 ? 'item' : 'items'}</DialogTitle><DialogDescription>Choose a decision for each request. Review uncertain outcomes separately.</DialogDescription></DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto touch-pan-y space-y-4" data-review-scroll>{workspace.notice}{review || <p>No requests are waiting for review.</p>}</div>
      <footer className="shrink-0 border-t pt-3"><div className="flex gap-2"><Action variant="outline" disabled={workspace.busy} onClick={()=>setReviewOpen(false)}>Cancel</Action><div className="min-w-0 flex-1">{reviewActions}</div></div><p className="mt-2 text-xs text-muted-foreground">Each decision applies to the exact request shown. Return to the browser after submission.</p></footer>
    </DialogContent></Dialog>
  </section>;
}

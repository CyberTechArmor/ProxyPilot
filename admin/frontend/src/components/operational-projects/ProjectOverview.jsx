import { ArrowRight, Bot, CheckCircle2, FileText, KeyRound, Users } from 'lucide-react';
import { Action } from './shared';
import { BrowserRunSummary, BrowserRunHelp, RecentBrowserRuns } from './BrowserRunSummary';

// All counts and labels come from this permitted project's current response.
// The reference's example training videos and running tasks are never seeded.
export function ProjectOverview({ project:p, draft:d, records:r, activity:e, access:a,
  editable, agentCapability, browserRuntimeCapability, openSection, loadMore, busy, onUnavailable }) {
  const pending=d.pending_submission;
  const people=1+(a?.members?.filter(member=>member.active).length||0);
  const materialCount=d.evidence?.references?.length||0;
  const content=<div className="space-y-4" data-project-overview>
    <p className="whitespace-pre-wrap break-words text-muted-foreground">{p.description||'Add a purpose in Details to explain the work this project supports.'}</p>
    {p.archived_at&&<p className="rounded-md border bg-muted p-3 text-sm break-words">Archived: {p.archive_reason}</p>}
    {browserRuntimeCapability&&<BrowserRunHelp/>}
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4" data-overview-summary>
      <section className="operations-card rounded-md border bg-card p-4 space-y-4 min-w-0" aria-labelledby="overview-material">
        <header><h3 id="overview-material" className="text-lg font-semibold">Guide &amp; material</h3><p className="mt-1 text-sm text-muted-foreground">{materialCount} saved evidence reference{materialCount===1?'':'s'}</p></header>
        <div className="flex items-start gap-3 py-2"><FileText className="h-6 w-6 shrink-0 text-muted-foreground" aria-hidden="true"/><div className="min-w-0"><p className="font-medium break-words">{p.current_version?.title||d.title||'No guide yet'}</p><p className="text-sm text-muted-foreground mt-1">{p.current_version?'Approved procedure · v'+p.current_version.version_number:pending?'Saved snapshot ready to approve':'Save instructions as an approved version.'}</p></div></div>
        <Action variant="outline" className="gap-2" onClick={()=>openSection('Guide')}><FileText className="h-4 w-4" aria-hidden="true"/>{editable?'Open guide':'Read guide'}</Action>
        <p className="text-xs text-muted-foreground">Saving a guide starts no run. Capture and training imports are not available yet.</p>
        {agentCapability&&<div className="border-t pt-4 space-y-2"><h3 className="font-semibold flex items-center gap-2"><Bot className="h-5 w-5 text-muted-foreground" aria-hidden="true"/>Browser tasks</h3><p className="text-sm text-muted-foreground">{browserRuntimeCapability?'Open a public website, or prepare a bounded task. Public browsing needs no model, guide or connection.':'Browser task availability is checked separately from saved project guides.'}</p><Action variant="ghost" className="px-0 text-primary gap-2" onClick={()=>openSection('Agents')}>Open agents<ArrowRight className="h-4 w-4" aria-hidden="true"/></Action></div>}
      </section>
      <section className="operations-card rounded-md border bg-card p-4 space-y-4 min-w-0" aria-labelledby="overview-readiness">
        <header><h3 id="overview-readiness" className="text-lg font-semibold">Version &amp; readiness</h3></header>
        <ul className="space-y-3 text-sm"><li className="flex items-start gap-3"><CheckCircle2 className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true"/><span>{p.current_version?'Approved guide v'+p.current_version.version_number:'No approved guide saved'}</span></li><li className="flex items-start gap-3"><FileText className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true"/><span>{pending?'Pending snapshot requires Save and approve':d.status==='draft'?'Draft changes remain separate':'Version history is preserved'}</span></li></ul>
        <Action variant="ghost" className="px-0 text-primary gap-2" onClick={()=>openSection('Versions')}>View versions<ArrowRight className="h-4 w-4" aria-hidden="true"/></Action>
        {browserRuntimeCapability&&<RecentBrowserRuns/>}
        <details className="border-t pt-3"><summary className="min-h-11 cursor-pointer py-2 font-medium">Manual work records</summary><div className="space-y-3"><h3 className="font-semibold">Recent work records</h3>{r.runs.length?<ul className="divide-y">{r.runs.slice(0,3).map(row=><li key={row.id} className="py-2 text-sm break-words"><span className="capitalize">{row.outcome}</span><span className="text-muted-foreground"> · {row.corrects_run_id?'Correction':'Manual record'}</span></li>)}</ul>:<p className="text-sm text-muted-foreground">No manual work records yet.</p>}<Action variant="ghost" className="px-0 text-primary gap-2" onClick={()=>openSection('Runs')}>View work records<ArrowRight className="h-4 w-4" aria-hidden="true"/></Action></div></details>
        <details className="border-t pt-2"><summary className="min-h-11 cursor-pointer py-2 font-medium">Recent activity</summary><ul className="divide-y">{e.events.map(row=><li key={row.id} className="py-2 text-sm break-words"><p>{row.action.replaceAll('_',' ')}</p><time className="text-xs text-muted-foreground">{row.created_at}</time></li>)}</ul>{!e.events.length&&<p className="text-sm text-muted-foreground">No activity recorded yet.</p>}{e.next_cursor&&<Action disabled={busy} variant="outline" onClick={()=>loadMore('e')}>Load older activity</Action>}</details>
      </section>
    </div>
    <section className="operations-card rounded-md border bg-card p-4 min-w-0 space-y-3" data-overview-access aria-labelledby="overview-access">
      <h3 id="overview-access" className="text-lg font-semibold">Access &amp; connections</h3>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"><div className="space-y-3 text-sm"><p className="flex items-start gap-3"><Users className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true"/><span>People: {a?`${people} ${people===1?'person':'people'} with project access`:'Your role: '+p.own_role}</span></p><p className="flex items-start gap-3"><KeyRound className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true"/><span>Connection permissions are granted separately.</span></p></div><Action variant="ghost" className="text-primary gap-2 shrink-0 self-start" onClick={()=>openSection('Access')}>Manage access<ArrowRight className="h-4 w-4" aria-hidden="true"/></Action></div>
    </section>
  </div>;
  return browserRuntimeCapability?<BrowserRunSummary project={p} onUnavailable={onUnavailable}>{content}</BrowserRunSummary>:content;
}

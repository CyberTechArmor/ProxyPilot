// The cutover checklist — the post-import work, as state.
//
// Each row is a step the operator does with the ordinary tools (snapshot the
// guest, create the route, review egress, enter the secrets, health check,
// switch DNS, freeze the source, verify) and then marks here. The marking is
// not ceremony: it is what makes a cutover resumable across a page reload, a
// shift change and an audit, and it is what `completed` means.

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Check, Undo2 } from 'lucide-react';
import { BTN, Chip, SectionHeader, fmtDate } from './shared';

export default function CutoverChecklist({ migration, onStep, busy }) {
  const [noteFor, setNoteFor] = useState(null);
  const [note, setNote] = useState('');
  const progress = migration.checklist_progress;

  const mark = async (step, done) => {
    await onStep?.(step, done, done && noteFor === step ? note.trim() || null : null);
    setNoteFor(null); setNote('');
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <SectionHeader
          title={`Cutover checklist — ${progress.done} of ${progress.total}`}
          description="Do each step with the usual tools, then mark it here. The migration is complete when every required step is marked."
        />
        <div className="divide-y">
          {migration.checklist.map((s) => (
            <div key={s.id} className="py-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-sm font-medium ${s.done ? 'line-through text-muted-foreground' : ''}`}>{s.title}</span>
                    {!s.required && <Chip level="muted">optional</Chip>}
                    {s.tool && <Chip level="muted" mono title="the tool that does this step">{s.tool}</Chip>}
                  </div>
                  <p className="text-xs text-muted-foreground break-words mt-0.5">{s.detail}</p>
                  {s.done && (
                    <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1 break-words">
                      done {fmtDate(s.done_at)}{s.done_by ? ` by ${s.done_by}` : ''}{s.note ? ` — ${s.note}` : ''}
                    </p>
                  )}
                </div>
                <div className="shrink-0">
                  {s.done ? (
                    <Button size="sm" variant="ghost" className={BTN} disabled={busy} onClick={() => mark(s.id, false)} title="reopen">
                      <Undo2 className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button size="sm" className={BTN} disabled={busy} onClick={() => (noteFor === s.id ? mark(s.id, true) : setNoteFor(s.id))}>
                      <Check className="h-4 w-4 mr-1.5" />{noteFor === s.id ? 'Confirm' : 'Mark done'}
                    </Button>
                  )}
                </div>
              </div>
              {noteFor === s.id && !s.done && (
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    className="h-11 sm:h-9" autoFocus value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="What did you actually do? (optional, stored with the step)"
                    onKeyDown={(e) => { if (e.key === 'Enter') mark(s.id, true); }}
                  />
                  <Button variant="outline" className={BTN} onClick={() => { setNoteFor(null); setNote(''); }}>Cancel</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

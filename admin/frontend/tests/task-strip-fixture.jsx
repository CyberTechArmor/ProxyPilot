// Fixture for tests/task-strip.browser.mjs. Two views:
//   ?view=strips          — every TaskStrip state, isolated, inside the TIGHTEST
//                           real container (page padding + Card + CardContent,
//                           as the classic build view nests the chat on a phone).
//   ?view=chat&viewer=1   — the real BuildChat (Flightdeck's `fill` layout) over
//                           the API the browser test stubs with page.route.
import React from 'react';
import { createRoot } from 'react-dom/client';
import TaskStrip from '../src/components/mock2/TaskStrip';
import BuildChat from '../src/components/mock2/BuildChat';
import { Toaster } from '../src/components/ui/toaster';
import { Card, CardContent, CardHeader, CardTitle } from '../src/components/ui/card';
import { ThemeProvider } from '../src/context/ThemeContext';
import '../src/index.css';

const params = new URLSearchParams(location.search);
const LONG_GOAL = 'Add an invoice export with CSV and PDF formats, per-customer filters and a scheduled monthly email to the finance team';
const files = (key) => ({ task_json: `state/tasks/${key}/task.json`, handoff_md: `state/tasks/${key}/handoff.md` });
const base = {
  key: 't12-add-an-invoice-export-with-csv-and-pdf', id: 12, intent: 'build', unfinished: true, goal: LONG_GOAL,
  request_id: 34, last_cycle_id: 88, live: false, resumed: false, can_resume: true,
  last_verified_step: 'Checkpoint 1a2b3c4 committed', next_step: 'Resume from the last checkpoint',
  remaining: ['Run checks', 'Review changes'], blockers: [], uncertain: [],
  checks: [{ key: 'typecheck', status: 'passed' }, { key: 'lint', status: 'failed' }],
  completed_steps: [{ step: 'Build started', at: '2026-10-21T10:00:00.000Z' }, { step: 'Checkpoint 1a2b3c4 committed', at: '2026-10-21T10:04:00.000Z' }],
  files: files('t12-add-an-invoice-export-with-csv-and-pdf'),
  created_at: '2026-10-21T10:00:00.000Z', updated_at: '2026-10-21T10:05:00.000Z', finished_at: null,
};
const UNCERTAIN = [
  'A deploy was in progress when the build stopped — check whether the app serves the new version before deploying again',
  'Check whether the database migration "add invoices table" completed before repeating it',
  'Check whether the call to the payment provider completed before repeating it',
  'Check whether the email job was queued before repeating it',
];
export const STATES = {
  building: { ...base, status: 'active', live: true },
  resuming: { ...base, status: 'active', live: true, resumed: true },
  investigating: { ...base, intent: 'investigation', status: 'active', live: true, goal: 'Why does the invoice list load slowly on phones?' },
  interrupted: { ...base, status: 'interrupted', uncertain: UNCERTAIN },
  interrupted_plain: { ...base, status: 'interrupted', goal: 'Add invoice export' },
  failed: { ...base, status: 'failed', blockers: ['npm ERR! code ELIFECYCLE — the build script exited with status 1 while bundling src/invoices/export.ts'], uncertain: UNCERTAIN.slice(1, 2) },
  blocked: { ...base, status: 'blocked', can_resume: true, blockers: ['Over budget — this project used its monthly allowance'] },
  waiting: { ...base, status: 'blocked', can_resume: false, blockers: ['Waiting for answers to open questions'] },
};

function Gallery() {
  const viewer = params.get('viewer') === '1';
  return (
    <main className="p-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Task strip states</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {Object.entries(STATES).map(([name, task]) => (
            <div key={name} data-case={name}>
              <TaskStrip
                task={task} canAct={!viewer} online
                currentAction={task.live ? 'Running the checks…' : null}
                onResume={() => { window.__actions.push(['resume', name]); }}
                onStop={() => { window.__actions.push(['stop', name]); }}
                onShow={() => { window.__actions.push(['show', name]); }}
              />
            </div>
          ))}
        </CardContent>
      </Card>
    </main>
  );
}

function Chat() {
  const viewer = params.get('viewer') === '1';
  const project = { id: 7, name: 'Invoices', lifecycle: 'active', suggest_mode: 'off', design_approved_at: null, base_app_deployed_at: '2026-10-01T00:00:00Z', deploy_state: 'serving' };
  // Flightdeck's phone layout: the chat fills the space above the panel bar.
  return (
    <div className="flex h-[100dvh] flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <BuildChat
          projectId={7} project={project} cycle={null} canEdit={!viewer} online active={false}
          job={null} onStarted={() => { window.__started += 1; }} fill
        />
      </div>
      <div className="h-14 shrink-0 border-t" />
    </div>
  );
}

window.__actions = [];
window.__started = 0;
createRoot(document.getElementById('root')).render(
  <ThemeProvider>
    {params.get('view') === 'chat' ? <Chat /> : <Gallery />}
    <Toaster />
  </ThemeProvider>,
);

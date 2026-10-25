// Fixture for tests/foundation-panel.browser.mjs: the real ProjectFoundation
// panel inside the same container the project page gives it (the content
// wrapper's p-4 md:p-8, then the Details → Build tab's space-y-6 stack), with
// the real SudoProvider and Toaster. The API is stubbed by the test.
//   ?viewer=1          a project viewer (no write controls)
//   ?project=legacy    the project row says foundation_version: null
//   ?open=adopt-plan   open the move dialog and run its check (see the end)
import React from 'react';
import { createRoot } from 'react-dom/client';
import ProjectFoundation from '../src/components/mock2/ProjectFoundation';
import SudoProvider from '../src/components/SudoModal';
import { Toaster } from '../src/components/ui/toaster';
import { ThemeProvider } from '../src/context/ThemeContext';
import '../src/index.css';

const params = new URLSearchParams(location.search);
const viewer = params.get('viewer') === '1';
// The current API does not expose foundation_version on the project row yet;
// the default fixture project therefore omits it, exactly like today's row.
const project = params.get('project') === 'legacy'
  ? { id: 7, name: 'Invoices', lifecycle: 'active', foundation_version: null }
  : { id: 7, name: 'Invoices', lifecycle: 'active' };

createRoot(document.getElementById('root')).render(
  <ThemeProvider>
    <SudoProvider>
      <main className="p-4 md:p-8">
        <div className="space-y-6">
          <ProjectFoundation projectId={7} project={project} canEdit={!viewer} />
        </div>
      </main>
      <Toaster />
    </SudoProvider>
  </ThemeProvider>,
);

// ?open=adopt-plan: open "Move onto the application foundation" and run its
// check, for tests/foundation-panel-lighthouse.mjs (Lighthouse cannot click).
if (params.get('open') === 'adopt-plan') {
  const press = (selector, text) => new Promise((resolve) => {
    const t = setInterval(() => {
      const el = [...document.querySelectorAll(selector)].find((b) => !text || b.textContent.trim() === text);
      if (el) { clearInterval(t); el.click(); resolve(); }
    }, 50);
  });
  press('[data-foundation-adopt-start]').then(() => press('[data-foundation-dialog="adopt"] button', 'Check this project'));
}

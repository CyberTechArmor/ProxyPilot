// Application foundation — the database, file storage and search embeddings a
// Dev Studio app runs on (docs/features/app-foundation.md).
//
// One card per feature, each with its real health and its per-deployment
// switch. The database is always on. Storage and embeddings can be turned off
// (nothing is deleted) or switched to another provider; a switch is tested
// from inside the app before it takes over, and the jobs it starts (a verified
// copy, a re-embed into a new index) show their progress here with Cancel.
//
// Every write goes through lib/api.js: the sudo prompt opens on the 401 and the
// call is retried; a 409 refusal { code, message, options } is shown with its
// options turned into the next step (copy / start fresh, cancel the running
// job, …), never as a dead end. Credentials are write-only: inputs are never
// prefilled and "saved" comes from has_secret.
//
// The words and request bodies live in foundation-panel-logic.js (pure,
// tested by tests/foundation-panel-logic.test.mjs).
//
// MOBILE_FIRST: one column on phones, 2-column key/value grids from sm, 44px
// targets, dialogs full-screen below sm and completable at 360px
// (tests/foundation-panel.browser.mjs audits 360/375/768/1280).

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertTriangle, ChevronDown, Database, HardDrive, Layers, Loader2, RefreshCw, Search, X,
} from 'lucide-react';
import {
  ACTIVE_JOB_STATES, EXCEPTION_MAX, EXCEPTION_MIN, LEGACY_TEXT, LOCAL_DIMENSIONS, LOCAL_MODEL,
  OPENAI_DEFAULT_DIMENSIONS, OPENAI_DEFAULT_MODEL, STORAGE_HAS_OBJECTS,
  ackText, activeJobs, checkedAgo, dependentsOf, embeddingsCanKeepKey, embeddingsFormDefaults,
  embeddingsSwitchBody, embeddingsView, exceptionBody, healthView, isLegacy, jobFeature, jobIdOf,
  jobView, localWarning, nextSteps, otherWarnings, projectSaysLegacy, refusalNeedsMode, refusalOf,
  storageCanKeepKeys, storageFormDefaults, storageNeedsMode, storageSwitchBody, storageView, turnOffCopy,
  formatCount,
} from './foundation-panel-logic';

const TONE = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  info: 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-400',
  bad: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400',
  muted: 'border-border bg-muted text-muted-foreground',
};
const DOT = { ok: 'bg-emerald-500', info: 'bg-blue-500', warn: 'bg-amber-500', bad: 'bg-red-500', muted: 'bg-muted-foreground' };

// Full-screen below sm, a sheet from sm (MOBILE_FIRST §3). content-start keeps
// a short form at the top instead of spreading it over a tall phone screen.
const SHEET = 'max-w-full h-full content-start rounded-none sm:max-w-lg sm:h-auto sm:max-h-[90vh] sm:rounded-lg';
const SMALL = 'max-w-full h-full content-start rounded-none sm:max-w-md sm:h-auto sm:rounded-lg';
const TAP = 'min-h-[44px] w-full sm:w-auto';

function StatusChip({ view }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[view.tone] || TONE.muted}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[view.tone] || DOT.muted}`} aria-hidden="true" />
      {view.label}
    </span>
  );
}

function Meta({ items }) {
  const rows = items.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!rows.length) return null;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
      {rows.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function FeatureSection({ name, icon: Icon, title, subtitle, view, children, actions }) {
  const checked = checkedAgo(view.checkedAt);
  return (
    // A grid so that on a phone the facts come first and the buttons last,
    // while from sm the buttons sit beside the title (MOBILE_FIRST §4).
    <section data-foundation-card={name} aria-label={title} className="grid grid-cols-1 gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 space-y-1 sm:col-start-1 sm:row-start-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h3 className="font-medium">{title}</h3>
          <StatusChip view={view} />
        </div>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? (
        <div className="order-last flex flex-col gap-2 sm:order-none sm:col-start-2 sm:row-start-1 sm:flex-row sm:flex-wrap sm:justify-end sm:self-start">{actions}</div>
      ) : null}
      <div className="min-w-0 space-y-3 sm:col-span-2">{children}</div>
      {view.detail || checked ? (
        <p className="order-last flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground sm:order-none sm:col-span-2">
          {view.detail ? <span className="break-words">{view.detail}</span> : null}
          {checked ? <span>{checked}</span> : null}
        </p>
      ) : null}
    </section>
  );
}

function Banner({ tone = 'warn', children, ...rest }) {
  return (
    <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${TONE[tone]}`} {...rest}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

// A refusal with its options as buttons. Always at least one way forward.
function RefusalNotice({ refusal, featureName, onStep, busy, hint, fallback = true }) {
  if (!refusal) return null;
  const steps = nextSteps(refusal, featureName, { fallback });
  return (
    <Banner tone="warn" data-foundation-refusal={refusal.code || 'refused'}>
      <p className="break-words">{refusal.message}</p>
      {hint ? <p className="text-xs">{hint}</p> : null}
      {steps.length ? <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {steps.map((s, i) => (
          <Button
            key={`${s.kind}-${s.mode || i}`} type="button" variant={i === 0 ? 'default' : 'outline'}
            className={`${TAP} ${i === 0 ? '' : 'text-foreground'}`} disabled={busy} onClick={() => onStep(s, refusal)}
          >
            {s.label}
          </Button>
        ))}
      </div> : null}
    </Banner>
  );
}

function JobProgress({ job, onCancel, onDismiss, busy }) {
  const v = jobView(job);
  return (
    <div data-foundation-job={v.feature || 'job'} className="space-y-2 rounded-md border bg-muted/30 p-3" role="status" aria-live="polite">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{v.title}</p>
          <p className="text-xs text-muted-foreground">
            {v.stateLabel}{v.phaseText ? ` · ${v.phaseText}` : ''}{v.progressText ? ` · ${v.progressText}` : ''}
          </p>
        </div>
        {v.cancellable ? (
          <Button type="button" variant="outline" className={TAP} disabled={busy} onClick={() => onCancel(v.id)}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}Cancel
          </Button>
        ) : null}
        {!v.active && onDismiss ? (
          <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0 self-end sm:h-9 sm:w-9 sm:self-auto" onClick={() => onDismiss(v.id)} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
      {v.active ? (
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={v.title}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={v.percent ?? undefined}
        >
          <div
            className={`h-full rounded-full bg-primary transition-all ${v.percent == null ? 'w-1/3 animate-pulse' : ''}`}
            style={v.percent == null ? undefined : { width: `${v.percent}%` }}
          />
        </div>
      ) : null}
      {v.outcome ? <p className={`text-xs ${v.failed ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>{v.outcome}</p> : null}
    </div>
  );
}

function Field({ id, label, hint, error, children }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p className="text-xs text-red-600 dark:text-red-400" id={`${id}-error`}>{error}</p> : null}
    </div>
  );
}

function Choice({ name, value, checked, onChange, title, description, disabled }) {
  return (
    <label className={`flex min-h-[44px] cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${checked ? 'border-primary bg-primary/5' : ''} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}>
      <input
        type="radio" name={name} value={value} checked={checked} disabled={disabled}
        onChange={() => onChange(value)} className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
      />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        {description ? <span className="block text-xs text-muted-foreground">{description}</span> : null}
      </span>
    </label>
  );
}

function Check({ id, checked, onChange, children, error }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
        <span className="min-w-0 flex-1">{children}</span>
      </label>
      {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}

function SavedHint({ saved, keep }) {
  if (!saved) return null;
  return <span className="ml-1 text-xs font-normal text-emerald-700 dark:text-emerald-400">Saved{keep ? ' — leave empty to keep it' : ''}</span>;
}

// ---------------------------------------------------------------------------
// Turn off — what stops working, and that nothing is deleted.
// ---------------------------------------------------------------------------
function TurnOffDialog({ open, featureName, feature, dependents, onClose, onConfirm, busy, refusal, onStep }) {
  const label = featureName === 'storage' ? 'file storage' : 'search embeddings';
  const hasSteps = nextSteps(refusal, featureName, { fallback: false }).length > 0;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className={SMALL} data-foundation-dialog="off">
        <DialogHeader>
          <DialogTitle>Turn off {label}?</DialogTitle>
          <DialogDescription>This stops working while it is off:</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {dependents.map((d) => <li key={d}>{d}</li>)}
        </ul>
        <p className="text-sm">{turnOffCopy(featureName, feature)}</p>
        <RefusalNotice
          refusal={refusal} featureName={featureName} onStep={onStep} busy={busy} fallback={false}
          hint={refusal?.code === STORAGE_HAS_OBJECTS ? 'Both choices move the app to an external S3 first.' : null}
        />
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button type="button" variant="outline" className="h-11 sm:h-10" onClick={onClose} disabled={busy}>
            {hasSteps ? 'Keep it on' : 'Cancel'}
          </Button>
          {!hasSteps ? (
            <Button type="button" variant="destructive" className="h-11 sm:h-10" onClick={onConfirm} disabled={busy}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}{refusal ? 'Try again' : 'Turn off'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Storage switch
// ---------------------------------------------------------------------------
function StorageDialog({ open, storage, initial, onClose, onSubmit, busy, refusal, onStep }) {
  const [form, setForm] = useState(() => storageFormDefaults(storage));
  const [errors, setErrors] = useState({});
  useEffect(() => {
    if (!open) return;
    setForm({ ...storageFormDefaults(storage), ...(initial || {}) });
    setErrors({});
    // Reset only when the dialog opens; the storage row may refresh under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => { const n = { ...e }; for (const k of Object.keys(patch)) delete n[k]; return n; });
  };
  const needsMode = storageNeedsMode({ storage, refusal, provider: form.provider });
  const keep = storageCanKeepKeys(storage, form.provider);
  const from = storage?.provider || 'bundled';
  const count = refusal?.objects ?? storageView(storage).objects;
  // Steps that are not a mode choice (e.g. a running job) still need buttons;
  // the copy/fresh choice is the radio group below.
  const otherRefusal = refusal && !refusalNeedsMode(refusal) ? refusal : null;
  // When the server asks for the copy/fresh choice, bring it into view.
  const modeRef = useRef(null);
  useEffect(() => {
    if (refusal && refusalNeedsMode(refusal)) modeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [refusal]);
  const submit = (e) => {
    e.preventDefault();
    const r = storageSwitchBody(form, { storage, needsMode });
    setErrors(r.errors);
    if (r.ok) onSubmit(r.body);
  };
  const err = (k) => errors[k];
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className={SHEET} data-foundation-dialog="storage">
        <DialogHeader>
          <DialogTitle>Switch file storage</DialogTitle>
          <DialogDescription>The new storage is tested from inside the app before it takes over.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">Keep files in</legend>
            <Choice
              name="fs-provider" value="bundled" checked={form.provider === 'bundled'} onChange={(v) => set({ provider: v })}
              disabled={from === 'bundled'}
              title={`Bundled SeaweedFS${from === 'bundled' ? ' (in use)' : ''}`} description="Inside this app's container."
            />
            <Choice
              name="fs-provider" value="external" checked={form.provider === 'external'} onChange={(v) => set({ provider: v })}
              title={`External S3${from === 'external' ? ' (in use)' : ''}`} description="Cloudflare R2, AWS S3, Backblaze B2, MinIO or any S3-compatible service."
            />
            {err('provider') ? <p className="text-xs text-red-600 dark:text-red-400">{err('provider')}</p> : null}
          </fieldset>

          {form.provider === 'external' ? (
            <div className="space-y-3">
              <Field id="fs-endpoint" label="Endpoint URL" error={err('endpoint')}>
                <Input id="fs-endpoint" className="h-11 sm:h-10" inputMode="url" autoComplete="off" placeholder="https://<account>.r2.cloudflarestorage.com" value={form.endpoint} onChange={(e) => set({ endpoint: e.target.value })} aria-invalid={!!err('endpoint')} />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field id="fs-region" label="Region" hint="Cloudflare R2 uses auto." error={err('region')}>
                  <Input id="fs-region" className="h-11 sm:h-10" autoComplete="off" value={form.region} onChange={(e) => set({ region: e.target.value })} aria-invalid={!!err('region')} />
                </Field>
                <Field id="fs-bucket" label="Bucket" error={err('bucket')}>
                  <Input id="fs-bucket" className="h-11 sm:h-10" autoComplete="off" value={form.bucket} onChange={(e) => set({ bucket: e.target.value })} aria-invalid={!!err('bucket')} />
                </Field>
              </div>
              <Field id="fs-prefix" label="Folder (optional)" hint="Keep the app's files under this prefix inside the bucket." error={err('prefix')}>
                <Input id="fs-prefix" className="h-11 sm:h-10" autoComplete="off" placeholder="my-app/" value={form.prefix} onChange={(e) => set({ prefix: e.target.value })} />
              </Field>
              {/* The whole row is the label, so the tap target is the row, not the 24px switch. */}
              <label htmlFor="fs-path-style" className="flex min-h-[44px] cursor-pointer items-start justify-between gap-3 rounded-md border p-3" data-foundation-path-style>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">Path-style addresses</span>
                  <span className="block text-xs text-muted-foreground">Turn on for MinIO and most self-hosted S3. Cloudflare R2 works either way. Leave off for AWS S3.</span>
                </span>
                <Switch id="fs-path-style" checked={!!form.force_path_style} onCheckedChange={(v) => set({ force_path_style: v })} className="mt-0.5" />
              </label>
              <Field id="fs-key-id" label={<>Access key ID<SavedHint saved={keep} keep /></>} error={err('access_key_id')}>
                <Input id="fs-key-id" type="password" className="h-11 sm:h-10 font-mono text-xs" autoComplete="off" value={form.access_key_id} onChange={(e) => set({ access_key_id: e.target.value })} aria-invalid={!!err('access_key_id')} />
              </Field>
              <Field id="fs-secret" label={<>Secret access key<SavedHint saved={keep} keep /></>} hint="Stored encrypted. Never shown again." error={err('secret_access_key')}>
                <Input id="fs-secret" type="password" className="h-11 sm:h-10 font-mono text-xs" autoComplete="new-password" value={form.secret_access_key} onChange={(e) => set({ secret_access_key: e.target.value })} aria-invalid={!!err('secret_access_key')} />
              </Field>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">The bundled storage starts again on its own preserved volume.</p>
          )}

          {needsMode ? (
            <fieldset ref={modeRef} className="space-y-2" data-foundation-mode>
              <legend className="mb-1 break-words text-sm font-medium">
                {refusal && refusalNeedsMode(refusal)
                  ? refusal.message
                  : `This storage holds ${count ? `${formatCount(count)} file${count === 1 ? '' : 's'}` : 'files'}. What should happen to them?`}
              </legend>
              <Choice
                name="fs-mode" value="copy" checked={form.mode === 'copy'} onChange={(v) => set({ mode: v })}
                title="Copy everything to the new storage (verified)"
                description="Every file is copied and checked (size and checksum) before the switch. You can cancel while it runs."
              />
              <Choice
                name="fs-mode" value="fresh" checked={form.mode === 'fresh'} onChange={(v) => set({ mode: v })}
                title="Start fresh" description="The new storage starts empty and takes over right away."
              />
              {err('mode') ? <p className="text-xs text-red-600 dark:text-red-400">{err('mode')}</p> : null}
              <Check id="fs-ack" checked={!!form.acknowledge} onChange={(v) => set({ acknowledge: v })} error={err('acknowledge')}>
                {ackText(from)}
              </Check>
            </fieldset>
          ) : null}

          <RefusalNotice refusal={otherRefusal} featureName="storage" onStep={onStep} busy={busy} fallback={false} />

          <DialogFooter className="gap-2 sm:space-x-0">
            <Button type="button" variant="outline" className="h-11 sm:h-10" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" className="h-11 sm:h-10" disabled={busy}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {needsMode && form.mode === 'copy' ? 'Start the copy' : 'Switch storage'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Embeddings switch
// ---------------------------------------------------------------------------
function EmbeddingsDialog({ open, embeddings, initialProvider, warning, onClose, onSubmit, busy, refusal, onStep }) {
  const [form, setForm] = useState(() => embeddingsFormDefaults(embeddings, initialProvider));
  const [errors, setErrors] = useState({});
  useEffect(() => {
    if (!open) return;
    setForm(embeddingsFormDefaults(embeddings, initialProvider));
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => { const n = { ...e }; for (const k of Object.keys(patch)) delete n[k]; delete n.form; return n; });
  };
  const pick = (p) => { setForm(embeddingsFormDefaults(embeddings, p)); setErrors({}); };
  const current = embeddings?.provider;
  const keep = embeddingsCanKeepKey(embeddings, form.provider);
  const submit = (e) => {
    e.preventDefault();
    const r = embeddingsSwitchBody(form, { embeddings });
    setErrors(r.errors);
    if (r.ok) onSubmit(r.body);
  };
  const err = (k) => errors[k];
  const inUse = (p) => (current === p ? ' (in use)' : '');
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className={SHEET} data-foundation-dialog="embeddings">
        <DialogHeader>
          <DialogTitle>Switch embedding provider</DialogTitle>
          <DialogDescription>
            A new model means a new search index. The app re-embeds its content into it and keeps using the
            current index until the new one passes its checks; then it switches. The old index is kept.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">Provider</legend>
            <Choice name="em-provider" value="openai" checked={form.provider === 'openai'} onChange={pick} title={`OpenAI${inUse('openai')}`} description="Production-quality search. Needs an API key." />
            <Choice name="em-provider" value="openai_compatible" checked={form.provider === 'openai_compatible'} onChange={pick} title={`OpenAI-compatible${inUse('openai_compatible')}`} description="Any service with an OpenAI-style embeddings API." />
            <Choice name="em-provider" value="local" checked={form.provider === 'local'} onChange={pick} title={`Local model${inUse('local')}`} description="Runs inside the app's container. Development quality." />
          </fieldset>

          {form.provider === 'local' ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground"><span className="font-mono text-xs">{LOCAL_MODEL}</span>, {LOCAL_DIMENSIONS} dimensions.</p>
              <Banner tone="warn"><p>{warning}</p></Banner>
            </div>
          ) : (
            <div className="space-y-3">
              {form.provider === 'openai_compatible' ? (
                <Field id="em-base" label="Base URL" hint="The URL that ends before /embeddings, for example https://api.example.com/v1." error={err('base_url')}>
                  <Input id="em-base" className="h-11 sm:h-10" inputMode="url" autoComplete="off" value={form.base_url} onChange={(e) => set({ base_url: e.target.value })} aria-invalid={!!err('base_url')} />
                </Field>
              ) : null}
              <Field
                id="em-key" label={<>API key{form.provider === 'openai_compatible' ? ' (if the service needs one)' : ''}<SavedHint saved={keep} keep /></>}
                hint="Stored encrypted. Never shown again." error={err('api_key')}
              >
                <Input id="em-key" type="password" className="h-11 sm:h-10 font-mono text-xs" autoComplete="new-password" value={form.api_key} onChange={(e) => set({ api_key: e.target.value })} aria-invalid={!!err('api_key')} />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field id="em-model" label="Model" error={err('model')} hint={form.provider === 'openai' ? `Default ${OPENAI_DEFAULT_MODEL}.` : null}>
                  <Input id="em-model" className="h-11 sm:h-10 font-mono text-xs" autoComplete="off" value={form.model} onChange={(e) => set({ model: e.target.value })} aria-invalid={!!err('model')} />
                </Field>
                <Field id="em-dims" label="Dimensions" error={err('dimensions')} hint={form.provider === 'openai' ? `Default ${OPENAI_DEFAULT_DIMENSIONS}.` : null}>
                  <Input id="em-dims" className="h-11 sm:h-10" inputMode="numeric" autoComplete="off" value={form.dimensions} onChange={(e) => set({ dimensions: e.target.value.replace(/[^\d]/g, '') })} aria-invalid={!!err('dimensions')} />
                </Field>
              </div>
            </div>
          )}

          {err('form') ? <p className="text-sm text-muted-foreground">{err('form')}</p> : null}
          <RefusalNotice refusal={refusal} featureName="embeddings" onStep={onStep} busy={busy} fallback={false} />

          <DialogFooter className="gap-2 sm:space-x-0">
            <Button type="button" variant="outline" className="h-11 sm:h-10" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" className="h-11 sm:h-10" disabled={busy}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}Switch and re-embed
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Database exception — the person's own explicit request for SQLite.
// ---------------------------------------------------------------------------
function DatabaseException({ projectId, canEdit }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ loading: true, exception: null, error: '' });
  const [recordOpen, setRecordOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [text, setText] = useState('');
  const [ack, setAck] = useState(false);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.mock2DatabaseException(projectId);
      setState({ loading: false, exception: r?.exception || null, error: '' });
    } catch (e) {
      setState({ loading: false, exception: null, error: e?.message || 'Could not read the exception.' });
    }
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const record = async (e) => {
    e.preventDefault();
    const r = exceptionBody(text, ack);
    setErrors(r.errors);
    if (!r.ok) return;
    setBusy(true); setFailure('');
    try {
      const res = await api.mock2SetDatabaseException(projectId, r.body);
      setState({ loading: false, exception: res?.exception || { engine: 'sqlite', request_text: r.body.request_text }, error: '' });
      setRecordOpen(false); setText(''); setAck(false);
      toast({ title: 'Exception recorded', description: 'Builds may use SQLite for this app, and their prompts quote your request.' });
      load();
    } catch (err) {
      setFailure(err?.message || 'Could not record the exception.');
    } finally { setBusy(false); }
  };

  const clear = async () => {
    setBusy(true); setFailure('');
    try {
      await api.mock2ClearDatabaseException(projectId);
      setState({ loading: false, exception: null, error: '' });
      setClearOpen(false);
      toast({ title: 'Exception cleared', description: 'Builds use PostgreSQL only again.' });
    } catch (err) {
      setFailure(err?.message || 'Could not clear the exception.');
    } finally { setBusy(false); }
  };

  const ex = state.exception;
  const len = text.trim().length;
  return (
    <section data-foundation-exception className="rounded-lg border">
      <button
        type="button" aria-expanded={open} aria-controls="foundation-exception-body"
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Database exception</span>
          <span className="block text-xs text-muted-foreground">
            {state.loading ? 'Checking…' : ex ? 'SQLite exception recorded' : 'None recorded. The app uses PostgreSQL.'}
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open ? (
        <div id="foundation-exception-body" className="space-y-3 border-t px-4 py-3 text-sm">
          <p>This app must use PostgreSQL. Record an exception only when you explicitly asked for SQLite.</p>
          {state.error ? <p className="text-xs text-red-600 dark:text-red-400">{state.error}</p> : null}
          {ex ? (
            <div className="space-y-2">
              <blockquote className="whitespace-pre-wrap break-words rounded-md border-l-4 border-amber-500/60 bg-muted/40 p-3 text-sm">
                {ex.request_text}
              </blockquote>
              <p className="text-xs text-muted-foreground">
                {`${String(ex.engine || 'sqlite').toUpperCase() === 'SQLITE' ? 'SQLite' : ex.engine}`}
                {ex.recorded_by ? ` · recorded by ${ex.recorded_by}` : ''}
                {ex.created_at ? ` · ${String(ex.created_at).slice(0, 10)}` : ''}
              </p>
              {canEdit ? (
                <Button type="button" variant="outline" className={TAP} onClick={() => { setFailure(''); setClearOpen(true); }}>
                  Clear the exception
                </Button>
              ) : null}
            </div>
          ) : canEdit ? (
            <Button type="button" variant="outline" className={TAP} onClick={() => { setFailure(''); setErrors({}); setRecordOpen(true); }}>
              Record an exception
            </Button>
          ) : null}
        </div>
      ) : null}

      <Dialog open={recordOpen} onOpenChange={(o) => { if (!o && !busy) setRecordOpen(false); }}>
        <DialogContent className={SHEET} data-foundation-dialog="exception">
          <DialogHeader>
            <DialogTitle>Record a SQLite exception</DialogTitle>
            <DialogDescription>
              Builds may then use SQLite for this app, and their prompts quote your words. Nothing a build writes can
              create this.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={record} className="space-y-4" noValidate>
            <Field id="ex-text" label="Your request, in your own words" error={errors.request_text}>
              <textarea
                id="ex-text" rows={5} maxLength={EXCEPTION_MAX + 200}
                className="flex min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="For example: Use SQLite for this app — it runs offline on one laptop."
                value={text} onChange={(e) => { setText(e.target.value); setErrors((x) => ({ ...x, request_text: undefined })); }} aria-invalid={!!errors.request_text} aria-describedby="ex-count"
              />
              <p id="ex-count" className={`text-xs ${len > EXCEPTION_MAX || (len > 0 && len < EXCEPTION_MIN) ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
                {len} / {EXCEPTION_MAX} characters (at least {EXCEPTION_MIN})
              </p>
            </Field>
            <Check id="ex-ack" checked={ack} onChange={(v) => { setAck(v); setErrors((x) => ({ ...x, acknowledge: undefined })); }} error={errors.acknowledge}>
              I explicitly asked for SQLite for this app.
            </Check>
            {failure ? <Banner tone="bad"><p className="break-words">{failure}</p></Banner> : null}
            <DialogFooter className="gap-2 sm:space-x-0">
              <Button type="button" variant="outline" className="h-11 sm:h-10" onClick={() => setRecordOpen(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" className="h-11 sm:h-10" disabled={busy}>
                {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}Record exception
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={clearOpen} onOpenChange={(o) => { if (!o && !busy) setClearOpen(false); }}>
        <DialogContent className={SMALL} data-foundation-dialog="exception-clear">
          <DialogHeader>
            <DialogTitle>Clear the SQLite exception?</DialogTitle>
            <DialogDescription>Builds go back to PostgreSQL only. A build that adds SQLite again cannot finish.</DialogDescription>
          </DialogHeader>
          {failure ? <Banner tone="bad"><p className="break-words">{failure}</p></Banner> : null}
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button type="button" variant="outline" className="h-11 sm:h-10" onClick={() => setClearOpen(false)} disabled={busy}>Cancel</Button>
            <Button type="button" className="h-11 sm:h-10" onClick={clear} disabled={busy}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}Clear exception
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------
const FEATURE_WORD = { storage: 'File storage', embeddings: 'Search embeddings' };

// A write may answer `job` as an id or as a partial row; either way it is
// tracked (and polled) until the server says it ended.
function asJob(job, featureName) {
  const id = jobIdOf(job);
  if (!id) return null;
  const base = { kind: featureName === 'storage' ? 'storage_migrate' : 'reembed', state: 'queued', progress: {} };
  return typeof job === 'object' ? { ...base, ...job, id } : { ...base, id };
}

export default function ProjectFoundation({ projectId, project = null, canEdit = false }) {
  const { toast } = useToast();
  const legacyByProject = projectSaysLegacy(project);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(legacyByProject ? 'legacy' : 'loading'); // loading | ready | legacy | error
  const [loadError, setLoadError] = useState('');
  const [checking, setChecking] = useState(false);
  const [busyFeature, setBusyFeature] = useState(null);
  const busy = !!busyFeature;
  const [jobs, setJobs] = useState({});
  const [cancelling, setCancelling] = useState(null);
  // { type: 'off'|'storage'|'embeddings', feature?, refusal?, initial?, provider? }
  const [dialog, setDialog] = useState(null);
  // A refusal for an action taken straight from a card (Turn on, Cancel).
  const [notice, setNotice] = useState({});
  const startingPolls = useRef(0);

  const mergeJobs = useCallback((list) => {
    if (!list?.length) return;
    setJobs((prev) => {
      const next = { ...prev };
      for (const j of list) { const id = jobIdOf(j); if (id) next[id] = { ...(next[id] || {}), ...j, id }; }
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    if (legacyByProject) return;
    try {
      const d = await api.mock2Foundation(projectId);
      setData(d);
      setLoadError('');
      setStatus(isLegacy(null, d) ? 'legacy' : 'ready');
      mergeJobs(activeJobs(d));
    } catch (e) {
      if (e?.status === 404 && !project?.foundation_version) { setStatus('legacy'); return; }
      setLoadError(e?.message || 'Could not read the foundation status.');
      setStatus((s) => (s === 'ready' ? 'ready' : 'error'));
    }
  }, [projectId, legacyByProject, project?.foundation_version, mergeJobs]);
  useEffect(() => { load(); }, [load]);

  // A service that is still starting is re-read for up to two minutes.
  const starting = ['database', 'storage', 'embeddings'].some((f) => data?.[f]?.health?.status === 'starting');
  useEffect(() => {
    if (!starting) { startingPolls.current = 0; return undefined; }
    if (startingPolls.current >= 24) return undefined;
    const t = setTimeout(() => { startingPolls.current += 1; load(); }, 5000);
    return () => clearTimeout(t);
  }, [starting, data, load]);

  // Poll every job that is still queued or running; re-read the panel when one ends.
  const activeIds = Object.values(jobs).filter((j) => ACTIVE_JOB_STATES.includes(j.state)).map((j) => j.id).sort().join(',');
  useEffect(() => {
    if (!activeIds) return undefined;
    const ids = activeIds.split(',');
    const t = setInterval(async () => {
      let ended = false;
      const updates = [];
      for (const id of ids) {
        try {
          const r = await api.mock2FoundationJob(projectId, id);
          const job = r?.job || r;
          if (job && typeof job === 'object') {
            updates.push({ ...job, id });
            if (!ACTIVE_JOB_STATES.includes(job.state)) ended = true;
          }
        } catch { /* transient — the next tick retries */ }
      }
      mergeJobs(updates);
      if (ended) load();
    }, 2000);
    return () => clearInterval(t);
  }, [activeIds, projectId, mergeJobs, load]);

  const checkNow = async () => {
    setChecking(true);
    try {
      const d = await api.mock2FoundationHealth(projectId);
      if (d && typeof d === 'object' && d.foundation_version) { setData(d); mergeJobs(activeJobs(d)); } else await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not run the checks', description: e?.message || 'unknown error' });
    } finally { setChecking(false); }
  };

  const track = (job, featureName) => {
    const j = asJob(job, featureName);
    if (j) setJobs((prev) => ({ ...prev, [j.id]: { ...(prev[j.id] || {}), ...j } }));
  };

  const write = (featureName, body) => (featureName === 'storage'
    ? api.mock2FoundationStorage(projectId, body)
    : api.mock2FoundationEmbeddings(projectId, body));

  const cancelJob = async (jobId, featureName) => {
    if (!jobId) { load(); return; }
    setCancelling(jobId);
    try {
      const r = await api.mock2CancelFoundationJob(projectId, jobId);
      const job = r?.job || null;
      setJobs((prev) => ({ ...prev, [jobId]: { ...(prev[jobId] || { id: jobId }), ...(job || {}), state: job?.state || 'cancelled', id: jobId } }));
      setNotice((n) => ({ ...n, [featureName]: null }));
      toast({ title: 'Cancelled', description: 'Nothing was switched; the current one stays in use.' });
      load();
    } catch (e) {
      setNotice((n) => ({ ...n, [featureName]: refusalOf(e) }));
    } finally { setCancelling(null); }
  };

  const jobFor = (featureName) => Object.values(jobs).find((j) => jobFeature(j) === featureName && ACTIVE_JOB_STATES.includes(j.state));

  // Turn a refusal option into the next step.
  const onStep = async (featureName, step, refusal) => {
    const feature = data?.[featureName];
    if (step.kind === 'mode') {
      setDialog({ type: 'storage', refusal: refusal?.code ? refusal : { code: STORAGE_HAS_OBJECTS, message: refusal?.message, options: [] }, initial: { provider: feature?.provider === 'external' ? 'bundled' : 'external', mode: step.mode } });
      return;
    }
    if (step.kind === 'switch') {
      setDialog(featureName === 'storage' ? { type: 'storage', refusal: refusalNeedsMode(refusal) ? refusal : null } : { type: 'embeddings' });
      return;
    }
    if (step.kind === 'credentials') {
      setDialog(featureName === 'storage'
        ? { type: 'storage', initial: { provider: 'external' } }
        : { type: 'embeddings', provider: feature?.provider && feature.provider !== 'local' ? feature.provider : 'openai' });
      return;
    }
    if (step.kind === 'cancel_job') {
      setDialog(null);
      await cancelJob(refusal?.jobId || jobIdOf(jobFor(featureName)), featureName);
      return;
    }
    if (step.kind === 'show_job' && refusal?.jobId) {
      // The running job may belong to the other feature: read it, so its own
      // kind decides which card shows it.
      try {
        const r = await api.mock2FoundationJob(projectId, refusal.jobId);
        const job = r?.job || r;
        if (job && typeof job === 'object') mergeJobs([{ ...job, id: refusal.jobId }]);
      } catch { /* the panel re-read below lists it if it is still running */ }
    }
    setDialog(null);
    setNotice((n) => ({ ...n, [featureName]: null }));
    load();
  };

  const submit = async (featureName, body, { okTitle, okText } = {}) => {
    setBusyFeature(featureName);
    try {
      const r = await write(featureName, body);
      if (r?.job) track(r.job, featureName);
      setDialog(null);
      setNotice((n) => ({ ...n, [featureName]: null }));
      toast({ title: okTitle, description: okText });
      load();
    } catch (e) {
      const refusal = refusalOf(e);
      if (dialog) setDialog((d) => (d ? { ...d, refusal } : d));
      else setNotice((n) => ({ ...n, [featureName]: refusal }));
    } finally { setBusyFeature(null); }
  };

  const turnOn = (featureName) => submit(featureName, { action: 'on' }, {
    okTitle: `${FEATURE_WORD[featureName]} is on`,
    okText: featureName === 'storage' ? 'It starts on the same files it had.' : 'Search is available again.',
  });
  const turnOff = (featureName) => submit(featureName, { action: 'off' }, {
    okTitle: `${FEATURE_WORD[featureName]} is off`, okText: 'No data was deleted. Turn it on to bring it back.',
  });

  // ---- render ----
  const header = (
    <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <CardTitle className="flex items-center gap-2 text-base"><Layers className="h-4 w-4" /> Application foundation</CardTitle>
        {status !== 'legacy' ? (
          <CardDescription>The database, file storage and search this app runs on, inside its own container.</CardDescription>
        ) : null}
      </div>
      {status === 'ready' && canEdit ? (
        <Button type="button" variant="outline" className="min-h-[44px] self-start" onClick={checkNow} disabled={checking}>
          {checking ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
          Check now
        </Button>
      ) : null}
    </CardHeader>
  );

  if (status === 'legacy') {
    return (
      <Card data-foundation-panel="legacy">
        {header}
        <CardContent><p className="text-sm text-muted-foreground">{LEGACY_TEXT}</p></CardContent>
      </Card>
    );
  }
  if (status !== 'ready' || !data) {
    return (
      <Card data-foundation-panel={status}>
        {header}
        <CardContent className="space-y-3 text-sm">
          {status === 'loading' ? (
            <p className="flex items-center gap-2 text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" /> Reading the foundation…</p>
          ) : (
            <>
              <p className="break-words text-red-600 dark:text-red-400">{loadError}</p>
              <Button type="button" variant="outline" className={TAP} onClick={load}>Try again</Button>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  const db = data.database || {};
  const storage = data.storage || {};
  const emb = data.embeddings || {};
  const dbView = healthView(db);
  const sHealth = healthView(storage);
  const eHealth = healthView(emb);
  const s = storageView(storage);
  const e = embeddingsView(emb);
  const warning = localWarning(data);
  const others = otherWarnings(data);
  const sJob = jobFor('storage');
  const eJob = jobFor('embeddings');
  const finished = Object.values(jobs).filter((j) => !ACTIVE_JOB_STATES.includes(j.state));
  const dismiss = (id) => setJobs((prev) => { const n = { ...prev }; delete n[id]; return n; });

  const storageActions = canEdit ? (
    <>
      {sHealth.status === 'missing_credentials' ? (
        <Button type="button" className={TAP} disabled={busy || !!sJob} onClick={() => setDialog({ type: 'storage', initial: { provider: 'external' } })}>Add access keys</Button>
      ) : null}
      {s.on ? null : (
        <Button type="button" className={TAP} disabled={busy || !!sJob} onClick={() => turnOn('storage')}>
          {busyFeature === 'storage' && !dialog ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}Turn on
        </Button>
      )}
      <Button type="button" variant="outline" className={TAP} disabled={busy || !!sJob} onClick={() => setDialog({ type: 'storage' })}>Switch provider</Button>
      {s.on ? (
        <Button type="button" variant="outline" className={TAP} disabled={busy || !!sJob} onClick={() => setDialog({ type: 'off', feature: 'storage' })}>Turn off</Button>
      ) : null}
    </>
  ) : null;

  const embActions = canEdit ? (
    <>
      {eHealth.status === 'missing_credentials' ? (
        <Button type="button" className={TAP} disabled={busy || !!eJob} onClick={() => setDialog({ type: 'embeddings', provider: emb.provider && emb.provider !== 'local' ? emb.provider : 'openai' })}>Add API key</Button>
      ) : null}
      {e.on ? null : (
        <Button type="button" className={TAP} disabled={busy || !!eJob} onClick={() => turnOn('embeddings')}>
          {busyFeature === 'embeddings' && !dialog ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}Turn on
        </Button>
      )}
      <Button type="button" variant="outline" className={TAP} disabled={busy || !!eJob} onClick={() => setDialog({ type: 'embeddings' })}>Switch provider</Button>
      {e.on ? (
        <Button type="button" variant="outline" className={TAP} disabled={busy || !!eJob} onClick={() => setDialog({ type: 'off', feature: 'embeddings' })}>Turn off</Button>
      ) : null}
    </>
  ) : null;

  const offFeature = dialog?.type === 'off' ? dialog.feature : null;

  return (
    <Card data-foundation-panel="ready">
      {header}
      <CardContent className="space-y-4">
        {others.map((w) => <Banner key={w} tone="warn"><p className="break-words">{w}</p></Banner>)}

        <FeatureSection
          name="database" icon={Database} title="Database" view={dbView}
          subtitle="Always on. It holds the app's data and its search vectors, so it has no off switch."
        >
          <Meta items={[['Engine', 'PostgreSQL 18 + pgvector']]} />
        </FeatureSection>

        <FeatureSection name="storage" icon={HardDrive} title="File storage" view={sHealth} subtitle="Where the app keeps uploaded files." actions={storageActions}>
          <Meta items={[
            ['Provider', s.providerLabel],
            ['Where', s.where],
            ['Files', s.objectsText],
            ['Access keys', s.keysSaved == null ? null : s.keysSaved ? 'Saved' : 'Not saved'],
          ]}
          />
          {!s.on ? <p className="text-sm text-muted-foreground">Off. Uploads and downloads are unavailable. Nothing was deleted.</p> : null}
          {s.pending ? <p className="text-sm text-muted-foreground">{s.pending}</p> : null}
          {sJob ? <JobProgress job={sJob} busy={cancelling === sJob.id} onCancel={(id) => cancelJob(id, 'storage')} /> : null}
          {finished.filter((j) => jobFeature(j) === 'storage').map((j) => <JobProgress key={j.id} job={j} onCancel={() => {}} onDismiss={dismiss} />)}
          <RefusalNotice refusal={notice.storage} featureName="storage" busy={busy} onStep={(st, r) => onStep('storage', st, r)} />
        </FeatureSection>

        <FeatureSection name="embeddings" icon={Search} title="Search embeddings" view={eHealth} subtitle="Turns the app's content into vectors for semantic search." actions={embActions}>
          {warning ? <Banner tone="warn" data-foundation-warning="local-embeddings"><p>{warning}</p></Banner> : null}
          <Meta items={[
            ['Provider', e.providerLabel],
            ['Model', e.model ? <span className="break-all font-mono text-xs">{e.model}</span> : null],
            ['Dimensions', e.dimensions == null ? null : formatCount(e.dimensions)],
            ['Index', e.indexText],
            ['API key', e.keySaved == null ? null : e.keySaved ? 'Saved' : 'Not saved'],
          ]}
          />
          {!e.on ? <p className="text-sm text-muted-foreground">Off. Search is unavailable. Stored vectors are kept.</p> : null}
          {e.pending ? <p className="text-sm text-muted-foreground">{e.pending}</p> : null}
          {eJob ? <JobProgress job={eJob} busy={cancelling === eJob.id} onCancel={(id) => cancelJob(id, 'embeddings')} /> : null}
          {finished.filter((j) => jobFeature(j) === 'embeddings').map((j) => <JobProgress key={j.id} job={j} onCancel={() => {}} onDismiss={dismiss} />)}
          <RefusalNotice refusal={notice.embeddings} featureName="embeddings" busy={busy} onStep={(st, r) => onStep('embeddings', st, r)} />
        </FeatureSection>

        <DatabaseException projectId={projectId} canEdit={canEdit} />

        {!canEdit ? <p className="text-xs text-muted-foreground">Only project editors can change these.</p> : null}
      </CardContent>

      <TurnOffDialog
        open={!!offFeature} featureName={offFeature || 'storage'} feature={offFeature ? data[offFeature] : null}
        dependents={offFeature ? dependentsOf(data, offFeature) : []}
        onClose={() => setDialog(null)} onConfirm={() => turnOff(offFeature)} busy={busy}
        refusal={dialog?.type === 'off' ? dialog.refusal : null}
        onStep={(st, r) => onStep(offFeature, st, r)}
      />
      <StorageDialog
        open={dialog?.type === 'storage'} storage={storage} initial={dialog?.type === 'storage' ? dialog.initial : null}
        refusal={dialog?.type === 'storage' ? dialog.refusal : null}
        onClose={() => setDialog(null)} busy={busy}
        onStep={(st, r) => onStep('storage', st, r)}
        onSubmit={(body) => submit('storage', body, body.mode === 'copy'
          ? { okTitle: 'Copying files', okText: 'The new storage takes over after every file is verified.' }
          : { okTitle: 'Switching storage', okText: 'The new storage takes over after it passes a test from inside the app.' })}
      />
      <EmbeddingsDialog
        open={dialog?.type === 'embeddings'} embeddings={emb} initialProvider={dialog?.type === 'embeddings' ? dialog.provider : null}
        warning={warning || localWarning({ embeddings: { provider: 'local' } })}
        refusal={dialog?.type === 'embeddings' ? dialog.refusal : null}
        onClose={() => setDialog(null)} busy={busy}
        onStep={(st, r) => onStep('embeddings', st, r)}
        onSubmit={(body) => submit('embeddings', body, {
          okTitle: 'Re-embedding started', okText: 'Search keeps using the current index until the new one passes its checks.',
        })}
      />
    </Card>
  );
}

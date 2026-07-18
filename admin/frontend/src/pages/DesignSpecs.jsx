// Design specifications — a visual, self-explanatory reference for the design
// presets a project can be born with: live swatches, typography, radii, shadow
// and a mini preview rendered WITH each preset's own tokens, plus a short
// explanation of where the standards live and how builds consume them.
//
// Admins can also grow the library here: upload a design document
// (proxypilot-design@1 JSON — format shown on the page), ask the AI to adjust
// an existing design ("make the primary warmer") and save the reviewed
// proposal as a custom preset, or delete a custom preset.
//
// Reached from Projects (section card) and from a project's Details tab; when
// linked as /projects/design?preset=<key> the matching preset is highlighted.
//
// MOBILE_FIRST: single column on mobile, two-up on lg; dialogs full-screen on
// <sm; 44px touch targets; no fixed widths.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ArrowLeft, Loader2, Palette, Upload, Sparkles, Trash2 } from 'lucide-react';

// The upload document shape — mirrored from the backend's parseDesignDoc.
const FORMAT_TEMPLATE = `{
  "format": "proxypilot-design@1",
  "key": "my-brand",
  "name": "My Brand",
  "description": "Short human description of the look.",
  "tokens": {
    "colors": {
      "background": "#f5f8fc", "surface": "#ffffff", "text": "#12263f",
      "muted": "#5a6b81", "border": "#e2e8f1", "primary": "#1466b8",
      "primaryText": "#ffffff", "accent": "#12a3a3",
      "danger": "#d24545", "success": "#1f9d57"
    },
    "typography": { "fontFamily": "system-ui, sans-serif", "headingFamily": "system-ui, sans-serif", "baseSize": "15px" },
    "radius": { "sm": "8px", "md": "9px", "lg": "12px" },
    "spacing": { "unit": "8px" },
    "shadow": { "card": "0 1px 2px rgba(16,42,72,0.06)" }
  }
}`;

// One color chip: swatch + name + hex (read-only reference, not interactive).
function Swatch({ name, value }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="h-6 w-6 shrink-0 rounded border" style={{ background: value, borderColor: 'rgba(128,128,128,0.35)' }} />
      <span className="min-w-0 text-xs">
        <span className="block truncate font-medium">{name}</span>
        <span className="block truncate font-mono text-[10px] text-muted-foreground uppercase">{value}</span>
      </span>
    </div>
  );
}

// A mini app preview rendered entirely from the tokens — the fastest honest
// answer to "what does this look like".
function Preview({ tokens }) {
  const c = tokens?.colors || {};
  const t = tokens?.typography || {};
  const r = tokens?.radius || {};
  const shadow = tokens?.shadow?.card || 'none';
  return (
    <div
      className="w-full overflow-hidden rounded-md border"
      style={{ background: c.background, fontFamily: t.fontFamily, fontSize: t.baseSize, borderColor: c.border }}
    >
      <div className="flex items-center justify-between px-3 py-2" style={{ background: c.surface, borderBottom: `1px solid ${c.border}` }}>
        <span style={{ color: c.text, fontFamily: t.headingFamily, fontWeight: 600 }}>App name</span>
        <span className="px-2 py-0.5 text-[11px]" style={{ background: c.accent, color: c.primaryText || '#fff', borderRadius: '999px' }}>
          badge
        </span>
      </div>
      <div className="p-3">
        <div className="p-3" style={{ background: c.surface, borderRadius: r.lg, boxShadow: shadow, border: `1px solid ${c.border}` }}>
          <p style={{ color: c.text, fontFamily: t.headingFamily, fontWeight: 600, marginBottom: 4 }}>Card heading</p>
          <p className="text-xs" style={{ color: c.muted, marginBottom: 10 }}>
            Muted supporting text on a surface card.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-3 py-1.5 text-xs" style={{ background: c.primary, color: c.primaryText || '#fff', borderRadius: r.md }}>
              Primary action
            </span>
            <span className="px-3 py-1.5 text-xs" style={{ background: 'transparent', color: c.text, border: `1px solid ${c.border}`, borderRadius: r.md }}>
              Secondary
            </span>
            <span className="text-xs" style={{ color: c.success }}>success</span>
            <span className="text-xs" style={{ color: c.danger }}>danger</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DesignSpecs() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [presets, setPresets] = useState(null);
  const [params] = useSearchParams();
  const highlight = params.get('preset') || null;
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);

  // AI adjust dialog state: which preset, the instruction, and (after the
  // model answers) the reviewed proposal with an editable name/key.
  const [adjustFor, setAdjustFor] = useState(null); // preset object | null
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState(null);   // {key,name,description,tokens} | null
  const [adjusting, setAdjusting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.mock2DesignPresets();
      setPresets(res.presets || []);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load design presets failed:', err);
      setPresets([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onUploadFile = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      let doc;
      try { doc = JSON.parse(text); } catch { throw new Error('The file is not valid JSON.'); }
      const res = await api.mock2ImportDesignPreset(doc);
      toast({ title: res.created ? 'Design added' : 'Design updated', description: `"${res.preset?.name || doc.name}" is now available in the New-project picker.` });
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Upload failed', description: err.message });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const runAdjust = async () => {
    if (!adjustFor || !instruction.trim()) return;
    setAdjusting(true);
    setProposal(null);
    try {
      const res = await api.mock2AdjustDesignPreset(adjustFor.key, instruction.trim());
      setProposal(res.proposal);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Adjustment failed', description: err.message });
    } finally {
      setAdjusting(false);
    }
  };

  const saveProposal = async () => {
    if (!proposal) return;
    setBusy(true);
    try {
      await api.mock2ImportDesignPreset({ format: 'proxypilot-design@1', ...proposal }, true);
      toast({ title: 'Design saved', description: `"${proposal.name}" is now available as a preset.` });
      setAdjustFor(null); setProposal(null); setInstruction('');
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Save failed', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const deletePreset = async (p) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete the custom design "${p.name}"? Projects that used it keep their styling; it only leaves the picker.`)) return;
    try {
      await api.mock2DeleteDesignPreset(p.key);
      toast({ title: 'Design deleted' });
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Delete failed', description: err.message });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="sm" className="h-11 sm:h-9">
          <Link to="/projects"><ArrowLeft className="h-4 w-4 mr-1" /> Projects</Link>
        </Button>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><Palette className="h-6 w-6" /> Design specifications</h1>
        {isAdmin ? (
          <div className="ml-auto">
            <input
              ref={fileRef} type="file" accept="application/json,.json" className="hidden"
              onChange={(e) => onUploadFile(e.target.files?.[0])}
            />
            <Button variant="outline" className="h-11 sm:h-10" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />} Upload design
            </Button>
          </div>
        ) : null}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">How the design standards work</CardTitle>
          <CardDescription className="space-y-1.5">
            <span className="block">
              Every project is born with one of the presets below (chosen at New project). Its tokens are written
              into the project as <code className="text-xs">state/design-tokens.json</code> plus a ready stylesheet{' '}
              <code className="text-xs">state/design.css</code>, and the scaffold&apos;s shared shell
              (<code className="text-xs">public/base.css</code> + <code className="text-xs">public/app-shell.html</code>) is built from those tokens.
            </span>
            <span className="block">
              Builds are bound to them: the build runner&apos;s instructions order it to load the stylesheet, match the
              tokens, and build screens on the shell — never invent a different look. Approving a mockup re-extracts
              tokens from the approved design, so the app follows what you approved.
            </span>
          </CardDescription>
        </CardHeader>
        {isAdmin ? (
          <CardContent className="pt-0">
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer select-none text-sm font-medium min-h-[28px]">
                Upload format — <code className="text-xs">proxypilot-design@1</code> (one JSON file)
              </summary>
              <p className="pt-2 text-xs text-muted-foreground">
                All ten colors are required (hex); typography/radius/spacing/shadow are optional and fall back to safe
                defaults. <code>key</code> is optional (derived from the name); it must be lowercase letters, digits, and
                hyphens. Re-uploading an existing custom key needs the overwrite flag (the AI-adjust save does this for you).
              </p>
              <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-[11px] leading-relaxed">{FORMAT_TEMPLATE}</pre>
            </details>
          </CardContent>
        ) : null}
      </Card>

      {presets == null ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {presets.map((p) => {
            const c = p.tokens?.colors || {};
            const t = p.tokens?.typography || {};
            const r = p.tokens?.radius || {};
            const isCurrent = highlight && p.key === highlight;
            return (
              <Card key={p.key} className={isCurrent ? 'border-primary ring-1 ring-primary/30' : ''}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex flex-wrap items-center gap-2">
                    {p.name}
                    {isCurrent ? <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">this project&apos;s preset</span> : null}
                    {p.key === 'portal-blue' ? <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">default</span> : null}
                    {p.source === 'custom' ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600">custom</span> : null}
                  </CardTitle>
                  <CardDescription>{p.description}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Preview tokens={p.tokens} />
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
                    {Object.entries(c).map(([name, value]) => <Swatch key={name} name={name} value={value} />)}
                  </div>
                  <p className="text-[11px] text-muted-foreground break-words">
                    Type: {t.baseSize} · {String(t.fontFamily || '').split(',')[0].replace(/["']/g, '') || 'system'} — Radii: {[r.sm, r.md, r.lg].filter(Boolean).join(' / ')} — Shadow: {p.tokens?.shadow?.card ? 'soft layered card shadow' : 'none'}
                  </p>
                  {isAdmin ? (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        variant="outline" size="sm" className="h-11 sm:h-9"
                        onClick={() => { setAdjustFor(p); setInstruction(''); setProposal(null); }}
                      >
                        <Sparkles className="h-4 w-4 mr-1" /> Adjust with AI
                      </Button>
                      {p.source === 'custom' ? (
                        <Button variant="outline" size="sm" className="h-11 sm:h-9 text-red-500" onClick={() => deletePreset(p)}>
                          <Trash2 className="h-4 w-4 mr-1" /> Delete
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* AI adjust dialog: instruction → sanitized proposal preview → save as a
          custom preset (name/key editable). Full-screen on <sm (MOBILE_FIRST). */}
      <Dialog open={!!adjustFor} onOpenChange={(o) => { if (!o && !adjusting) { setAdjustFor(null); setProposal(null); } }}>
        <DialogContent className="max-w-full h-full rounded-none overflow-y-auto sm:max-w-lg sm:h-auto sm:max-h-[90vh] sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Adjust “{adjustFor?.name}” with AI</DialogTitle>
            <DialogDescription>
              Describe the change in plain language — the AI returns a full adjusted token set, validated and shown
              here for review. Nothing is saved until you save it as a (new or updated) custom preset.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <textarea
              className="flex min-h-[64px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
              placeholder="e.g. “Make the primary a warmer green and increase all radii slightly” or “Give this a dark-mode variant”"
              value={instruction}
              disabled={adjusting}
              onChange={(e) => setInstruction(e.target.value)}
            />
            <Button className="h-11 sm:h-10 w-full sm:w-auto" disabled={adjusting || !instruction.trim()} onClick={runAdjust}>
              {adjusting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
              {proposal ? 'Adjust again' : 'Generate adjustment'}
            </Button>
            {proposal ? (
              <div className="space-y-3 rounded-md border p-3">
                <Preview tokens={proposal.tokens} />
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="text-xs space-y-1">
                    <span className="font-medium">Name</span>
                    <Input className="h-11 sm:h-9" value={proposal.name} onChange={(e) => setProposal({ ...proposal, name: e.target.value })} />
                  </label>
                  <label className="text-xs space-y-1">
                    <span className="font-medium">Key</span>
                    <Input className="h-11 sm:h-9 font-mono" value={proposal.key} onChange={(e) => setProposal({ ...proposal, key: e.target.value })} />
                  </label>
                </div>
                <Button className="h-11 sm:h-10 w-full" disabled={busy} onClick={saveProposal}>
                  {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null} Save as preset
                </Button>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

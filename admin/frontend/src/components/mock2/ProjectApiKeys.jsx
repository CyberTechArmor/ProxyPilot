// Per-project / per-user provider API keys.
//
// These layer OVER the global model connectors: the connector still chooses the
// provider and model, these only supply the credential. Precedence for a build
// is your personal key → the project key → the global connector key, and the
// panel says which one the next build will actually use.
//
// The secret is write-only — it is never returned by the API, so the UI shows a
// last-4 hint and re-entering a key rotates it in place.
//
// MOBILE_FIRST: single column that becomes two at sm; 44px targets; the whole
// form completes at 360px.

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { KeyRound, Loader2, Trash2, User, Users, Globe } from 'lucide-react';

const PROVIDER_LABEL = {
  anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini',
  ollama: 'Ollama', openai_compatible: 'OpenAI-compatible',
};

const SOURCE_META = {
  user: { Icon: User, text: 'your personal key', cls: 'text-violet-500' },
  project: { Icon: Users, text: 'the project key', cls: 'text-emerald-500' },
  global: { Icon: Globe, text: 'the global connector key', cls: 'text-muted-foreground' },
};

export default function ProjectApiKeys({ projectId, canEdit = false, isAdmin = false }) {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('user');
  const [provider, setProvider] = useState('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');

  const load = useCallback(async () => {
    try { setData(await api.mock2ProjectApiKeys(projectId)); }
    catch { /* transient */ }
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const canSetProject = canEdit || isAdmin;

  const save = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    try {
      await api.mock2SetProjectApiKey(projectId, {
        scope, provider, api_key: apiKey.trim(), ...(label.trim() ? { label: label.trim() } : {}),
      });
      setApiKey(''); setLabel('');
      toast({ title: 'Key saved', description: `Builds will use ${scope === 'user' ? 'your personal key' : 'the project key'} for ${PROVIDER_LABEL[provider]}.` });
      load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not save the key', description: e?.message || 'unknown error' });
    } finally { setBusy(false); }
  };

  const remove = async (k) => {
    setBusy(true);
    try {
      await api.mock2DeleteProjectApiKey(projectId, k.id);
      toast({ title: 'Key removed', description: 'Builds fall back to the next key in the order.' });
      load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not remove the key', description: e?.message || 'unknown error' });
    } finally { setBusy(false); }
  };

  const keys = data?.keys || [];
  const providers = data?.providers || Object.keys(PROVIDER_LABEL);
  // Only show providers that actually resolve to an override, plus whichever the
  // operator is currently editing — a row per unused provider is just noise.
  const resolved = (data?.resolved || []).filter((r) => r.source !== 'global' || r.provider === provider);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" /> API keys
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Bill this project&apos;s AI usage to your own account. A key here replaces the credential only —
          the model and provider still come from the global connector. Order of preference:
          <strong> your personal key</strong> → <strong>the project key</strong> → the global connector key.
        </p>

        {/* What the NEXT build will actually use. */}
        {resolved.length ? (
          <div className="space-y-1 rounded-md border bg-muted/20 p-2">
            {resolved.map((r) => {
              const meta = SOURCE_META[r.source] || SOURCE_META.global;
              const { Icon } = meta;
              return (
                <div key={r.provider} className="flex items-center gap-2 text-xs">
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${meta.cls}`} />
                  <span className="font-medium">{PROVIDER_LABEL[r.provider] || r.provider}</span>
                  <span className="text-muted-foreground">uses {meta.text}</span>
                  {r.key_hint ? <span className="font-mono text-muted-foreground">{r.key_hint}</span> : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {/* Existing keys */}
        {keys.length ? (
          <ul className="space-y-2">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center gap-2 rounded-md border p-2">
                {k.scope === 'user'
                  ? <User className="h-4 w-4 shrink-0 text-violet-500" />
                  : <Users className="h-4 w-4 shrink-0 text-emerald-500" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {PROVIDER_LABEL[k.provider] || k.provider}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {k.scope === 'user' ? (k.mine ? '· personal (yours)' : '· personal (another member)') : '· project-wide'}
                    </span>
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    <span className="font-mono">{k.key_hint}</span>
                    {k.label ? ` · ${k.label}` : ''}
                    {k.last_used_at ? ' · used' : ' · not used yet'}
                  </p>
                </div>
                {(k.mine || (k.scope === 'project' && canSetProject) || isAdmin) ? (
                  <Button
                    variant="ghost" size="icon" className="h-11 w-11 shrink-0 text-red-500"
                    disabled={busy} onClick={() => remove(k)} aria-label={`Remove the ${k.provider} key`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            No project keys yet — builds use the global connector key.
          </p>
        )}

        {/* Add / rotate */}
        <div className="space-y-2 border-t pt-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="h-11 sm:h-10" aria-label="Key scope"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="user">Just for me (personal)</SelectItem>
                <SelectItem value="project" disabled={!canSetProject}>
                  Whole project{canSetProject ? '' : ' — editors only'}
                </SelectItem>
              </SelectContent>
            </Select>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger className="h-11 sm:h-10" aria-label="Provider"><SelectValue /></SelectTrigger>
              <SelectContent>
                {providers.map((p) => <SelectItem key={p} value={p}>{PROVIDER_LABEL[p] || p}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Input
            className="h-11 sm:h-10 font-mono text-xs" type="password" autoComplete="off"
            placeholder="Paste the API key" value={apiKey}
            onChange={(e) => setApiKey(e.target.value)} aria-label="API key"
          />
          <Input
            className="h-11 sm:h-10" placeholder="Label (optional) — e.g. Team billing account"
            value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Key label"
          />
          <Button className="min-h-[44px] w-full sm:w-auto" disabled={busy || !apiKey.trim()} onClick={save}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <KeyRound className="h-4 w-4 mr-1" />}
            Save key
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Stored encrypted; never shown again (only the last 4 characters). Saving again rotates it.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

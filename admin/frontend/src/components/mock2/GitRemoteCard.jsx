// GitRemoteCard — the one "push this to a git remote" surface for everything
// ProxyPilot hosts. `kind` is 'project' (the bare repo IS the source; pushes ride
// the existing project-remote API), 'static_site' (target = service id) or 'lxc'
// (target = container name); the last two snapshot the docroot / the guest's app
// directory into a host-side mirror and push that (mock2_target_remotes).
//
// Optional by design: with no connector configured the card only links to
// Projects → Connectors. Hidden entirely when the Projects module is off
// (the API answers 404) so core pages stay unchanged on a plain install.
//
// MOBILE_FIRST: single column, 44px controls, wraps on 360px.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GitBranch, Loader2, UploadCloud, ExternalLink } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const EMPTY = { git_connector_id: '', remote_repo: '', push_mode: 'manual', source_dir: '', create_repo: true };

function fmtWhen(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// Inline remote form shared by the card and the create dialogs. `value` is the
// EMPTY-shaped draft; `connectors` the admin's list; `kind` toggles the LXC
// source-dir field. Pure presentation — the parent owns the state.
export function GitRemoteFields({ kind, value, onChange, connectors, disabled = false, idPrefix = 'gr' }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const conn = connectors.find((c) => String(c.id) === String(value.git_connector_id));
  const hint = conn?.provider === 'gitea' || conn?.provider === 'github' ? 'owner/name — created on the remote if missing' : 'org/name or full URL';
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-conn`}>Git connector</Label>
        <Select value={String(value.git_connector_id || '')} onValueChange={(v) => set({ git_connector_id: v })} disabled={disabled}>
          <SelectTrigger id={`${idPrefix}-conn`} className="h-11 sm:h-10"><SelectValue placeholder="Choose a connector (Gitea, GitHub…)" /></SelectTrigger>
          <SelectContent>
            {connectors.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>{c.name} <span className="text-muted-foreground">· {c.provider}{c.base_url ? ` · ${c.base_url.replace(/^https?:\/\//, '')}` : ''}</span></SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-repo`}>Repository</Label>
        <Input id={`${idPrefix}-repo`} className="h-11 sm:h-10" placeholder={hint} value={value.remote_repo} onChange={(e) => set({ remote_repo: e.target.value })} disabled={disabled} />
      </div>
      {kind === 'lxc' && (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-src`}>Directory inside the container</Label>
          <Input id={`${idPrefix}-src`} className="h-11 sm:h-10" placeholder="/opt/app (default: the registered startup directory)" value={value.source_dir} onChange={(e) => set({ source_dir: e.target.value })} disabled={disabled} />
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-mode`}>When to push</Label>
        <Select value={value.push_mode} onValueChange={(v) => set({ push_mode: v })} disabled={disabled}>
          <SelectTrigger id={`${idPrefix}-mode`} className="h-11 sm:h-10"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="manual">Only when I press Push now</SelectItem>
            <SelectItem value="auto">{kind === 'project' ? 'After every checkpoint' : 'Automatically after every change ProxyPilot makes'}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {(conn?.provider === 'gitea' || conn?.provider === 'github' || !conn) && (
        <label className="flex items-center gap-2 text-sm min-h-[44px] sm:min-h-0">
          <input type="checkbox" className="h-4 w-4" checked={!!value.create_repo} onChange={(e) => set({ create_repo: e.target.checked })} disabled={disabled} />
          Create the repository on the remote if it does not exist (private)
        </label>
      )}
    </div>
  );
}

export default function GitRemoteCard({ kind, target, title = 'Git remote', description, compact = false, isAdmin = true, onChanged }) {
  const { toast } = useToast();
  const [available, setAvailable] = useState(null); // null = loading, false = module off / not admin
  const [connectors, setConnectors] = useState([]);
  const [remote, setRemote] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [pushing, setPushing] = useState(false);

  const isProject = kind === 'project';

  const load = useCallback(async () => {
    if (!target) return;
    try {
      const g = await api.mock2ListGitConnectors();
      setConnectors(g.connectors || []);
      const r = isProject ? await api.mock2GetProjectRemote(target) : await api.mock2GetTargetRemote(kind, target);
      const row = r.remote || null;
      setRemote(row);
      setForm(row ? {
        git_connector_id: String(row.git_connector_id),
        remote_repo: row.remote_repo,
        push_mode: isProject ? (row.push_on_checkpoint ? 'auto' : 'manual') : (row.push_mode || 'manual'),
        source_dir: row.source_dir || '',
        create_repo: true,
      } : EMPTY);
      setAvailable(true);
    } catch (err) {
      // 404 = Projects module off; 403 = not an admin. Either way: nothing to show.
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) setAvailable(false);
      else { setAvailable(false); console.error('git remote load failed:', err); }
    }
  }, [kind, target, isProject]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form.git_connector_id || !form.remote_repo.trim()) { toast({ variant: 'destructive', title: 'Pick a connector and name the repository' }); return; }
    setBusy(true);
    try {
      const body = {
        git_connector_id: Number(form.git_connector_id),
        remote_repo: form.remote_repo.trim(),
        create_repo: !!form.create_repo,
      };
      let res;
      if (isProject) {
        res = await api.mock2SetProjectRemote(target, { ...body, push_on_checkpoint: form.push_mode === 'auto' });
      } else {
        res = await api.mock2SetTargetRemote(kind, target, { ...body, push_mode: form.push_mode, source_dir: form.source_dir.trim() || null });
      }
      await load();
      onChanged?.(res?.remote || null);
      const created = res?.repo?.created ? ' — repository created on the remote' : '';
      toast({ title: `Remote saved${created}` });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not save the remote', description: err.message });
    } finally { setBusy(false); }
  };

  const clear = async () => {
    setBusy(true);
    try {
      if (isProject) await api.mock2ClearProjectRemote(target); else await api.mock2ClearTargetRemote(kind, target);
      setRemote(null); setForm(EMPTY); onChanged?.(null);
      toast({ title: 'Remote removed' });
    } catch (err) { toast({ variant: 'destructive', title: 'Could not remove the remote', description: err.message }); }
    finally { setBusy(false); }
  };

  const pushNow = async () => {
    setPushing(true);
    try {
      const r = isProject ? await api.mock2PushProjectRemote(target) : await api.mock2PushTargetRemote(kind, target);
      await load();
      if (r.ok) toast({ title: r.unchanged ? 'Already up to date on the remote' : 'Pushed', description: r.commit ? `commit ${String(r.commit).slice(0, 10)}` : undefined });
      else toast({ variant: 'destructive', title: 'Push failed', description: r.error });
    } catch (err) { toast({ variant: 'destructive', title: 'Push failed', description: err.message }); }
    finally { setPushing(false); }
  };

  if (available === false || !isAdmin) return null;
  if (available === null) return null;

  const body = (
    <div className="space-y-3">
      {connectors.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No git connector yet. <Link to="/projects/connectors" className="underline">Add a Gitea or GitHub connector</Link> (URL + token) under Flightdeck → Connectors, then come back here.
        </p>
      ) : (
        <>
          <GitRemoteFields kind={kind} value={form} onChange={setForm} connectors={connectors} disabled={busy} idPrefix={`gr-${kind}`} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="h-11 sm:h-10" disabled={busy} onClick={save}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : (remote ? 'Save changes' : 'Save remote')}</Button>
            {remote && (
              <Button size="sm" variant="outline" className="h-11 sm:h-10" disabled={pushing || busy} onClick={pushNow}>
                {pushing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <UploadCloud className="h-4 w-4 mr-1" />} Push now
              </Button>
            )}
            {remote && <Button size="sm" variant="ghost" className="h-11 sm:h-10" disabled={busy} onClick={clear}>Remove</Button>}
            {remote?.web_url && (
              <Button asChild size="sm" variant="ghost" className="h-11 sm:h-10">
                <a href={remote.web_url} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4 mr-1" /> Open on remote</a>
              </Button>
            )}
          </div>
          {remote && (
            <p className="text-xs text-muted-foreground break-all">
              {remote.last_push_error
                ? <span className="text-red-500">Last push failed: {remote.last_push_error}</span>
                : remote.last_push_at
                  ? <>Last pushed {fmtWhen(remote.last_push_at)}{remote.last_pushed_commit ? <> · <code>{String(remote.last_pushed_commit).slice(0, 10)}</code></> : null}</>
                  : 'Not pushed yet.'}
            </p>
          )}
        </>
      )}
    </div>
  );

  if (compact) {
    return (
      <div className="space-y-2 border-t pt-4">
        <Label className="flex items-center gap-2"><GitBranch className="h-4 w-4" /> {title}</Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
        {body}
      </div>
    );
  }
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div>
        <h4 className="text-sm font-medium flex items-center gap-2"><GitBranch className="h-4 w-4" /> {title}</h4>
        {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
      </div>
      {body}
    </div>
  );
}

GitRemoteCard.Fields = GitRemoteFields;
export const EMPTY_REMOTE_DRAFT = EMPTY;

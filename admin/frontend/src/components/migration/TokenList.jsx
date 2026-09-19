// Every agent token, and what it is doing.
//
// A migration token has no clock: it lives until the migration reaches a
// terminal state, or until someone revokes it. That makes "what is still out
// there?" a question worth being able to answer at a glance — an UNCLAIMED
// token is a command still sitting in somebody's clipboard or chat window,
// and the Revoke button is the answer to it.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { ChevronDown, ChevronUp, KeyRound, Loader2, RefreshCw, ShieldOff } from 'lucide-react';
import { BTN, Chip, Notice, fmtDate } from '@/components/migration/shared';

const LEVEL = { unclaimed: 'warn', active: 'info', spent: 'muted', revoked: 'muted', expired: 'muted' };
const LABEL = {
  unclaimed: 'not used yet',
  active: 'in use',
  spent: 'spent',
  revoked: 'revoked',
  expired: 'expired',
};

export default function TokenList({ onChanged }) {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      setData(await api.migrations.tokens());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? (e.body?.error || e.message) : e.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const revoke = async (t) => {
    setBusy(t.migration_id);
    try {
      await api.migrations.revokeToken(t.migration_id);
      toast({ title: `Token for migration #${t.migration_id} revoked`, description: 'A source host presenting it is refused from now on.' });
      await load({ quiet: true });
      onChanged?.();
    } catch (e) {
      toast({ title: 'That did not work', description: e instanceof ApiError ? (e.body?.error || e.message) : e.message, variant: 'destructive' });
    } finally { setBusy(null); }
  };

  const tokens = data?.tokens || [];
  const live = tokens.filter((t) => t.usable);

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-2 flex-wrap text-left min-h-[44px] min-w-0"
            aria-expanded={open}
          >
            {open ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
            <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="font-medium">Agent tokens</span>
            {loading && !data ? <Loader2 className="h-4 w-4 animate-spin" /> : (
              <span className="flex flex-wrap gap-1.5">
                {live.length > 0
                  ? <Chip level="warn">{live.length} still usable</Chip>
                  : <Chip level="ok">none usable</Chip>}
                <Chip level="muted">{tokens.length} total</Chip>
              </span>
            )}
          </button>
          <Button variant="outline" className={BTN} onClick={() => load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />Refresh
          </Button>
        </div>

        {error && <Notice level="error"><p className="break-words">{error}</p></Notice>}

        {open && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground break-words">
              One token per migration, for its whole life. It does not expire on a clock: it dies when the
              migration finishes, and revoking it kills it sooner. <strong>Not used yet</strong> means the
              command is still out there and would still work.
            </p>
            {tokens.length === 0 ? (
              <p className="text-sm text-muted-foreground">No migrations, so no tokens.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {tokens.map((t) => (
                  <div key={t.migration_id} className="rounded border p-2.5 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip level={LEVEL[t.state] || 'muted'}>{LABEL[t.state] || t.state}</Chip>
                      <span className="font-mono text-sm break-all">{t.target}</span>
                      <span className="text-xs text-muted-foreground">#{t.migration_id}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-mono break-all">{t.token_id}</span>
                      <span>{t.claimed ? `claimed ${fmtDate(t.claimed_at)}${t.source_ip ? ` from ${t.source_ip}` : ''}` : 'never claimed'}</span>
                      {t.last_seen_at && <span>last seen {fmtDate(t.last_seen_at)}</span>}
                      {t.expires_at && <span>expires {fmtDate(t.expires_at)}</span>}
                      {t.revoked_at && <span>revoked {fmtDate(t.revoked_at)}</span>}
                    </div>
                    <p className="text-xs text-muted-foreground break-words">{t.reason}</p>
                    {t.usable && (
                      <Button
                        variant="outline"
                        className={`${BTN} w-full sm:w-auto`}
                        disabled={busy === t.migration_id}
                        onClick={() => revoke(t)}
                      >
                        {busy === t.migration_id
                          ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                          : <ShieldOff className="h-4 w-4 mr-1.5" />}
                        Revoke
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

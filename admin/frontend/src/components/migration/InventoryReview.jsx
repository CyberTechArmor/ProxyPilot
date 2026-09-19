// The inventory the agent sent, as the operator's decision surface: what is
// on the source, what ProxyPilot would do with it, and what it is worried
// about — with the Approve button underneath, because approving is the point
// of reading it.

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ShieldQuestion, Play } from 'lucide-react';
import { BTN, Chip, KV, Notice, SectionHeader, fmtBytes } from './shared';

function Concern({ c }) {
  return (
    <Notice level={c.level === 'block' ? 'error' : 'warn'}>
      <p className="break-words">{c.text}</p>
      {c.remedy && <p className="text-xs opacity-80 break-words">{c.remedy}</p>}
    </Notice>
  );
}

export default function InventoryReview({ migration, onApprove, onEgress, busy }) {
  const s = migration.summary;
  if (!s) {
    return (
      <Card><CardContent className="p-4 text-sm text-muted-foreground">
        The agent has not sent its inventory yet. Run the command on the source host; this fills in within a minute of it starting.
      </CardContent></Card>
    );
  }
  const blocking = (migration.concerns || []).filter((c) => c.level === 'block');
  const pendingEgress = (migration.egress || []).filter((e) => !e.internal && e.decision === 'pending');

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <SectionHeader title="The source" description="As the agent found it. Nothing here has been copied." />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1">
            <KV label="Hostname">{s.hostname || '—'}</KV>
            <KV label="OS">{s.os || '—'}</KV>
            <KV label="Kind">{s.kind}{s.arch ? ` · ${s.arch}` : ''}</KV>
            <KV label="CPU / memory">{s.cpus ?? '—'} vCPU · {s.memory_bytes ? fmtBytes(s.memory_bytes) : '—'}</KV>
            <KV label="Used on /">{s.used_bytes ? fmtBytes(s.used_bytes) : '—'}</KV>
            <KV label="Services">{s.counts.units} units · {s.counts.listening} listening</KV>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {s.dockerized && <Chip level="accent" title="The application runs in containers on the source">containerized</Chip>}
            <Chip level="muted">{s.counts.vhosts} vhost(s)</Chip>
            <Chip level="muted">{s.counts.databases} database engine(s)</Chip>
            <Chip level="muted">{s.counts.cron} cron entries</Chip>
            <Chip level="muted">{s.counts.env_files} env file(s) · {s.counts.env_keys} keys</Chip>
            <Chip level="muted">{s.counts.tls} TLS item(s)</Chip>
            <Chip level={s.counts.egress ? 'warn' : 'muted'}>{s.counts.egress} outbound host(s)</Chip>
          </div>
        </CardContent>
      </Card>

      {(migration.concerns || []).length > 0 && (
        <div className="space-y-2">{migration.concerns.map((c) => <Concern key={c.id} c={c} />)}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-4 space-y-2">
            <SectionHeader title="Routes we could publish" description="From the source's own vhosts. Nothing is published until the cutover step." />
            {s.suggested_routes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No vhost was found, so you will name the domain and port yourself.</p>
            ) : s.suggested_routes.map((r) => (
              <div key={r.domain} className="flex flex-wrap items-center gap-2 text-sm border-b last:border-0 py-1.5">
                <span className="font-mono break-all">{r.domain}</span>
                <Chip level="muted">{r.proxied ? `→ :${r.upstream_port ?? '?'}` : 'static'}</Chip>
                {r.tls && <Chip level="ok">TLS on the source</Chip>}
                <span className="text-xs text-muted-foreground break-all">{r.source_file}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-2">
            <SectionHeader title="Listening ports" description="What answers on the source today." />
            {s.top_ports.length === 0 ? <p className="text-sm text-muted-foreground">No listening TCP port was reported.</p> : (
              <div className="flex flex-wrap gap-1.5">
                {s.top_ports.map((p) => <Chip key={`${p.port}-${p.process}`} level="info" mono title={p.unit || undefined}>{p.port} {p.process || ''}</Chip>)}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-2">
            <SectionHeader title="Databases" description="Dumped logically and restored inside the guest." />
            {s.databases.length === 0 ? <p className="text-sm text-muted-foreground">No database engine was found.</p> : s.databases.map((d, i) => (
              <div key={`${d.engine}-${i}`} className="text-sm border-b last:border-0 py-1.5 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip level="accent">{d.engine}</Chip>
                  {d.version && <span className="text-xs text-muted-foreground break-all">{d.version}</span>}
                  {d.total_bytes ? <Chip level="muted">{fmtBytes(d.total_bytes)}</Chip> : null}
                </div>
                {d.databases?.length ? <p className="font-mono text-xs break-all">{d.databases.join(', ')}</p> : null}
                {d.note && <p className="text-xs text-muted-foreground">{d.note}</p>}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-2">
            <SectionHeader title="Secrets" description="Paths and KEY NAMES only — ProxyPilot refuses a manifest that carries a value." />
            {(migration.manifest?.env_files || []).length === 0 ? <p className="text-sm text-muted-foreground">No .env file was found.</p> : (
              <div className="space-y-2">
                {migration.manifest.env_files.slice(0, 20).map((f) => (
                  <div key={f.path} className="text-sm">
                    <p className="font-mono text-xs break-all">{f.path}</p>
                    <div className="flex flex-wrap gap-1 mt-1">{f.keys.map((k) => <Chip key={k} level="muted" mono>{k}</Chip>)}</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <SectionHeader
            title="Outbound access"
            description="Observed in the connection table, unit files, compose files and cron. The guest starts default-deny; approve only what it needs."
          />
          {(migration.egress || []).filter((e) => !e.internal).length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing outbound was observed.</p>
          ) : migration.egress.filter((e) => !e.internal).map((e) => (
            <div key={`${e.host}:${e.port}`} className="flex flex-wrap items-center justify-between gap-2 border-b last:border-0 py-2">
              <div className="min-w-0">
                <p className="font-mono text-sm break-all">{e.host}{e.port ? `:${e.port}` : ''}</p>
                <p className="text-xs text-muted-foreground">{e.service || e.proto} · seen in {e.evidence.join(', ')}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {e.decision === 'pending' ? (
                  <>
                    <Button size="sm" variant="outline" className={BTN} disabled={busy} onClick={() => onEgress?.(e, 'deny')}>Deny</Button>
                    <Button size="sm" className={BTN} disabled={busy} onClick={() => onEgress?.(e, 'approve')}>Allow</Button>
                  </>
                ) : <Chip level={e.decision === 'approved' ? 'ok' : 'muted'}>{e.decision}</Chip>}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {migration.status === 'awaiting_review' && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-start gap-2">
              <ShieldQuestion className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-medium">Approve the transfer</p>
                <p className="text-sm text-muted-foreground break-words">
                  This is the gate that lets bytes leave {s.hostname || 'the source'}. {migration.mode === 'application'
                    ? `The guest ${migration.target.incus_name} is created now — fenced, with no route — and the agent starts copying into it.`
                    : `The agent starts streaming into ${migration.target.incus_name}.`}
                </p>
              </div>
            </div>
            {blocking.length > 0 && <Notice level="error"><p>There is a blocking concern above. Resolve it, or cancel this migration and create one with the right settings.</p></Notice>}
            <Button className={BTN} disabled={busy || blocking.length > 0} onClick={onApprove}>
              <Play className="h-4 w-4 mr-1.5" />{pendingEgress.length ? `Approve the transfer (${pendingEgress.length} egress decision(s) still open)` : 'Approve the transfer'}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

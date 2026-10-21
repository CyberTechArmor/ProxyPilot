// Application storage → cleanup rules and alerts for one target (DESIGN §3.4,
// §3.6, §7). GET /api/app-storage/targets/:kind/:id/policy gives the policy,
// its source, revision and the effects preview; Turn on / Turn off / Save
// send the whole policy document with PUT (sudo, through api.js) and the
// revision it was based on. A proposed rule only shows what it would do —
// nothing runs until it is turned on.

import { useCallback, useEffect, useId, useState } from 'react';
import { Bell, Loader2, Power, PowerOff, Save, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { BTN, Checkbox, Chip, Notice } from '@/components/storage/shared';
import {
  RULE_FIELDS, RULE_KEYS, alertsForm, alertsFormChanged, effectFor, effectNote, formatAge, formatBytes, formatDateTime, formatSize, ruleForm, ruleFormChanged, ruleState,
  validateAlertsForm, validateRuleForm, withAlerts, withRule,
} from './app-storage-model.mjs';
import { ALERT_TEXT, POLICY_SOURCE_LABELS, POLICY_TEXT, RULE_STATE_HINTS, RULE_TEXT, TEXT } from './app-storage-text.js';
import { RuleStateChip, errorText } from './parts.jsx';

const SOURCE_LEVEL = { 'defaults-new': 'ok', 'defaults-existing': 'warn', preserved: 'info', edited: 'muted' };

function NumberField({ id, label, value, onChange, error, disabled }) {
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input id={id} inputMode="numeric" className={`w-full sm:w-32 h-11 sm:h-10 ${error ? 'border-red-500' : ''}`} value={value} disabled={disabled}
        aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${id}-error` : undefined} onChange={(e) => onChange(e.target.value)} />
      {error && <p id={`${id}-error`} className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

const rangeText = (e) => (e === 'positive' ? POLICY_TEXT.positive : e?.gb ? POLICY_TEXT.gbRange(e.min, e.max) : e ? POLICY_TEXT.range(e.min, e.max) : null);

function Effect({ effect, changed, noCheck }) {
  if (noCheck) return <p className="rounded-md bg-muted/50 p-2 text-xs text-amber-600 dark:text-amber-400" data-testid="rule-effect">{POLICY_TEXT.effectNoCheck}</p>;
  if (!effect) return <p className="text-xs text-muted-foreground">{POLICY_TEXT.effectUnknown}</p>;
  return (
    <div className="rounded-md bg-muted/50 p-2 text-xs space-y-0.5" data-testid="rule-effect">
      <p><span className="font-medium">{POLICY_TEXT.effectsTitle}:</span> {POLICY_TEXT.effect(effect.items, formatSize(effect.bytes, 'estimate'))}</p>
      {effect.examples?.length > 0 && <p className="text-muted-foreground break-words">{POLICY_TEXT.effectExamples(effect.examples.slice(0, 3))}</p>}
      {effectNote(effect) && <p className="text-muted-foreground break-words">{effectNote(effect)}</p>}
      {changed && <p className="text-amber-600 dark:text-amber-400">{POLICY_TEXT.effectsForSaved}</p>}
    </div>
  );
}

function RuleCard({ ruleKey, data, kind, busy, onSave }) {
  const uid = useId();
  const text = RULE_TEXT[ruleKey];
  const policy = data.policy;
  const rule = policy?.rules?.[ruleKey] || {};
  const [form, setForm] = useState(() => ruleForm(policy, ruleKey));
  useEffect(() => { setForm(ruleForm(policy, ruleKey)); }, [policy, ruleKey]);
  const errors = validateRuleForm(ruleKey, form);
  const valid = !Object.keys(errors).length;
  const changed = ruleFormChanged(policy, ruleKey, form);
  const state = ruleState(rule, data.source, Array.isArray(data.proposedRules) ? data.proposedRules.includes(ruleKey) : undefined);
  const working = busy === ruleKey;
  return (
    <Card data-rule={ruleKey}>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{text.title}</h3>
          <RuleStateChip state={state} />
        </div>
        <p className="text-sm text-muted-foreground">{text.description}</p>
        <p className="text-xs text-muted-foreground">{RULE_STATE_HINTS[state](text.when)}</p>
        {ruleKey === 'releases' && kind === 'project' && <p className="text-xs text-amber-600 dark:text-amber-400">{text.projectNote}</p>}
        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3">
          {(RULE_FIELDS[ruleKey] || []).map((f) => (
            <NumberField key={f.key} id={`${uid}-${f.key}`} label={text.fields[f.key]} value={form[f.key] ?? ''} disabled={Boolean(busy)}
              error={rangeText(errors[f.key])} onChange={(v) => setForm((s) => ({ ...s, [f.key]: v }))} />
          ))}
        </div>
        {ruleKey === 'releases' && Array.isArray(rule.trimBeforeSeal) && rule.trimBeforeSeal.length > 0 && (
          <p className="text-xs"><span className="text-muted-foreground">{text.trimBeforeSeal}:</span> <span className="font-mono break-words">{rule.trimBeforeSeal.join(', ')}</span></p>
        )}
        <Effect effect={effectFor(data.effects, ruleKey)} changed={changed} noCheck={!data.checkId} />
        <div className="flex flex-col sm:flex-row gap-2">
          {rule.enabled ? (
            <Button type="button" variant="outline" className={BTN} disabled={Boolean(busy)} onClick={() => onSave(ruleKey, withRule(policy, ruleKey, null, false))}>
              {working ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <PowerOff className="h-4 w-4 mr-1.5" />}{POLICY_TEXT.turnOff}<span className="sr-only"> {text.title}</span>
            </Button>
          ) : (
            <Button type="button" className={BTN} disabled={Boolean(busy) || !valid} onClick={() => onSave(ruleKey, withRule(policy, ruleKey, form, true))}>
              {working ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Power className="h-4 w-4 mr-1.5" />}{POLICY_TEXT.turnOn}<span className="sr-only"> {text.title}</span>
            </Button>
          )}
          <Button type="button" variant="outline" className={BTN} disabled={Boolean(busy) || !changed || !valid} onClick={() => onSave(ruleKey, withRule(policy, ruleKey, form))}>
            <Save className="h-4 w-4 mr-1.5" />{POLICY_TEXT.save}<span className="sr-only"> {text.title}</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AlertsCard({ data, busy, onSave }) {
  const uid = useId();
  const [form, setForm] = useState(() => alertsForm(data.policy));
  useEffect(() => { setForm(alertsForm(data.policy)); }, [data.policy]);
  const errors = validateAlertsForm(form);
  const valid = !Object.keys(errors).length;
  const changed = alertsFormChanged(data.policy, form);
  const a = data.policy?.alerts || {};
  return (
    <Card data-rule="alerts">
      <CardContent className="p-4 space-y-3">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Bell className="h-4 w-4 shrink-0" />{ALERT_TEXT.title}</h3>
        <p className="text-sm text-muted-foreground">{ALERT_TEXT.description}</p>
        <p className="text-xs" data-testid="alerts-summary">{a.enabled === false ? ALERT_TEXT.off : ALERT_TEXT.summary(formatBytes(a.warnBytes), formatBytes(a.growthBytes), a.growthWindowHours)}</p>
        <Checkbox checked={form.enabled} disabled={Boolean(busy)} onChange={(v) => setForm((s) => ({ ...s, enabled: v }))} label={ALERT_TEXT.enabled} />
        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3">
          <NumberField id={`${uid}-warn`} label={ALERT_TEXT.warnGb} value={form.warnGb} disabled={Boolean(busy)} error={rangeText(errors.warnGb)} onChange={(v) => setForm((s) => ({ ...s, warnGb: v }))} />
          <NumberField id={`${uid}-growth`} label={ALERT_TEXT.growthGb} value={form.growthGb} disabled={Boolean(busy)} error={rangeText(errors.growthGb)} onChange={(v) => setForm((s) => ({ ...s, growthGb: v }))} />
          <NumberField id={`${uid}-hours`} label={ALERT_TEXT.growthWindowHours} value={form.growthWindowHours} disabled={Boolean(busy)} error={rangeText(errors.growthWindowHours)} onChange={(v) => setForm((s) => ({ ...s, growthWindowHours: v }))} />
        </div>
        <Button type="button" variant="outline" className={BTN} disabled={Boolean(busy) || !changed || !valid} onClick={() => onSave('alerts', withAlerts(data.policy, form))}>
          {busy === 'alerts' ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}{POLICY_TEXT.save}<span className="sr-only"> {ALERT_TEXT.title}</span>
        </Button>
      </CardContent>
    </Card>
  );
}

export default function RetentionPolicy({ target, client = api, checkId = null, running = false, onRequestCheck = null }) {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try { setData(await client.appStorage.policy(target.kind, target.id)); setError(''); } catch (err) { setError(errorText(err, POLICY_TEXT.loadFailed)); }
  }, [client, target.kind, target.id]);
  // Reloaded when a new check finishes, so the effects follow the latest check.
  useEffect(() => { load(); }, [load, checkId]);

  const save = async (what, policy) => {
    setBusy(what); setNotice(''); setError('');
    try {
      await client.appStorage.savePolicy(target.kind, target.id, policy, data.revision);
      await load();
      toast({ title: POLICY_TEXT.saved });
    } catch (err) {
      if (err?.status === 409) { setNotice(POLICY_TEXT.revisionConflict); await load(); } else setError(errorText(err, POLICY_TEXT.loadFailed));
    } finally { setBusy(''); }
  };

  if (!data) {
    return error ? <Notice level="error"><p>{error}</p></Notice>
      : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{POLICY_TEXT.loading}</p>;
  }
  const sourceLabel = POLICY_SOURCE_LABELS[data.source]?.(target.name) || data.source;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <h2 className="text-base font-semibold">{POLICY_TEXT.title}</h2>
          <Chip level={SOURCE_LEVEL[data.source] || 'muted'} className="whitespace-normal text-left self-start sm:self-auto" title={sourceLabel}><span data-testid="policy-source">{sourceLabel}</span></Chip>
        </div>
        <p className="text-xs text-muted-foreground max-w-3xl">{POLICY_TEXT.description}</p>
        <p className="text-xs text-muted-foreground" data-testid="policy-changed">
          {data.updatedAt ? POLICY_TEXT.changed(formatAge(data.updatedAt), formatDateTime(data.updatedAt), data.updatedBy) : POLICY_TEXT.neverChanged}
        </p>
      </div>
      {!data.checkId && (
        <div data-testid="policy-no-check"><Notice level="warn">
          <p className="font-medium">{POLICY_TEXT.noCheckTitle}</p>
          <p>{POLICY_TEXT.noCheckNudge}</p>
          {onRequestCheck && (
            <Button type="button" variant="outline" className={`${BTN} mt-1`} disabled={running} onClick={onRequestCheck}>
              {running ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Search className="h-4 w-4 mr-1.5" />}{running ? TEXT.checking : TEXT.requestCheck}
            </Button>
          )}
        </Notice></div>
      )}
      {error && <Notice level="error"><p>{error}</p></Notice>}
      {notice && <Notice level="warn"><p>{notice}</p></Notice>}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {RULE_KEYS.map((key) => <RuleCard key={key} ruleKey={key} data={data} kind={target.kind} busy={busy} onSave={save} />)}
      </div>
      <AlertsCard data={data} busy={busy} onSave={save} />
    </div>
  );
}

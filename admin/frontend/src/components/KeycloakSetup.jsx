import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function KeycloakSetup({ revision, dirty, mode }) {
  const [review, setReview] = useState(null);
  const [records, setRecords] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { setReview(null); setError(''); setMessage(''); }, [revision, dirty, mode]);
  useEffect(() => {
    let alive = true;
    const refresh = async () => { try { const data = await api.getPlatformSetup(); if (alive) { setRecords(data.keycloak || []); setStatusError(false); } } catch { if (alive) setStatusError(true); } };
    refresh(); const timer = setInterval(refresh, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [message]);
  async function prepare() {
    setBusy(true); setError(''); setMessage('');
    try { setReview((await api.reviewKeycloak(revision)).review); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError('');
    try {
      const result = await api.applyKeycloak({ expectedRevision: revision, reviewed: true, retry: true });
      setMessage(result.runnerAvailable ? `Job ${result.job.id}: ${result.job.status}. Progress is saved; you can close this page.` : `Job ${result.job.id}: ${result.job.status}. Runner unavailable; the saved operation will wait for the host runner.`);
      setReview(null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <Card>
    <CardHeader><CardTitle>Set up Keycloak</CardTitle><CardDescription>Install a separate service or verify an existing realm. ProxyPilot SSO remains inactive.</CardDescription></CardHeader>
    <CardContent className="space-y-4 min-w-0">
      <p className="text-sm">{mode === 'skip' ? 'Keycloak is skipped. No operation is submitted.' : dirty || !revision ? 'Save the reviewed plan before reviewing Keycloak changes.' : `Saved revision ${revision} is ready for review. Other service choices remain saved intentions.`}</p>
      <Button className="min-h-11" variant="outline" disabled={busy || dirty || !revision || mode === 'skip'} onClick={prepare}>Review Keycloak changes</Button>
      {error && <p role="alert" className="text-destructive break-words">{error}</p>}
      {message && <p role="status" className="rounded-lg border p-3 text-sm break-words">{message}</p>}
      {review && !dirty && <section aria-label="Reviewed Keycloak changes" className="space-y-3 rounded-lg border p-4 min-w-0">
        <h3 className="font-semibold">{review.ownership === 'managed' ? 'Install managed Keycloak' : 'Connect existing Keycloak'} · revision {revision}</h3>
        <p className="text-sm break-all">Origin: {review.target.url}</p><p className="text-sm break-all">Realm issuer: {review.issuer}</p>
        <ul className="list-disc pl-5 space-y-2 text-sm">{review.changes.map(c => <li key={c} className="break-words">{c}</li>)}</ul>
        <p className="text-sm">{review.access}</p>
        <p className="text-sm text-muted-foreground">Applying requires current administrator authentication. If an attempt failed, this retries its recorded resources and credentials.</p>
        <Button className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={apply}>{busy ? 'Submitting…' : review.ownership === 'managed' ? 'Apply Keycloak installation' : 'Verify and record connection'}</Button>
      </section>}
      {statusError && <p role="alert" className="text-sm">Status could not be refreshed. Previously loaded records may be out of date.</p>}
      {records.map(record => <section key={record.id} className="rounded-lg border p-3 text-sm space-y-2 min-w-0">
        <h3 className="font-semibold break-all">{record.origin}/realms/{record.realm}</h3>
        <p>Ownership: {record.ownership} · Job: {record.job?.status || 'Not submitted'} · Phase: {(record.job?.phase || 'Not started').replaceAll('_', ' ')}</p>
        {record.job?.reason && <p className="break-words">{record.job.reason}</p>}
        {record.verification && <><p className="font-medium">Keycloak ready/connected; ProxyPilot SSO not activated.</p><p>Verified at {new Date(record.verifiedAt).toLocaleString()}. Discovery, exact issuer and signing keys passed.{record.ownership === 'managed' ? ' Database and service readiness passed.' : ' Service/database health and administrative permission were not checked.'}</p></>}
        {!record.verification && <p>Connection not verified. Container startup alone is not completion.</p>}
        <p className="text-xs break-all">Connection reference: {record.id}{record.job ? ` · Job reference: ${record.job.id}` : ''}</p>
        {record.ownership === 'managed' && record.resources && <details><summary className="cursor-pointer min-h-11 flex items-center">Initial administration and recovery</summary><div className="space-y-2">
          <p>Open {record.origin}/admin/ and use bootstrap-admin. A host administrator retrieves the password locally from the protected credentials reference below. Create a permanent administrator and remove the temporary bootstrap account.</p>
          <p className="break-all">Protected reference: {record.resources.credentialsRef}</p>
          <p>Back up the dedicated PostgreSQL database, the entire protected installation directory, and ProxyPilot’s database together. For interrupted setup, restore missing files from that set and retry this saved target. Do not delete the volume or regenerate credentials.</p>
        </div></details>}
      </section>)}
    </CardContent>
  </Card>;
}

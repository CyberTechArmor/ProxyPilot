// S3-compatible client helper for the Backups feature.
//
// Wraps @aws-sdk/client-s3 with two responsibilities:
//
//   1. Build a configured S3Client from a backup_destinations row,
//      decrypting secret_key_enc on the way through. Callers never
//      see the plaintext secret outside this module's stack frame.
//   2. Provide a small set of high-level operations the routes care
//      about (test connection, head bucket, put/get/delete object,
//      list with prefix). Streaming put is delegated to
//      @aws-sdk/lib-storage's Upload helper so multi-GB tier-full
//      backups in PR 2 won't OOM the dashboard process.
//
// The whole AWS SDK surface stays inside this file so the rest of
// the app can import a stable, minimal interface and we can swap
// the underlying client later (e.g. to a slimmer S3-compatible-only
// library) without touching every call site.

import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { decryptSecret } from './secrets.js';
import { buildKey } from './s3-keys.js';

// Re-export buildKey so existing callers don't need to know it
// moved.  The function lives in s3-keys.js now to keep the unit-
// test surface small (see lib/s3-keys.js).
export { buildKey };

// Build an S3Client from a destination row. The row's secret_key_enc
// is decrypted in-place; the plaintext lives only in the closure of
// the returned client. Callers should NOT log or persist the client
// itself anywhere (it carries the credentials).
export function clientForDestination(dest) {
  if (!dest) throw new Error('clientForDestination: destination is required');
  let secret;
  try {
    secret = decryptSecret(dest.secret_key_enc);
  } catch (err) {
    // The raw AES-GCM failure is "Unsupported state or unable to
    // authenticate data" — accurate but unactionable for an
    // operator looking at the row in the UI.  Translate it into
    // something self-diagnosing.  This shape of failure shows up
    // most often after an in-place restore writes the DB but
    // doesn't bring along (or matches) the .env's
    // TOTP_ENCRYPTION_KEY: every encrypted secret in the restored
    // DB is then unrecoverable until the key is reconciled.
    const raw = err?.message || String(err);
    if (/unsupported state|unable to authenticate|cipher.+state/i.test(raw)) {
      throw new Error(
        `destination "${dest.name}" credential decrypt failed (TOTP_ENCRYPTION_KEY ` +
        `mismatch — common after an in-place restore that didn't replace .env). ` +
        `Re-enter the destination's secret key in Housekeeping → Storage, or restore ` +
        `the matching .env onto the host. Original error: ${raw}`
      );
    }
    throw new Error(
      `destination "${dest.name}" credential decrypt failed: ${raw}`
    );
  }
  if (!secret) {
    throw new Error(`destination "${dest.name}" has empty secret_key after decryption`);
  }
  return new S3Client({
    endpoint: dest.endpoint_url,
    region: dest.region || 'us-east-1',
    forcePathStyle: !!dest.path_style,
    // Disable env-var credentials lookup; we always use the per-row
    // credentials so an operator's IAM env on the dashboard host
    // can't accidentally override what they configured in the UI.
    credentials: {
      accessKeyId: dest.access_key_id,
      secretAccessKey: secret,
    },
    // The protocol is implied by endpoint_url, but we honour use_ssl
    // by rejecting an http:// URL when the row says SSL-only. This
    // catches "I disabled use_ssl by accident" footguns.
    ...(dest.use_ssl && /^http:\/\//i.test(dest.endpoint_url)
      ? (() => {
          throw new Error(
            `destination "${dest.name}" has use_ssl=1 but endpoint_url is http://`
          );
        })()
      : {}),
  });
}

// HEAD the bucket to verify auth + reachability. Returns
// { ok, latency_ms } on success, { ok: false, error } on failure.
// Always resolves — never throws — so the route handler can write a
// consistent envelope into test_status without try/catch boilerplate.
export async function testConnection(dest) {
  const t0 = Date.now();
  let client;
  try {
    client = clientForDestination(dest);
  } catch (err) {
    return { ok: false, latency_ms: 0, error: err?.message || String(err) };
  }
  try {
    await client.send(new HeadBucketCommand({ Bucket: dest.bucket }));
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (err) {
    // Surface the AWS error message plus its code if present. SDK
    // errors have .Code (the wire code) and .name (the JS class) —
    // either is informative; we prefer .Code when available.
    const code = err?.Code || err?.name || 'Error';
    const msg = err?.message || String(err);
    return {
      ok: false,
      latency_ms: Date.now() - t0,
      error: `${code}: ${msg}`,
    };
  } finally {
    try { client?.destroy?.(); } catch { /* ignore */ }
  }
}

// Stream an object up to S3. `body` may be a Buffer, a string, or a
// Readable stream. Returns the resolved Key once the upload is
// committed. Uses lib-storage's Upload helper so a large body is
// chunked into multipart parts automatically (prevents OOM and
// honours the storage class).
export async function putObject(dest, key, body, { contentType, storageClass } = {}) {
  const client = clientForDestination(dest);
  try {
    const uploader = new Upload({
      client,
      params: {
        Bucket: dest.bucket,
        Key: key,
        Body: body,
        ContentType: contentType || 'application/octet-stream',
        StorageClass: storageClass || dest.storage_class || undefined,
      },
    });
    await uploader.done();
    return key;
  } finally {
    try { client.destroy?.(); } catch { /* ignore */ }
  }
}

// putObjectWithControl — extended putObject for callers that want
// progress + cancellation.  Returns the constructed Upload alongside
// a Promise that resolves on success / rejects on abort or error.
//
//   onProgress({ loaded, total })  fires for each httpUploadProgress
//                                   event the AWS SDK emits.  Single-
//                                   part PUTs fire once at the end;
//                                   multipart fires per part.
//   isCanceled()                    poll callback the helper invokes
//                                   between progress events.  Return
//                                   true to abort the upload — we
//                                   call uploader.abort() which
//                                   rejects the done() promise with
//                                   a recognisable error.
//
// The S3Client is destroyed in finally so a leaked client doesn't
// hold the network socket open after a cancel.
export function putObjectWithControl(dest, key, body, opts = {}) {
  const { contentType, storageClass, onProgress, isCanceled } = opts;
  const client = clientForDestination(dest);
  const uploader = new Upload({
    client,
    params: {
      Bucket: dest.bucket,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
      StorageClass: storageClass || dest.storage_class || undefined,
    },
  });
  if (typeof onProgress === 'function') {
    uploader.on('httpUploadProgress', (p) => {
      try { onProgress({ loaded: p?.loaded || 0, total: p?.total ?? null }); }
      catch { /* operator-callback failures don't fail the upload */ }
      // Best-effort cancellation: check on every progress tick.
      // Single-part uploads only emit once, so this only catches
      // multipart cancels mid-upload — small bodies will run to
      // completion before the next poll.  For aggressive cancel
      // semantics, the route layer should call uploader.abort()
      // directly (see snapshot-s3-export's exec map).
      if (typeof isCanceled === 'function' && isCanceled()) {
        try { uploader.abort(); } catch { /* ignore */ }
      }
    });
  }
  const done = (async () => {
    try { return await uploader.done(); }
    finally { try { client.destroy?.(); } catch { /* ignore */ } }
  })();
  return { uploader, done, key };
}

// Get an object as a Node Readable stream. Caller is responsible for
// consuming and closing the stream (the S3Client is destroyed once
// the stream finishes via the `close` event handler we attach).
export async function getObjectStream(dest, key) {
  const client = clientForDestination(dest);
  let res;
  try {
    res = await client.send(new GetObjectCommand({ Bucket: dest.bucket, Key: key }));
  } catch (err) {
    try { client.destroy?.(); } catch { /* ignore */ }
    throw err;
  }
  const stream = res.Body;
  if (!stream || typeof stream.on !== 'function') {
    try { client.destroy?.(); } catch { /* ignore */ }
    throw new Error('S3 GetObject returned a non-stream body');
  }
  const cleanup = () => { try { client.destroy?.(); } catch { /* ignore */ } };
  stream.on('end', cleanup);
  stream.on('error', cleanup);
  stream.on('close', cleanup);
  return {
    stream,
    contentLength: res.ContentLength,
    contentType: res.ContentType,
    lastModified: res.LastModified,
  };
}

export async function deleteObject(dest, key) {
  const client = clientForDestination(dest);
  try {
    await client.send(new DeleteObjectCommand({ Bucket: dest.bucket, Key: key }));
  } finally {
    try { client.destroy?.(); } catch { /* ignore */ }
  }
}

// headObject(dest, key) → { found, content_length?, retention_mode?,
//   retention_until?, legal_hold? } | { found: false }
//
// Used by the snapshot-S3-delete flow to surface object-lock info
// before the operator confirms.  B2's web UI marks locked files
// with a `*` glyph; our delete returns success but the bucket
// silently holds the bytes until retention expires, leaving an
// operator with stale 'deleted' rows in the dashboard while their
// bucket bills keep climbing.  Calling HeadObject up front lets
// us tell the operator "this object is locked until 2026-08-15"
// instead of letting the delete silently no-op.
export async function headObject(dest, key) {
  const client = clientForDestination(dest);
  try {
    const res = await client.send(new HeadObjectCommand({
      Bucket: dest.bucket, Key: key,
    }));
    return {
      found: true,
      content_length: res.ContentLength || null,
      content_type: res.ContentType || null,
      last_modified: res.LastModified || null,
      retention_mode: res.ObjectLockMode || null,
      retention_until: res.ObjectLockRetainUntilDate
        ? new Date(res.ObjectLockRetainUntilDate).toISOString()
        : null,
      legal_hold: res.ObjectLockLegalHoldStatus === 'ON',
    };
  } catch (err) {
    const code = err?.name || err?.Code || '';
    if (/NotFound|404|NoSuchKey/i.test(code) || err?.$metadata?.httpStatusCode === 404) {
      return { found: false };
    }
    throw err;
  } finally {
    try { client.destroy?.(); } catch { /* ignore */ }
  }
}

export async function listObjects(dest, { prefix, maxKeys = 1000 } = {}) {
  const client = clientForDestination(dest);
  try {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: dest.bucket,
      Prefix: buildKey(dest, prefix || ''),
      MaxKeys: maxKeys,
    }));
    return (res.Contents || []).map((c) => ({
      key: c.Key,
      size: c.Size,
      lastModified: c.LastModified,
      etag: c.ETag,
    }));
  } finally {
    try { client.destroy?.(); } catch { /* ignore */ }
  }
}

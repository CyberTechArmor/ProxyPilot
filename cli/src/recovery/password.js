// The password half of root recovery. A new password reaches this process
// through a file or stdin — never argv, which `ps` and shell history keep —
// or is generated here and shown once. Hashing matches the backend
// (routes/auth.js: bcrypt, cost 12) so the row it writes is one the login
// handler reads unchanged.

import crypto from 'node:crypto';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';

export const BCRYPT_COST = 12;
export const MIN_PASSWORD_LENGTH = 12; // routes/auth.js initialSetupSchema
export const GENERATED_PASSWORD_LENGTH = 24;
// No 0/O/1/l/I: the operator types this from a console.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generatePassword(length = GENERATED_PASSWORD_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (/[\r\n]/.test(pw)) return { ok: false, reason: 'password must be a single line' };
  return { ok: true };
}

export async function hashPassword(pw) {
  return bcrypt.hash(pw, BCRYPT_COST);
}

export async function verifyPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

// readPasswordSource({ file, stdin }, deps) → { password, source } or
// { password: null, source: 'generated' } when neither is given. The file is
// read whole and its trailing newline dropped; stdin the same.
export async function readPasswordSource({ file, stdin } = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  if (file && stdin) throw new Error('--password-file and --password-stdin are mutually exclusive');
  if (file) {
    const text = fsImpl.readFileSync(file, 'utf8');
    return { password: text.replace(/\r?\n$/, ''), source: 'file' };
  }
  if (stdin) {
    const text = await (deps.readStdin || readAllStdin)();
    return { password: text.replace(/\r?\n$/, ''), source: 'stdin' };
  }
  return { password: null, source: 'generated' };
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

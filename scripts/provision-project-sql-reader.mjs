#!/usr/bin/env node
// Explicit host-admin maintenance for existing projects. Query requests never
// run this provisioning operation or fall back to the postgres account.
import { execFileSync } from 'node:child_process';
import { READER_PROVISION_SCRIPT } from '../admin/backend/src/lib/project-sql-reader.js';
const guest = process.argv[2];
if (!/^pp-[A-Za-z0-9][A-Za-z0-9-]{0,59}$/.test(guest || '')) throw new Error('Usage: node scripts/provision-project-sql-reader.mjs pp-GUEST');
execFileSync('incus', ['exec',guest,'--','sh','-s'], { input: READER_PROVISION_SCRIPT, timeout: 60000, stdio: ['pipe','inherit','inherit'] });
console.log('Read-only login provisioned. Only existing api_read views are granted. Re-run after adding curated views.');

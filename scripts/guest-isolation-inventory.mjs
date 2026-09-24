#!/usr/bin/env node
// Update-time inventory only. Never stops, reconfigures, or converts guests.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { guestIsolation } from '../admin/backend/src/lib/guest-isolation.js';

const output = process.argv[2];
if (!output?.startsWith('/')) throw new Error('An absolute output path is required');
const instances = JSON.parse(execFileSync('incus', ['list','--format','json'], { encoding: 'utf8', timeout: 30000, maxBuffer: 16*1024*1024 }));
if (!Array.isArray(instances)) throw new Error('Incus did not return an inventory');
const guests = instances.filter(i => i.name?.startsWith('pp-')).map(i => ({ name: i.name, created_at: i.created_at, ...guestIsolation(i) }));
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
const temp = `${output}.${randomUUID()}.tmp`;
writeFileSync(temp, JSON.stringify({ version: 1, observed_at: new Date().toISOString(), guests }, null, 2)+'\n', { mode: 0o600, flag: 'wx' });
renameSync(temp, output);
console.log(`Guest isolation inventory: ${guests.filter(g => g.migration_required).length} guest(s) require VM migration; existing guests remain running. Review Migrations before cutover.`);

import test from 'node:test';
import {withSavedAgentFixture} from '../fixtures/saved-agent.mjs';
test('saved configuration through actual local Keycloak source, signed authority, mTLS worker and real OpenBao',{timeout:120000},async t=>withSavedAgentFixture(t));

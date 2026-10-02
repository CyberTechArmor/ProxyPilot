"""Static contract cross-language and authority-shape checks; no browser/network."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('selected_contract', ROOT / 'scripts/selected_browser_contract.py')
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)
BASE = json.loads((ROOT / 'contracts/browser-agent/fixtures/general-agent.draft.json').read_text())


class SelectedContractTests(unittest.TestCase):
    def test_valid_draft_and_packaged_schemas_are_identical(self):
        self.assertEqual(contract.validate_configuration(BASE), BASE)
        for key, name in [('configuration', 'proposal-v1.schema.json'), ('action', 'action-v1.schema.json')]:
            self.assertEqual(contract.SCHEMAS[key], json.loads((ROOT / 'contracts/browser-agent' / name).read_text()))

    def test_canonical_bytes_match_node_for_unicode_and_number_thresholds(self):
        value = {'z': 'café🙂', 'limits': [1.0, 0.000001, 0.0000001, 1e-12, 0.04, -0.0, 1e20, 1e21]}
        code = 'const c=v=>Array.isArray(v)?"["+v.map(c).join(",")+"]":v&&typeof v==="object"?"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+c(v[k])).join(",")+"}":JSON.stringify(v);process.stdout.write(c(JSON.parse(process.argv[1])))'
        output = subprocess.run(['node', '-e', code, json.dumps(value)], capture_output=True, check=True, timeout=5).stdout.decode()
        self.assertEqual(contract.canonical_json(value), output)

    def test_exact_internal_metadata_cannot_weaken_permissions(self):
        for origin in ['https://intranet', 'https://10.24.8.12', 'https://[fd12::1]:8443', 'http://intranet:8080']:
            d = copy.deepcopy(BASE)
            d['destinations']['allowed_origins'] = [{'id': 'site', 'origin': origin, 'roles': ['navigation'], 'session_headers': 'omit'}]
            d['destinations']['entry_urls'] = [origin + '/']
            contract.validate_configuration(d)
        for section, key, value in [('permissions', 'external_change_approval', 'never'),
                                    ('destinations', 'network_scope', 'unrestricted')]:
            d = copy.deepcopy(BASE); d[section][key] = value
            with self.assertRaises(contract.ContractRefused):
                contract.validate_configuration(d)
        d = copy.deepcopy(BASE); d['execution_enabled'] = True
        with self.assertRaises(contract.ContractRefused):
            contract.validate_configuration(d)

    def test_ambiguous_authorities_and_insecure_sessions_are_refused(self):
        for origin in ['https://example.com:443', 'https://10.024.8.12', 'https://[fd12:0::1]', 'https://example.com:65536']:
            d = copy.deepcopy(BASE); d['destinations']['allowed_origins'][0]['origin'] = origin
            with self.assertRaises(contract.ContractRefused):
                contract.validate_configuration(d)
        d = copy.deepcopy(BASE); d['destinations']['allowed_origins'][0]['origin'] = 'http://intranet'
        with self.assertRaises(contract.ContractRefused) as caught:
            contract.validate_configuration(d)
        self.assertEqual(caught.exception.code, 'BROWSER_INSECURE_SESSION_DESTINATION')

    def test_lone_surrogates_unknown_fields_and_utf8_expansion_are_refused(self):
        for instructions in ['\ud800', '🙂' * 30000]:
            d = copy.deepcopy(BASE); d['work']['instructions'] = instructions
            with self.assertRaises(contract.ContractRefused):
                contract.validate_configuration(d)
        d = copy.deepcopy(BASE); d['model']['headers'] = {'Authorization': 'CANARY'}
        with self.assertRaises(contract.ContractRefused):
            contract.validate_configuration(d)


if __name__ == '__main__':
    unittest.main()

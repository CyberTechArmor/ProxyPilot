"""A8 reads the durable command record, including terminal attempts."""
import copy
import json
import os
import socket
import unittest
from unittest.mock import patch
import test_a3_worker_supervisor as fixture

s = fixture.s


class StepRecordTests(unittest.TestCase):
    setUp = fixture.SupervisorTests.setUp
    tearDown = fixture.SupervisorTests.tearDown
    make = fixture.SupervisorTests.make
    ref = fixture.SupervisorTests.ref
    assertRefused = fixture.SupervisorTests.assertRefused

    def launch(self):
        self.sup.launch(fixture.launch_spec())

    def test_read_is_bounded_read_only_and_survives_stop_and_restart(self):
        self.launch()
        ref = self.ref(ordinal=3, action='open_login')
        self.sup.action(ref)
        record = self.sup.state['attempts'][fixture.ATTEMPT]['actions'][0]
        record.update(claims={'secret': 'do-not-show'}, receipt='do-not-show', binding_id='do-not-show')
        self.sup._save()
        before = self.sup.journal_path.read_bytes()
        state = copy.deepcopy(self.sup.state)
        reply = self.sup.dispatch('step_record', ref)
        self.assertEqual(reply['record']['ordinal'], 3)
        self.assertEqual(reply['record']['state'], 'done')
        self.assertEqual(set(reply['record']), {'ordinal', 'action', 'state', 'at', 'latency_ms'})
        self.assertEqual(self.sup.state, state)
        self.assertEqual(self.sup.journal_path.read_bytes(), before)
        self.sup.stop(self.ref(reason='cancelled'))
        self.assertEqual(self.sup.step_record(ref), reply)
        restarted = self.make()
        self.assertEqual(restarted.step_record(ref), reply)
        self.assertEqual(restarted.step_record(self.ref(ordinal=2, action='open_login')), {'record': None})
        self.assertEqual(restarted.step_record(self.ref(ordinal=3, action='open_landing')), {'record': None})

    def test_original_fence_and_strict_fields_are_required(self):
        self.launch()
        good = self.ref(ordinal=1, action='open_login')
        for update in ({'ordinal': 0}, {'ordinal': True}, {'ordinal': 1.2}, {'ordinal': '1'},
                       {'action': 'shell'}, {'action': []}, {'page': 'do-not-show'}):
            self.assertRefused('INVALID_REQUEST', self.sup.step_record, {**good, **update})
        self.assertRefused('STALE_FENCE', self.sup.step_record, {**good, 'fence': 2})
        self.assertRefused('UNKNOWN_ATTEMPT', self.sup.step_record, {**good, 'attempt_id': fixture.ATTEMPT2})
        self.assertRefused('METHOD_NOT_ALLOWED', self.sup.dispatch, 'journal', {})

    def test_explicit_step_ids_do_not_change_limits_and_cannot_replay(self):
        self.sup.launch(fixture.launch_spec(limits={'max_actions': 2}))
        self.sup.action(self.ref(ordinal=4, action='open_login'))
        self.assertRefused('STEP_ALREADY_RESERVED', self.sup.action, self.ref(ordinal=4, action='open_login'))
        self.assertRefused('STEP_ALREADY_RESERVED', self.sup.action, self.ref(ordinal=2, action='open_login'))
        self.sup.action(self.ref(action='open_landing'))  # Old proofs remain compatible.
        run = self.sup.state['runs'][fixture.RUN]
        self.assertEqual(run['action_count'], 2)
        self.assertEqual([a['ordinal'] for a in self.sup.state['attempts'][fixture.ATTEMPT]['actions']], [4, 5])
        self.assertRefused('ACTION_LIMIT', self.sup.action, self.ref(ordinal=9, action='open_login'))

    def test_uncertain_record_and_error_code_never_exposes_error_detail(self):
        self.launch()
        attempt = self.sup.state['attempts'][fixture.ATTEMPT]
        attempt['actions'].append({'ordinal': 1, 'action': 'sign_out', 'state': 'uncertain',
                                   'at': '2026-09-30T12:00:00Z', 'error': 'secret value and traceback'})
        record = self.sup.step_record(self.ref(ordinal=1, action='sign_out'))['record']
        self.assertEqual(record['state'], 'uncertain')
        self.assertEqual(record['error'], 'WORKER_ERROR')
        self.assertNotIn('secret', json.dumps(record))

    def test_legacy_ordinal_cannot_overflow_the_safe_integer_range(self):
        self.launch()
        self.sup.action(self.ref(ordinal=s.MAX_SAFE, action='open_landing'))
        self.assertRefused('INVALID_REQUEST', self.sup.action, self.ref(action='open_login'))
        self.assertEqual(self.sup.state['runs'][fixture.RUN]['action_count'], 1)

    def test_preserved_directory_observes_recreated_socket_and_root_rule(self):
        directory = self.root / 'backend'
        directory.mkdir(mode=0o700)
        path = directory / 'supervisor.sock'
        inode = directory.stat().st_ino
        for _ in range(2):
            server = s.listen(path, self.sup, False)
            try:
                self.assertEqual(s.Server.peer_uid, 0)
                server.peer_uid = os.getuid()
                with socket.socket(socket.AF_UNIX) as client:
                    client.connect(str(path))
                    client.sendall(b'{"method":"step_record","params":{}}\n')
                    reply = json.loads(client.makefile().readline())
                    self.assertEqual(reply['error'], 'INVALID_REQUEST')
                server.peer_uid = os.getuid() + 1
                with socket.socket(socket.AF_UNIX) as client:
                    client.settimeout(2)
                    client.connect(str(path))
                    try:
                        client.sendall(b'{"method":"status","params":{}}\n')
                        self.assertEqual(client.makefile().readline(), '')
                    except (ConnectionResetError, BrokenPipeError):
                        pass  # Kernel refuses the non-matching peer without a reply.
                self.assertEqual(directory.stat().st_ino, inode)
                self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            finally:
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    unittest.main()

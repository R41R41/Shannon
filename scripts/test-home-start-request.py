#!/usr/bin/python3
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parent.parent / 'deploy'
def module(name):
    spec = importlib.util.spec_from_file_location(name, DEPLOY / (name + '.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
helper = module('shannon-home-start-request')
client = module('shannon-home-start-client')

class Requests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.request = Path(self.temp.name) / 'request'
        self.now = 1000
        self.payload = {'pid': 123, 'startTick': '42', 'expiresAt': 1010, 'nonce': 'a' * 32}
        self.calls = []
    def write(self, payload=None):
        self.request.write_text(json.dumps(self.payload if payload is None else payload))
        os.utime(self.request, (1000, 1000))
    def runner(self, args, **kwargs):
        self.calls.append(args)
        return types.SimpleNamespace(stdout='MainPID=0\nActiveState=inactive\n')
    def consume(self, **kwargs):
        return helper.consume(self.request, runner=kwargs.get('runner', self.runner), original=kwargs.get('original', lambda *args: True),
                              uid=kwargs.get('uid', os.getuid()), clock=lambda: self.now)
    def test_exact_start_once_consumes_before_fixed_actuator(self):
        self.write()
        def runner(args, **kwargs):
            self.assertFalse(self.request.exists()); return self.runner(args, **kwargs)
        self.assertTrue(self.consume(runner=runner))
        self.assertEqual(self.calls[-1], ['/usr/bin/systemctl', '--no-ask-password', 'start', 'shannon-home.service'])
        self.assertFalse(self.consume()); self.assertEqual(len(self.calls), 2)
    def test_invalid_or_stale_requests_never_dispatch(self):
        for key, value in [('expiresAt', 999), ('expiresAt', 1020), ('expiresAt', float('inf')), ('pid', True), ('startTick', 'foreign'), ('nonce', 'other')]:
            with self.subTest(key=key, value=value):
                payload = dict(self.payload); payload[key] = value; self.write(payload)
                self.assertFalse(self.consume()); self.assertFalse(self.request.exists()); self.assertEqual(self.calls, [])
        self.write(dict(self.payload, unit='foreign.service')); self.assertFalse(self.consume()); self.assertEqual(self.calls, [])
        self.write(); os.utime(self.request, (900, 900)); self.assertFalse(self.consume()); self.assertEqual(self.calls, [])
    def test_foreign_owner_symlink_and_fifo_are_not_actuators(self):
        self.write(); self.assertFalse(self.consume(uid=os.getuid() + 1)); self.assertEqual(self.calls, [])
        target = Path(self.temp.name) / 'target'; target.write_text('retained')
        self.request.symlink_to(target); self.assertFalse(self.consume()); self.assertEqual(target.read_text(), 'retained')
        os.mkfifo(self.request); self.assertFalse(self.consume()); self.assertFalse(self.request.exists()); self.assertEqual(self.calls, [])
    def test_dead_or_reused_original_and_revocation_after_read(self):
        self.write(); self.assertFalse(self.consume(original=lambda *args: False)); self.assertEqual(self.calls, [])
        self.write(); admitted = iter([True, False])
        self.assertFalse(self.consume(original=lambda *args: next(admitted))); self.assertEqual(len(self.calls), 1)
    def test_expiry_during_manager_read_and_noninactive_unit(self):
        self.write()
        def expired(args, **kwargs):
            self.now = 1011; return self.runner(args, **kwargs)
        self.assertFalse(self.consume(runner=expired)); self.assertEqual(len(self.calls), 1)
        self.now = 1000; self.calls = []; self.write()
        def active(args, **kwargs):
            self.calls.append(args); return types.SimpleNamespace(stdout='ActiveState=active\nMainPID=123\n')
        self.assertFalse(self.consume(runner=active)); self.assertEqual(len(self.calls), 1)
    def test_actual_process_identity_requires_all_uids_and_same_starttick(self):
        proc = Path(self.temp.name) / 'proc'; directory = proc / '123'; directory.mkdir(parents=True)
        (directory / 'status').write_text('Uid: 1000 1000 1000 1000\n')
        (directory / 'stat').write_text('123 (original wrapper) ' + ' '.join(['S'] + ['0'] * 18 + ['42']))
        self.assertTrue(helper.alive_original(self.payload, 1000, proc))
        self.assertFalse(helper.alive_original(dict(self.payload, startTick='43'), 1000, proc))
        (directory / 'status').write_text('Uid: 1000 0 1000 1000\n')
        self.assertFalse(helper.alive_original(self.payload, 1000, proc))
    def test_atomic_client_publish_does_not_replace_or_replay(self):
        identity = client.publish(self.request, self.payload)
        self.assertEqual(json.loads(self.request.read_text()), self.payload)
        with self.assertRaises(FileExistsError): client.publish(self.request, dict(self.payload, nonce='b' * 32))
        self.assertEqual(json.loads(self.request.read_text()), self.payload)
        self.request.unlink(); replacement = client.publish(self.request, dict(self.payload, nonce='b' * 32))
        client.remove_own_request(self.request, identity); self.assertTrue(self.request.exists())
        client.remove_own_request(self.request, replacement); self.assertFalse(self.request.exists())
    def test_immediate_helper_consumption_does_not_break_publication(self):
        link = os.link
        def immediately_consumed(source, destination):
            link(source, destination); Path(destination).unlink()
        with patch.object(client.os, 'link', side_effect=immediately_consumed):
            identity = client.publish(self.request, self.payload)
        self.assertEqual(identity[2], self.payload['nonce']); self.assertFalse(self.request.exists())
    def test_consumed_request_ready_wait_is_bounded_to_sixty_seconds(self):
        identity = client.publish(self.request, self.payload); self.request.unlink()
        elapsed = [0]
        def read(args, timeout):
            self.assertLessEqual(timeout, 60 - elapsed[0]); elapsed[0] += timeout; return 'inactive'
        with self.assertRaisesRegex(RuntimeError, 'HOME_READY_TIMEOUT'):
            client.wait_ready(self.request, self.payload, identity, read=read, monotonic=lambda: elapsed[0], clock=lambda: 1000,
                              sleep=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds))
        self.assertLessEqual(elapsed[0], 60)
    def test_queued_request_expires_without_new_submission(self):
        identity = client.publish(self.request, self.payload)
        with self.assertRaisesRegex(RuntimeError, 'HOME_REQUEST_EXPIRED'):
            client.wait_ready(self.request, self.payload, identity, read=lambda *args, **kwargs: 'inactive', clock=lambda: 1011)
        self.assertFalse(self.request.exists())
    def test_nnp_survives_client_interpreter_without_privilege_gain(self):
        result = subprocess.check_output(['/usr/bin/setpriv', '--no-new-privs', '/usr/bin/python3', '-I', '-c',
                 "from pathlib import Path; print(next(v for v in Path('/proc/self/status').read_text().splitlines() if v.startswith('NoNewPrivs:')))"], text=True)
        self.assertEqual(result.strip(), 'NoNewPrivs:\t1')

if __name__ == '__main__': unittest.main()

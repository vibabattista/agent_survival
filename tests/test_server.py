"""Run: python3 -m unittest discover -s tests (no network or API charges)."""
import io
import json
import os
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
import server
import storage


class FakeResponse(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *args): self.close()


def handle(data, path='/api/respond'):
    encoded = json.dumps(data).encode()
    handler = object.__new__(server.Handler)
    handler.path = path
    handler.headers = {'Origin': 'http://127.0.0.1:8765', 'Content-Length': str(len(encoded))}
    handler.rfile = io.BytesIO(encoded)
    out = {}
    handler.reply = lambda status, data: out.update(status=status, data=data)
    handler.do_POST()
    return out


class ServerTests(unittest.TestCase):
    def test_replay_capability_is_exposed(self):
        handler = object.__new__(server.Handler)
        handler.path = '/api/capabilities'
        out = {}
        handler.reply = lambda status, data: out.update(status=status, data=data)
        handler.do_GET()
        self.assertEqual(out['status'], 200)
        self.assertIn('worldFrames', out['data']['features'])

    def test_legacy_import_preserves_history_and_raw_records(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(storage, 'DB_PATH', Path(folder) / 'lab.sqlite3'):
            old = {'current': {'agents': [], 'settings': {}, 'events': [{'text': 'event'}]}, 'history': [{'tick': 0}], 'rawRequests': [{'prompt': 'hello'}]}
            self.assertEqual(handle(old, '/api/import')['status'], 200)
            with storage.connect() as db:
                self.assertEqual(storage.get_state(db), old['current'])
                self.assertEqual(storage.get_raw(db), old['rawRequests'])
                self.assertEqual(db.execute('SELECT COUNT(*) FROM archives').fetchone()[0], 1)
            self.assertEqual(handle(old, '/api/import')['status'], 400)

    def test_restore_archives_previous_experiment_and_preserves_exported_raw(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(storage, 'DB_PATH', Path(folder) / 'lab.sqlite3'):
            first = {'tick': 1, 'agents': [], 'settings': {}, 'events': [{'text': 'old'}]}
            second = {'tick': 2, 'agents': [], 'settings': {}, 'events': [{'text': 'restored'}]}
            self.assertEqual(handle(first, '/api/state')['status'], 200)
            self.assertEqual(handle({'current': second, 'rawRequests': [{'prompt': 'unsaved'}]}, '/api/restore')['status'], 200)
            with storage.connect() as db:
                self.assertEqual(storage.get_state(db), second)
                self.assertEqual(storage.get_raw(db), [{'prompt': 'unsaved'}])
                self.assertEqual(db.execute('SELECT COUNT(*) FROM archives').fetchone()[0], 2)

    def test_legal_actions_are_the_schema_enum(self):
        result = {'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': '{}'}]}]}
        request = {'provider': 'openai', 'model': 'gpt-6-luna', 'input': 'Choose JSON', 'response_format': 'decision', 'allowed_actions': ['wait', 'rest']}
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'test-only'}), patch.object(server, 'urlopen', return_value=FakeResponse(json.dumps(result).encode())) as send:
            self.assertEqual(handle(request)['status'], 200)
        body = json.loads(send.call_args.args[0].data)
        schema = body['text']['format']['schema']
        self.assertEqual(schema['properties']['action']['enum'], ['wait', 'rest'])
        self.assertTrue(body['text']['format']['strict'])
        self.assertFalse(body['store'])

    def test_unknown_action_is_not_forwarded(self):
        request = {'provider': 'openai', 'model': 'gpt-6-luna', 'input': 'Choose JSON', 'response_format': 'decision', 'allowed_actions': ['repair_wound']}
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'test-only'}), patch.object(server, 'urlopen') as send:
            self.assertEqual(handle(request)['status'], 400)
            send.assert_not_called()

    def test_thinking_and_recall_cap_are_exposed_in_model_schema(self):
        result = {'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': '{}'}]}]}
        request = {'provider': 'openai', 'model': 'test', 'input': 'Choose JSON', 'response_format': 'decision', 'allowed_actions': ['think', 'wait'], 'allow_recall': False}
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'test-only'}), patch.object(server, 'urlopen', return_value=FakeResponse(json.dumps(result).encode())) as send:
            self.assertEqual(handle(request)['status'], 200)
        fields = json.loads(send.call_args.args[0].data)['text']['format']['schema']['properties']
        self.assertIn('think', fields['action']['enum'])
        self.assertEqual(fields['recall_query']['enum'], [''])
        self.assertIn('append', fields['notebook_operation']['enum'])

    def test_missing_key_is_not_forwarded(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(server, 'urlopen') as send:
            self.assertEqual(handle({'provider':'openai', 'model':'gpt-6-luna', 'input':'JSON', 'response_format':'decision'})['status'], 400)
            send.assert_not_called()


if __name__ == '__main__': unittest.main()

import tempfile
import unittest
from pathlib import Path

import storage


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = storage.connect(Path(self.tmp.name) / 'test.sqlite3')
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.db.close)

    def test_appends_logs_once_and_reconstructs_current_state(self):
        state = {'tick': 1, 'events': [{'text': 'first'}], 'agents': [{'name': 'A', 'experiences': [{'text': 'private'}]}]}
        with self.db:
            storage.set_state(self.db, state)
        state['tick'] = 2
        state['events'].append({'text': 'second'})
        state['agents'][0]['experiences'].append({'text': 'another'})
        with self.db:
            storage.set_state(self.db, state)
        self.assertEqual(storage.get_state(self.db), state)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM entries').fetchone()[0], 4)
        self.assertNotIn('first', self.db.execute('SELECT data FROM state').fetchone()[0])

    def test_shortening_an_existing_log_rolls_back(self):
        state = {'events': [1, 2], 'agents': []}
        with self.db:
            storage.set_state(self.db, state)
        with self.assertRaises(ValueError):
            with self.db:
                storage.set_state(self.db, {'events': [1], 'agents': []})
        self.assertEqual(storage.get_state(self.db), state)

    def test_incremental_commit_and_stale_update(self):
        original = {'tick': 1, 'events': ['first'], 'agents': [{'name': 'A', 'experiences': ['private']}]}
        with self.db:
            storage.set_state(self.db, original)
        update = {'state': {'tick': 2, 'events': [], 'agents': [{'name': 'A', 'experiences': []}]},
                  'append': [{'scope': 'world', 'kind': 'events', 'expected': 1, 'items': ['second']},
                             {'scope': '0', 'kind': 'experiences', 'expected': 1, 'items': ['next']}]}
        with self.db:
            storage.commit_delta(self.db, update)
        self.assertEqual(storage.get_state(self.db)['events'], ['first', 'second'])
        with self.assertRaises(ValueError):
            with self.db:
                storage.commit_delta(self.db, update)
        self.assertEqual(storage.get_state(self.db)['tick'], 2)

    def test_replay_frames_survive_save_and_reload(self):
        state = {'agents': [], 'events': [{'text': 'hello', 'frameIndex': 0}], 'worldFrames': [{'day': 1, 'tick': 1, 'agents': []}]}
        with self.db:
            storage.set_state(self.db, state)
        self.assertEqual(storage.get_state(self.db), state)

    def test_raw_records_are_compressed_and_lossless(self):
        record = {'prompt': 'the same conversation repeated ' * 1000, 'output': 'ok'}
        with self.db:
            storage.add_raw(self.db, record)
        stored = self.db.execute('SELECT data FROM raw').fetchone()[0]
        self.assertLess(len(stored), len(storage.encode(record).encode()) // 10)
        self.assertEqual(storage.get_raw(self.db), [record])

    def test_history_search_is_private_and_preserves_original_text(self):
        state = {'agents': [
            {'name': 'Mara', 'experiences': [{'day': 1, 'tick': 3, 'kind': 'speech', 'text': 'Kit: “I shared my apple.”'}, {'day': 1, 'tick': 3, 'kind': 'speech', 'text': 'Mara: “Thank you.”'}, {'day': 2, 'tick': 1, 'text': 'Kit today'}]},
            {'name': 'Bea', 'experiences': [{'day': 1, 'tick': 3, 'kind': 'speech', 'text': 'Kit: “Private secret.”'}]}
        ]}
        with self.db:
            storage.set_state(self.db, state)
        result = storage.search_experiences(self.db, 0, 'Kit', before_day=2)
        self.assertEqual([r['text'] for r in result['results']], ['Kit: “I shared my apple.”'])
        self.assertEqual(result['results'][0]['heardSpeechThatTick'], ['Kit: “I shared my apple.”', 'Mara: “Thank you.”'])
        self.assertFalse(result['hasMore'])


if __name__ == '__main__':
    unittest.main()

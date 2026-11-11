"""Local, transactional storage for Tiny Town experiments."""
import json
import sqlite3
import zlib
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / 'data' / 'tiny_town.sqlite3'


def connect(path=None):
    path = Path(path or DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS entries (scope TEXT NOT NULL, kind TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,kind,idx))')
    db.execute('CREATE TABLE IF NOT EXISTS raw (id INTEGER PRIMARY KEY, data TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS archives (id INTEGER PRIMARY KEY, created TEXT DEFAULT CURRENT_TIMESTAMP, data TEXT NOT NULL)')
    return db


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def get_state(db):
    row = db.execute('SELECT data FROM state WHERE id=1').fetchone()
    if not row:
        return None
    result = json.loads(row[0])
    for scope, kind, data in db.execute('SELECT scope,kind,data FROM entries ORDER BY idx'):
        target = result if scope == 'world' else result['agents'][int(scope)]
        target.setdefault(kind, []).append(json.loads(data))
    return result


def set_state(db, state):
    state = json.loads(encode(state))
    for scope, target, fields in [('world', state, ('events', 'decisionRecords', 'chronicles', 'worldFrames'))] + [
        (str(i), agent, ('experiences', 'observedEvents', 'impressions', 'memories', 'dailyReflections'))
        for i, agent in enumerate(state.get('agents', []))
    ]:
        for kind in fields:
            if kind not in target:
                continue
            values = target.pop(kind)
            if not isinstance(values, list):
                raise ValueError(f'{scope}.{kind} must be a list')
            count = db.execute('SELECT COUNT(*) FROM entries WHERE scope=? AND kind=?', (scope, kind)).fetchone()[0]
            if count > len(values):
                raise ValueError(f'{scope}.{kind} cannot be shortened')
            db.executemany('INSERT INTO entries(scope,kind,idx,data) VALUES(?,?,?,?)',
                           ((scope, kind, i, encode(values[i])) for i in range(count, len(values))))
            target[kind] = []
    db.execute('INSERT OR REPLACE INTO state(id,data) VALUES(1,?)', (encode(state),))


def commit_delta(db, payload):
    state = payload.get('state')
    changes = payload.get('append')
    if not isinstance(state, dict) or not isinstance(state.get('agents'), list) or not isinstance(changes, list):
        raise ValueError('Invalid experiment update')
    allowed = {'world': {'events', 'decisionRecords', 'chronicles', 'worldFrames'}}
    for i in range(len(state['agents'])):
        allowed[str(i)] = {'experiences', 'observedEvents', 'impressions', 'memories', 'dailyReflections'}
    for change in changes:
        scope, kind, expected, items = change['scope'], change['kind'], change['expected'], change['items']
        if kind not in allowed.get(scope, set()) or not isinstance(expected, int) or expected < 0 or not isinstance(items, list):
            raise ValueError('Invalid log update')
        count = db.execute('SELECT COUNT(*) FROM entries WHERE scope=? AND kind=?', (scope, kind)).fetchone()[0]
        if count != expected:
            raise ValueError('Experiment changed in another tab; reload after exporting unsaved output')
        db.executemany('INSERT INTO entries(scope,kind,idx,data) VALUES(?,?,?,?)',
                       ((scope, kind, expected + i, encode(item)) for i, item in enumerate(items)))
    db.execute('INSERT OR REPLACE INTO state(id,data) VALUES(1,?)', (encode(state),))


def add_raw(db, record):
    db.execute('INSERT INTO raw(data) VALUES(?)', (zlib.compress(encode(record).encode()),))


def get_raw(db, limit=None):
    query = 'SELECT data FROM raw ORDER BY id DESC'
    rows = db.execute(query + (' LIMIT ?' if limit is not None else ''), (limit,) if limit is not None else ())
    return [json.loads(zlib.decompress(row[0])) for row in rows]


def search_experiences(db, agent_index, query, before_day, offset=0, page_size=10):
    """Search only an agent's own timestamped experiences; return pages in order."""
    if not isinstance(agent_index, int) or isinstance(agent_index, bool) or agent_index < 0:
        raise ValueError('Invalid agent')
    if not isinstance(query, str) or not query.strip() or len(query) > 500:
        raise ValueError('Enter a search phrase')
    if not isinstance(before_day, int) or not isinstance(offset, int) or offset < 0:
        raise ValueError('Invalid search range')
    scope = str(agent_index)
    rows = db.execute('''SELECT kind,data FROM entries WHERE scope=? AND
        ((kind='experiences' AND json_extract(data,'$.day') < ? AND instr(lower(json_extract(data,'$.text')),lower(?)) > 0)
         OR (kind='dailyReflections' AND json_extract(data,'$.day') < ? AND instr(lower(data),lower(?)) > 0)
         OR (kind='memories' AND json_type(data)='text' AND instr(lower(json_extract(data,'$')),lower(?)) > 0))
        ORDER BY kind,idx LIMIT ? OFFSET ?''', (scope, before_day, query.strip(), before_day, query.strip(), query.strip(), page_size + 1, offset)).fetchall()
    results = []
    for kind, data in rows[:page_size]:
        item = json.loads(data)
        if kind == 'experiences':
            if item.get('kind') == 'speech' and item.get('day') is not None and item.get('tick') is not None:
                context = db.execute('''SELECT data FROM entries WHERE scope=? AND kind='experiences'
                    AND json_extract(data,'$.kind')='speech' AND json_extract(data,'$.day')=?
                    AND json_extract(data,'$.tick')=? ORDER BY idx''', (scope, item['day'], item['tick'])).fetchall()
                item['heardSpeechThatTick'] = [json.loads(row[0])['text'] for row in context]
            results.append(item)
        elif kind == 'dailyReflections':
            results.append({'day': item.get('day'), 'tick': None, 'kind': 'daily reflection', 'text': encode(item)})
        else:
            results.append({'day': None, 'tick': None, 'kind': 'legacy journal (time and provenance unknown)', 'text': item})
    return {'results': results, 'hasMore': len(rows) > page_size, 'nextOffset': offset + page_size}


def archive(db, value):
    db.execute('INSERT INTO archives(data) VALUES(?)', (zlib.compress(encode(value).encode()),))

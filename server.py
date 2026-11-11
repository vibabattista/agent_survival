"""Local simulation server with Ollama and optional OpenAI adapters."""
import json
import os
import posixpath
import sqlite3
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
import storage

# Structured outputs are restricted to the application's existing action protocol.
SCHEMAS = {
    'decision': {'action': {'type': 'string', 'enum': ['travel', 'help_travel', 'search', 'eat', 'take', 'store', 'pick_up', 'rest', 'speak', 'give', 'take_from', 'attack', 'wait', 'think']}, 'target': {'type': 'string'}, 'destination': {'type': 'string'}, 'pace': {'type': 'string', 'enum': ['', 'fast', 'medium', 'slow']}, 'effort': {'type': 'integer'}, 'speech': {'type': 'string'}, 'thought': {'type': 'string'}, 'memory': {'type': 'string'}},
    'reply': {'speech': {'type': 'string'}, 'memory': {'type': 'string'}},
    'conversation': {'speech': {'type': 'string'}, 'memory': {'type': 'string'}, 'choice': {'type': 'string', 'enum': ['continue', 'end', 'attack']}, 'effort': {'type': 'integer'}},
    'defence': {'defence': {'type': 'integer'}, 'speech': {'type': 'string'}, 'memory': {'type': 'string'}},
    'dispute': {'choice': {'type': 'string', 'enum': ['yield', 'insist', 'attack']}, 'speech': {'type': 'string'}, 'target': {'type': 'string'}, 'effort': {'type': 'integer'}},
    'take target': {'choice': {'type': 'string', 'enum': ['allow', 'refuse', 'fight']}, 'speech': {'type': 'string'}, 'effort': {'type': 'integer'}, 'memory': {'type': 'string'}},
    'take taker': {'choice': {'type': 'string', 'enum': ['back_off', 'fight']}, 'speech': {'type': 'string'}, 'effort': {'type': 'integer'}, 'memory': {'type': 'string'}},
    'help response': {'choice': {'type': 'string', 'enum': ['accept', 'decline']}, 'speech': {'type': 'string'}, 'memory': {'type': 'string'}},
    'reflection': {'summary': {'type': 'string'}, 'deductions': {'type': 'string'}, 'future_intentions': {'type': 'string'}},
    'notebook_organise': {'notebook': {'type': 'string'}},
}

# Agents may deliberately replace their own notebook while responding.  An
# unchanged notebook is represented by operation "keep" and an empty value.
for _kind in ('decision', 'conversation', 'defence', 'dispute', 'take target', 'take taker', 'help response', 'reflection'):
    SCHEMAS[_kind]['notebook_operation'] = {'type': 'string', 'enum': ['keep', 'append', 'replace']}
    SCHEMAS[_kind]['notebook'] = {'type': 'string'}
    SCHEMAS[_kind]['recall_query'] = {'type': 'string'}
    SCHEMAS[_kind]['recall_source'] = {'type': 'string', 'enum': ['', 'notebook', 'history']}
    SCHEMAS[_kind]['recall_offset'] = {'type': 'integer'}
SCHEMAS['reflection']['notebook_operation'] = {'type': 'string', 'enum': ['append', 'replace']}

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = posixpath.normpath(unquote(urlsplit(self.path).path))
        if path == '/data' or path.startswith('/data/'):
            self.send_error(404); return
        if self.path == '/api/capabilities':
            self.reply(200, {'schemaVersion': 2, 'features': ['worldFrames']}); return
        if self.path in ('/api/experiment', '/api/export'):
            try:
                with storage.connect() as db:
                    state = storage.get_state(db)
                    data = {'current': state, 'rawRequests': storage.get_raw(db, None if self.path == '/api/export' else 100)}
                    if self.path == '/api/export':
                        data['archivedExperiments'] = [json.loads(zlib.decompress(row[0])) for row in db.execute('SELECT data FROM archives ORDER BY id')]
                self.reply(200, data)
            except (OSError, sqlite3.Error) as e:
                self.reply(500, {'error': 'Local storage unavailable: ' + str(e)})
            return
        super().do_GET()

    def do_POST(self):
        if self.path not in ('/api/respond', '/api/state', '/api/commit', '/api/raw', '/api/import', '/api/restore', '/api/new', '/api/recall') or self.headers.get('Origin') != 'http://127.0.0.1:8765':
            self.send_error(403); return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size > (100000 if self.path == '/api/respond' else 100000000): raise ValueError('Request too large')
            data = json.loads(self.rfile.read(size))
            if self.path != '/api/respond':
                if not isinstance(data, dict): raise ValueError('Expected a JSON object')
                with storage.connect() as db:
                    if self.path == '/api/recall':
                        result = storage.search_experiences(db, data.get('agentIndex'), data.get('query'), data.get('beforeDay'), data.get('offset', 0))
                        self.reply(200, result); return
                    db.execute('BEGIN IMMEDIATE')
                    if self.path == '/api/state':
                        storage.set_state(db, data)
                    elif self.path == '/api/commit':
                        storage.commit_delta(db, data)
                    elif self.path == '/api/raw':
                        storage.add_raw(db, data)
                    elif self.path in ('/api/import', '/api/restore'):
                        old = storage.get_state(db)
                        if self.path == '/api/import' and old is not None: raise ValueError('An experiment already exists on disk')
                        current = data.get('current')
                        if not isinstance(current, dict) or not isinstance(current.get('agents'), list) or not isinstance(current.get('settings'), dict): raise ValueError('Invalid current experiment')
                        records = data.get('rawRequests', [])
                        if not isinstance(records, list) or any(not isinstance(record, dict) for record in records): raise ValueError('Invalid model request archive')
                        if old is not None:
                            storage.archive(db, {'current': old, 'rawRequests': storage.get_raw(db)})
                            db.execute('DELETE FROM entries')
                            db.execute('DELETE FROM raw')
                        storage.archive(db, {k: v for k, v in data.items() if k != 'rawRequests'})
                        storage.set_state(db, current)
                        for record in reversed(records): storage.add_raw(db, record)
                    else:
                        old = storage.get_state(db)
                        if old is not None: storage.archive(db, {'current': old, 'rawRequests': storage.get_raw(db)})
                        db.execute('DELETE FROM raw')
                        db.execute('DELETE FROM entries')
                        storage.set_state(db, data)
                self.reply(200, {'ok': True}); return
            model = data.get('model', '').strip()
            provider = data.get('provider', 'ollama')
            if not model: raise ValueError('Select a model.')
            if provider == 'ollama':
                if ':cloud' in model.lower(): raise ValueError('Select a local Ollama model, not a cloud model.')
                payload = json.dumps({'model': model, 'prompt': data['input'], 'stream': False}).encode()
                request = Request('http://127.0.0.1:11434/api/generate', data=payload, headers={'Content-Type': 'application/json'})
            elif provider == 'openai':
                key = os.environ.get('OPENAI_API_KEY', '').strip()
                if not key: raise ValueError('OPENAI_API_KEY is not set in the server environment. See README.md.')
                effort = data.get('reasoning_effort', 'medium')
                if effort not in ('none', 'low', 'medium', 'high', 'xhigh', 'max'):
                    raise ValueError('Invalid reasoning effort.')
                schema_kind = data.get('response_format', 'text')
                payload_data = {'model': model, 'input': data['input'], 'reasoning': {'effort': effort}, 'store': False, 'max_output_tokens': 8000 if schema_kind == 'notebook_organise' else 1500}
                if schema_kind not in (*SCHEMAS, 'text', 'json'):
                    raise ValueError('Unknown response format.')
                if schema_kind in SCHEMAS:
                    fields = dict(SCHEMAS[schema_kind])
                    if schema_kind == 'decision' and 'allowed_actions' in data:
                        allowed = data['allowed_actions']
                        known = SCHEMAS['decision']['action']['enum']
                        if not isinstance(allowed, list) or not allowed or any(not isinstance(x, str) or x not in known for x in allowed):
                            raise ValueError('Invalid allowed actions.')
                        fields['action'] = {'type': 'string', 'enum': list(dict.fromkeys(allowed))}
                    if 'recall_query' in fields and data.get('allow_recall') is False:
                        fields['recall_query'] = {'type': 'string', 'enum': ['']}
                    payload_data['text'] = {'format': {'type': 'json_schema', 'name': 'agent_response', 'strict': True, 'schema': {'type': 'object', 'properties': fields, 'required': list(fields), 'additionalProperties': False}}}
                elif schema_kind == 'json':
                    payload_data['text'] = {'format': {'type': 'json_object'}}
                payload = json.dumps(payload_data).encode()
                request = Request('https://api.openai.com/v1/responses', data=payload, headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
            else: raise ValueError('Unknown model provider.')
            with urlopen(request, timeout=90) as response: result = json.load(response)
            if provider == 'ollama':
                answer = result.get('response', '')
                usage = {'input_tokens': result.get('prompt_eval_count', 0), 'output_tokens': result.get('eval_count', 0)}
            else:
                answer = '\n'.join(part.get('text', '') for item in result.get('output', []) if item.get('type') == 'message' for part in item.get('content', []) if part.get('type') == 'output_text')
                usage = result.get('usage', {})
            if not answer.strip() and result.get('status') != 'incomplete': raise ValueError('The model returned no text. Check model access and response limits.')
            self.reply(200, {'text': answer, 'usage': usage, 'status': result.get('status'), 'incomplete_details': result.get('incomplete_details')})
        except HTTPError as e:
            self.reply(502, {'error': f'{provider} error ({e.code}): ' + e.read().decode(errors='replace')[:1200]})
        except (ValueError, KeyError, URLError, TimeoutError, sqlite3.Error, OSError) as e:
            self.reply(400, {'error': str(e)})
    def reply(self, status, value):
        body = json.dumps(value).encode(); self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

if __name__ == '__main__':
    print('Tiny Town: http://127.0.0.1:8765', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8765), Handler).serve_forever()

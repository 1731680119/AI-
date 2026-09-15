"""以全新目录验证 PyInstaller 产物；唯一模型上游为脚本内的本地假服务。"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser()
parser.add_argument('--exe', required=True)
parser.add_argument('--data', required=True)
args = parser.parse_args()
data = Path(args.data).resolve()
if (data / 'chatbot.db').exists():
    raise SystemExit('Smoke test requires a NEW directory, not an existing database')
data.mkdir(parents=True, exist_ok=True)

class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for delta, reason in [({'content': 'QA answer'}, None), ({}, 'stop')]:
            chunk = {'id': 'qa', 'object': 'chat.completion.chunk', 'created': 1,
                     'model': 'qa-chat', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
            self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n')

upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
threading.Thread(target=upstream.serve_forever, daemon=True).start()
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
env = {**os.environ, 'CHATBOT_DATA_DIR': str(data), 'CHATBOT_LOG_DIR': str(data / 'logs'),
       'PYTHON_DOTENV_DISABLED': '1', 'OPENAI_API_KEY': ''}
log = open(data.parent / 'backend-smoke.log', 'wb')
process = subprocess.Popen([str(Path(args.exe).resolve()), '--port', str(port)], env=env,
                           stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
base = f'http://127.0.0.1:{port}'
def request(path, body=None, method=None):
    req = Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                  headers={'Content-Type': 'application/json'}, method=method)
    with urlopen(req, timeout=20) as response:
        content = response.read().decode()
        return content if path == '/api/chat' else json.loads(content)

try:
    deadline = time.monotonic() + 120
    while True:
        try:
            request('/api/health')
            break
        except Exception:
            if process.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError('Packaged backend did not start; inspect backend-smoke.log')
            time.sleep(0.5)
    settings = request('/api/settings')
    assert settings['default_model']
    request('/api/settings', {'base_url': f'http://127.0.0.1:{upstream.server_port}/v1',
            'api_key': 'qa-local-only', 'models': ['qa-chat'], 'default_model': 'qa-chat',
            'tools_enabled': False, 'memory_enabled': False, 'code_exec_enabled': False,
            'context_auto_compact': False}, 'PUT')
    cid = request('/api/conversations', {})['id']
    response = request('/api/chat', {'conversation_id': cid, 'content': 'QA question'})
    assert 'QA answer' in response and '"type": "done"' in response, response
    request('/api/chat', {'conversation_id': cid, 'content': 'QA edited root', 'parent_id': None})
    result = request('/api/conversations/' + cid)
    roots = [m for m in result['messages'] if m['parent_id'] is None]
    assert len(roots) == 2, roots
    assert len(result['messages']) == 4
    request('/api/settings', {'base_url': '', 'api_key': ''}, 'PUT')
    (data.parent / 'smoke-result.json').write_text(json.dumps({
        'health': 'passed', 'settings': 'passed', 'chat_stream': 'passed',
        'root_branch': 'passed', 'messages': len(result['messages']), 'data': str(data),
    }, indent=2), encoding='utf8')
    print('PACKAGED SMOKE PASS: health, settings, local model SSE, persisted root edit (4 messages)')
finally:
    if process.poll() is None:
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=subprocess.CREATE_NO_WINDOW, check=False)
    process.wait(timeout=20)
    log.close()
    upstream.shutdown()

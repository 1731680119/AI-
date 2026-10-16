"""用本地分块 HTTP SSE 验证真实网络读取，可由打包 exe --run-script 执行。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading

if not getattr(sys, 'frozen', False):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    with tempfile.TemporaryDirectory(prefix='chatbot-search-stream-') as directory:
        os.environ['CHATBOT_DATA_DIR'] = directory
        os.environ['CHATBOT_LOG_DIR'] = str(Path(directory) / 'logs')
        os.environ['PYTHON_DOTENV_DISABLED'] = '1'
        import web_search as ws
        import logging_config as diag
        ws._dashscope_host_supported = lambda _provider: True

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            calls = []
            def log_message(self, *_args):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                type(self).calls.append(body)
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Transfer-Encoding', 'chunked')
                self.end_headers()
                if body['input']['messages'][0]['content'][0]['text'].endswith('interrupt') and len(self.calls) == 1:
                    self.wfile.write(b'20\r\ndata: {"output":')
                    self.wfile.flush()
                    self.connection.shutdown(socket.SHUT_WR)
                    self.close_connection = True
                    return
                payload = {'output': {'choices': [{'message': {'content': [{'text': '本地搜索成功'}]}}],
                                      'search_info': {'search_results': [{'url': 'https://example.org', 'title': '本地来源'}]}}}
                data = ('data: ' + json.dumps(payload, ensure_ascii=False) + '\n\ndata: [DONE]\n\n').encode()
                # Deliberately split UTF-8 and SSE lines across HTTP chunks.
                for offset in range(0, len(data), 7):
                    chunk = data[offset:offset + 7]
                    self.wfile.write(f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
                self.wfile.write(b'0\r\n\r\n')
                self.wfile.flush()

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            provider = ws.normalize_provider({'protocol': 'qwen', 'model': 'qwen3.7-plus', 'search_strategy': 'agent',
                                              'base_url': f'http://127.0.0.1:{server.server_port}', 'api_key': 'local-fake-only'})
            for query, expected_calls in [('complete', 1), ('interrupt', 2)]:
                Handler.calls.clear()
                events = list(ws.search(provider, query, timeout=5))
                assert events[-1]['type'] == 'result', events
                assert events[-1]['text'] == '本地搜索成功', events
                assert len(events[-1]['sources']) == 1
                assert len(Handler.calls) == expected_calls, Handler.calls
                assert all(call['model'] == 'qwen3.7-plus' for call in Handler.calls)
            print('SEARCH STREAM SMOKE PASS: chunked UTF-8 SSE, interrupted response reconnect, Qwen3.7-plus agent')
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            if diag._writer:
                diag._writer.close()


if __name__ == '__main__':
    main()

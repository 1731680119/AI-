"""联网检索兼容性回归；只使用临时目录与模拟响应，不访问付费上游。"""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_data = tempfile.TemporaryDirectory(prefix='chatbot-search-test-')
os.environ['CHATBOT_DATA_DIR'] = _data.name
os.environ['CHATBOT_LOG_DIR'] = str(Path(_data.name) / 'logs')
os.environ['PYTHON_DOTENV_DISABLED'] = '1'

import model_probe
import search_capabilities as caps
import web_search as ws
import logging_config as diag


def provider(model='qwen-plus', **extra):
    return ws.normalize_provider(dict(protocol='qwen', base_url='https://test.cn-beijing.maas.aliyuncs.com/api/v1',
                                      api_key='test-only', model=model, **extra))


def sse(*events):
    stream = io.BytesIO(''.join('data:' + json.dumps(event) + '\n\n' for event in events).encode())
    stream.headers = {'Content-Type': 'text/event-stream'}
    return stream


class SearchRegression(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        if diag._writer:
            diag._writer.close()
        _data.cleanup()

    def test_endpoint_and_strategy_matrix(self):
        cases = [
            ('qwen-plus', False, ['turbo', 'max']),
            ('qwen3.7-max', False, ['turbo', 'max', 'agent']),
            ('qwen3.7-plus', True, ['turbo', 'max', 'agent']),
            ('qwen3.7-flash', True, ['turbo', 'max', 'agent']),
            ('qwen3.5-plus', True, ['turbo', 'max', 'agent', 'agent_max']),
            ('qwen3.6-plus', True, ['turbo', 'max', 'agent']),
            ('qwen3.8-max', True, ['turbo', 'max']),
            ('qwen3.8-omni-flash', True, ['agent']),
            ('qwen3.5-omni-plus', True, ['agent']),
            ('qwen-flash-character', False, ['turbo', 'max']),
            ('qwen3-max', False, ['turbo', 'max', 'agent_max']),
        ]
        for model, multimodal, choices in cases:
            with self.subTest(model=model):
                p = provider(model)
                self.assertEqual(caps.strategies(p), choices)
                service = 'multimodal' if multimodal else 'text'
                self.assertTrue(caps.endpoint(p).endswith(f'/{service}-generation/generation'))

    def test_unsupported_strategy_is_replaced_on_model_switch(self):
        self.assertEqual(provider('qwen3.8-max', search_strategy='agent')['search_strategy'], 'turbo')
        self.assertEqual(provider('qwen3.5-omni-plus', search_strategy='max')['search_strategy'], 'agent')
        self.assertEqual(provider('qwen-plus', api_type='responses')['api_type'], 'dashscope')

    def test_agent_options_remove_forced_search(self):
        for strategy in ('agent', 'agent_max'):
            params = ws._dashscope_body(provider('qwen3.5-plus', search_strategy=strategy), 'weather')['parameters']
            self.assertEqual(params['search_options'], {'search_strategy': strategy, 'enable_source': True})
            self.assertTrue(params['stream'])
            self.assertEqual(params['max_tokens'], 4000)
            self.assertNotIn('result_format', params)
            if strategy == 'agent_max':
                self.assertTrue(params['enable_thinking'])
        params = ws._dashscope_body(provider(search_strategy='max'), 'weather')['parameters']
        self.assertTrue(params['search_options']['forced_search'])
        self.assertEqual(params['result_format'], 'message')

    def test_omni_only_requests_text(self):
        body = ws._dashscope_body(provider('qwen3.5-omni-flash'), 'weather')
        self.assertEqual(body['parameters']['modalities'], ['text'])
        self.assertIsInstance(body['input']['messages'][0]['content'], list)

    def test_responses_has_no_strategy_parameters(self):
        for model in ('qwen3.8-max', 'glm-5.2', 'kimi-k3'):
            p = provider(model, api_type='responses', search_strategy='agent_max')
            body = ws._request_body(p, 'weather', True)
            self.assertEqual(caps.strategies(p), [])
            self.assertEqual(body['tools'], [{'type': 'web_search'}])
            self.assertNotIn('search_options', body)
            self.assertNotIn('search_strategy', body)
            self.assertTrue(body['enable_thinking'])
        self.assertEqual(caps.resolve_api(provider('kimi-k3')), 'responses')

    def test_full_urls_preserve_workspace_and_region(self):
        root = 'https://space.ap-southeast-1.maas.aliyuncs.com'
        tails = ['', '/api/v1', '/compatible-mode/v1', '/compatible-mode/v1/chat/completions',
                 '/compatible-mode/v1/responses', '/api/v1/services/aigc/text-generation/generation']
        for tail in tails:
            p = {**provider('qwen3.8-max'), 'base_url': root + tail}
            self.assertEqual(caps.endpoint(p, 'responses'), root + '/compatible-mode/v1/responses')
            self.assertEqual(caps.endpoint(p), root + '/api/v1/services/aigc/multimodal-generation/generation')

    def test_unknown_old_snapshot_and_realtime_do_not_make_requests(self):
        for model in ('qwen-turbo', 'qwen3.8-omni-flash-realtime', 'qwen3.5-plus-2026-01-01', 'qwen3.7-flash-2026-06-01'):
            with patch.object(ws, '_post_to') as post:
                events = list(ws.search(provider(model), 'weather'))
                self.assertEqual(events[-1]['type'], 'error')
                post.assert_not_called()

    def test_model_listing_uses_compatible_path_and_filters_search_models(self):
        payload = {'data': [{'id': model} for model in ('qwen3.8-max', 'qwen-plus', 'text-embedding-v4')]}
        with patch.object(model_probe, '_fetch', return_value=(payload, 'list-url')) as fetch:
            result = model_probe.list_models(provider()['base_url'], 'test-key', 'qwen')
            self.assertEqual(fetch.call_args.args[0], 'https://test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
            self.assertEqual(result['models'], ['qwen3.8-max', 'qwen-plus'])

    def test_missing_listing_falls_back_to_documented_candidates_but_auth_errors_do_not(self):
        for status in (404, 401, 403, 429):
            with patch.object(model_probe, '_fetch', side_effect=model_probe.ProbeError('mock-error', status)):
                result = model_probe.list_models(provider()['base_url'], 'test-key', 'qwen', 'responses')
                if status == 404:
                    self.assertTrue(result['ok'])
                    self.assertIn('未验证', result['message'])
                    self.assertIn('qwen3.8-max', result['models'])
                    self.assertNotIn('qwen-plus', result['models'])
                else:
                    self.assertFalse(result['ok'])
                    self.assertEqual(result['http_status'], status)

    def test_native_stream_sources_and_text_are_verified(self):
        stream = sse({'output': {'search_info': {'search_results': [{'url': 'https://example.org', 'title': 'source'}]}}},
                     {'output': {'choices': [{'message': {'content': [{'text': 'answer'}]}}]}})
        with patch.object(ws, '_post_to', return_value=stream):
            result = ws.test_provider(provider('qwen3.5-plus', search_strategy='agent'))
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['text'], 'answer')
        self.assertEqual(result['sources'][0]['host'], 'example.org')

    def test_responses_stream_extracts_official_action_sources(self):
        output = [{'type': 'web_search_call', 'action': {'sources': [{'url': 'https://example.org'}]}},
                  {'type': 'message', 'content': [{'type': 'output_text', 'text': 'answer'}]}]
        stream = sse({'type': 'response.completed', 'response': {'output': output}})
        with patch.object(ws, '_post_to', return_value=stream) as post:
            result = ws.test_provider(provider('qwen3.8-max', api_type='responses'))
            self.assertTrue(post.call_args.args[0].endswith('/compatible-mode/v1/responses'))
        self.assertTrue(result['ok'], result)

    def test_text_only_response_never_reports_search_success(self):
        with patch.object(ws, '_post_to', return_value=sse({'output': {'choices': [{'message': {'content': 'answer https://example.org'}}]}})):
            self.assertFalse(ws.test_provider(provider())['ok'])

    def test_stream_error_is_reported_instead_of_missing_sources(self):
        with patch.object(ws, '_post_to', return_value=sse({'code': 'InvalidParameter', 'message': 'unsupported strategy'})):
            result = ws.test_provider(provider())
        self.assertIn('unsupported strategy', result['message'])

    def test_api_preserves_strategy_and_api_type_when_saving_and_testing(self):
        from fastapi.testclient import TestClient
        from main import app
        p = {**provider('qwen3.5-plus', search_strategy='agent_max', api_type='dashscope'), 'id': 'test-search'}
        with TestClient(app) as client:
            saved = client.put('/api/settings', json={'search_providers': [p], 'search_provider_id': p['id']})
            self.assertEqual(saved.status_code, 200)
            for settings in (saved.json(), client.get('/api/settings').json()):
                self.assertEqual(settings['search_providers'][0]['search_strategy'], 'agent_max')
                self.assertEqual(settings['search_providers'][0]['api_type'], 'dashscope')
            with patch.object(ws, 'test_provider', return_value={'ok': True}) as test:
                self.assertEqual(client.post('/api/settings/search-test', json=p).status_code, 200)
                self.assertEqual(test.call_args.args[0]['search_strategy'], 'agent_max')
                self.assertEqual(test.call_args.args[0]['api_type'], 'dashscope')
            with patch.object(model_probe, 'list_models', return_value={'ok': True}) as listing:
                client.post('/api/settings/model-list', json=p)
                self.assertEqual(listing.call_args.args[2:], ('qwen', 'dashscope'))

    def test_official_hosts_take_precedence_over_stale_names(self):
        for host, kind in [('api.z.ai', 'glm'), ('api.moonshot.ai', 'kimi'),
                           ('api.deepseek.com', 'deepseek'), ('dashscope.aliyuncs.com', 'qwen')]:
            self.assertEqual(caps.infer_protocol({'name': '千问 GLM Kimi', 'base_url': 'https://' + host}), kind)
        self.assertEqual(caps.infer_protocol({'protocol': 'kimi', 'base_url': 'https://api.z.ai'}), 'kimi')
        self.assertEqual(ws.normalize_provider({'protocol': 'kimi'})['base_url'], 'https://api.moonshot.cn/v1')

    def test_glm_domestic_and_international_request_contracts(self):
        for host, engine, keys in [('open.bigmodel.cn', 'search_pro', {'search_query', 'search_engine', 'search_intent', 'count', 'content_size'}),
                                   ('api.z.ai', 'search-prime', {'search_query', 'search_engine'})]:
            p = ws.normalize_provider({'base_url': 'https://' + host})
            endpoint, body = ws._structured_request(p, '今日天气', 120)
            self.assertEqual(endpoint, 'https://' + host + '/api/paas/v4/web_search')
            self.assertEqual(body['search_engine'], engine)
            self.assertEqual(set(body), keys)
        domestic = ws.normalize_provider({'protocol': 'glm'})
        with self.assertRaisesRegex(ValueError, '70'):
            ws._structured_request(domestic, '查' * 71, 120)
        ws._structured_request(ws.normalize_provider({'base_url': 'https://api.z.ai'}), '查' * 100, 120)

    def test_structured_endpoints_accept_full_chat_search_urls_and_strip_query(self):
        cases = [('kimi', 'https://api.moonshot.cn', ['/v1', '/v1/chat/completions', '/v1/responses', '/v1/tools/search', '/anthropic', '/anthropic/v1/messages'], '/v1/tools/search'),
                 ('glm', 'https://open.bigmodel.cn', ['/api', '/api/paas/v4', '/api/paas/v4/chat/completions', '/api/paas/v4/web_search'], '/api/paas/v4/web_search')]
        for kind, root, tails, expected in cases:
            for tail in ['', *tails]:
                with self.subTest(kind=kind, tail=tail):
                    p = ws.normalize_provider({'protocol': kind, 'base_url': root + tail + '/?unused=1#fragment'})
                    self.assertEqual(ws._structured_request(p, 'weather', 120)[0], root + expected)

    def test_kimi_basic_and_pro_use_different_parameters(self):
        for pro in (False, True):
            p = ws.normalize_provider({'protocol': 'kimi', 'base_url': 'https://api.moonshot.ai/v1/tools/' + ('search_pro' if pro else 'search')})
            endpoint, body = ws._structured_request(p, 'weather', 120)
            self.assertTrue(endpoint.endswith('/tools/search_pro' if pro else '/tools/search'))
            self.assertEqual(body, {'text_query': 'weather', 'limit': 6, 'timeout_seconds': 60, **({} if pro else {'include_content': True})})
            self.assertEqual(ws._structured_request(p, 'weather', 0)[1]['timeout_seconds'], 1)

    def test_kimi_pro_chunks_and_glm_content_are_preserved(self):
        for kind, key, row in [('kimi', 'search_results', {'url': 'https://example.org', 'title': 'Kimi', 'chunks': [{'text': '第一段'}, {'text': '第二段'}]}),
                               ('glm', 'search_result', {'link': 'https://example.org', 'title': 'GLM', 'content': '正文', 'publish_date': '2026-10-15'})]:
            p = ws.normalize_provider({'protocol': kind, 'api_key': 'test-only'})
            with patch.object(ws, '_post_to', return_value=io.BytesIO(json.dumps({key: [None, row]}).encode())) as post:
                result = ws.test_provider(p)
                post.assert_called_once()
            self.assertTrue(result['ok'], result)
            self.assertIn('第一段\n第二段' if kind == 'kimi' else '正文', result['text'])
            if kind == 'glm':
                self.assertEqual(result['sources'][0]['date'], '2026-10-15')

    def test_structured_errors_never_masquerade_as_no_sources(self):
        for payload in [{'error': {'message': 'quota exhausted'}}, {'error': 'quota exhausted'},
                        {'code': '429', 'message': 'quota exhausted'}]:
            with patch.object(ws, '_post_to', return_value=io.BytesIO(json.dumps(payload).encode())) as post:
                result = ws.test_provider({'protocol': 'glm', 'api_key': 'test-only'})
                self.assertIn('quota exhausted', result['message'])
                post.assert_called_once()

    def test_structured_auth_and_rate_limit_do_not_retry_or_switch_services(self):
        for kind in ('kimi', 'glm'):
            for status in (401, 403, 429):
                error = urllib.error.HTTPError('mock', status, 'mock', {}, io.BytesIO(b''))
                with patch.object(ws, '_post_to', side_effect=error) as post:
                    result = ws.test_provider({'protocol': kind, 'api_key': 'test-only'})
                    self.assertFalse(result['ok'])
                    self.assertEqual(result['http_status'], status)
                    post.assert_called_once()

    def test_invalid_structured_responses_and_urls_are_rejected(self):
        for payload in [[], {}, {'search_results': {}}, {'search_results': []},
                        {'search_results': [{'url': 'https://[invalid'}, {'url': 'javascript:alert(1)'}, None]}]:
            with patch.object(ws, '_post_to', return_value=io.BytesIO(json.dumps(payload).encode())):
                self.assertFalse(ws.test_provider({'protocol': 'kimi', 'api_key': 'test-only'})['ok'])
        with patch.object(ws, '_post_to') as post:
            self.assertEqual(list(ws.search({'base_url': 'https://[invalid'}, 'test'))[-1]['type'], 'error')
            post.assert_not_called()

    def test_coding_mcp_and_empty_queries_fail_before_request(self):
        for kind in ('kimi', 'glm'):
            for path in ('/api/coding/paas/v4', '/api/mcp/web_search_prime/mcp'):
                with patch.object(ws, '_post_to') as post:
                    events = list(ws.search({'protocol': kind, 'base_url': 'https://api.z.ai' + path}, 'weather'))
                    self.assertIn('Coding Plan', events[-1]['message'])
                    post.assert_not_called()
        with patch.object(ws, '_post_to') as post:
            self.assertIn('不能为空', list(ws.search({'protocol': 'kimi'}, '  '))[-1]['message'])
            post.assert_not_called()

    def test_deepseek_official_search_blocked_even_with_wrong_protocol(self):
        for kind in ('deepseek', 'qwen', 'kimi', 'glm'):
            with patch.object(ws, '_post_to') as post:
                events = list(ws.search({'protocol': kind, 'base_url': 'https://api.deepseek.com/v1'}, 'weather'))
                self.assertIn('不支持', events[-1]['message'])
                post.assert_not_called()

    def test_independent_services_and_deepseek_do_not_list_chat_models_for_search(self):
        for kind, url in [('kimi', 'https://api.moonshot.cn/v1'), ('glm', 'https://api.z.ai'), ('qwen', 'https://api.deepseek.com')]:
            with patch.object(model_probe, '_fetch') as fetch:
                result = model_probe.list_models(url, 'test-only', kind)
                self.assertFalse(result['ok'])
                fetch.assert_not_called()
        with patch.object(model_probe, '_fetch', return_value=({'data': [{'id': 'deepseek-flash'}]}, 'mock')) as fetch:
            self.assertTrue(model_probe.list_models('https://api.deepseek.com', 'test-only')['ok'])
            fetch.assert_called_once()

    def test_relay_responses_remains_available_with_verified_sources(self):
        stream = sse({'type': 'response.completed', 'response': {'output': [
            {'type': 'web_search_call', 'action': {'sources': [{'url': 'https://example.org'}]}},
            {'type': 'message', 'content': [{'type': 'output_text', 'text': 'answer'}]}]}})
        with patch.object(ws, '_post_to', return_value=stream):
            result = ws.test_provider({'protocol': 'deepseek', 'base_url': 'https://relay.example/v1', 'api_key': 'test-only'})
            self.assertTrue(result['ok'], result)


if __name__ == '__main__':
    unittest.main(verbosity=2)

"""联网能力：前后端共用供应商文档快照，未知型号不猜测策略。"""
import json
from pathlib import Path
import re
import urllib.parse

CATALOG = json.loads(Path(__file__).with_suffix('.json').read_text(encoding='utf-8'))


def infer_protocol(provider: dict) -> str:
    selected = str(provider.get('protocol') or '').strip().lower()
    if selected in CATALOG['providers']:
        return selected
    base = str(provider.get('base_url') or '').strip()
    try:
        host = (urllib.parse.urlsplit(base).hostname or '').lower()
    except ValueError:
        host = ''
    for kind, rule in CATALOG['providers'].items():
        if host in rule['hosts'] or any(host.endswith(suffix) for suffix in rule['host_suffixes']):
            return kind
    probe = f"{provider.get('name') or ''} {base}".lower()
    return next((kind for kind, rule in CATALOG['providers'].items()
                 if any(word in probe for word in rule['keywords'])), 'deepseek')


def official_deepseek(base_url: str) -> bool:
    try:
        return (urllib.parse.urlsplit(base_url).hostname or '').lower() in CATALOG['providers']['deepseek']['hosts']
    except ValueError:
        return False


def glm_international(provider: dict) -> bool:
    return (urllib.parse.urlsplit(provider['base_url']).hostname or '').lower() in CATALOG['providers']['glm']['international']['hosts']


def model_rule(model: str) -> dict | None:
    model = (model or '').strip().lower()
    for rule in CATALOG['rules']:
        if not re.fullmatch(rule['pattern'], model):
            continue
        snapshot = re.search(r'(\d{4}-\d{2}-\d{2})$', model)
        minimum = rule.get('min_snapshot', '')
        for name, date in rule.get('min_snapshots', {}).items():
            if f'-{name}' in model:
                minimum = date
        if snapshot and minimum and snapshot[1] < minimum:
            return None
        return rule
    return None


def api_types(model: str) -> list[str]:
    rule = model_rule(model)
    if not rule:
        return []
    # Chat Completions 不返回搜索来源，不能用于本应用的可验证检索。
    types = ['dashscope'] if rule['strategies'] else []
    if rule['responses'] and model.lower() not in rule.get('no_responses', []):
        types.append('responses')
    return types


def resolve_api(provider: dict) -> str:
    types = api_types(provider.get('model', ''))
    requested = provider.get('api_type', 'auto')
    return requested if requested in types else (types[0] if types else 'dashscope')


def strategies(provider: dict) -> list[str]:
    rule = model_rule(provider.get('model', ''))
    return list(rule['strategies']) if rule and resolve_api(provider) != 'responses' else []


def resolve_strategy(provider: dict) -> str:
    choices = strategies(provider)
    selected = provider.get('search_strategy')
    return selected if selected in choices else (choices[0] if choices else '')


def base_root(base_url: str) -> str:
    """可接收原生/兼容 Base URL 或完整调用地址，保留地域和业务空间。"""
    parsed = urllib.parse.urlsplit(base_url.strip())
    path = parsed.path.rstrip('/')
    for marker in ('/compatible-mode', '/api/v1', '/v1'):
        if marker in path:
            path = path.split(marker, 1)[0]
            break
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, '', ''))


def endpoint(provider: dict, api_type: str | None = None) -> str:
    kind = api_type or resolve_api(provider)
    root = base_root(provider['base_url'])
    if kind == 'responses':
        return root + '/compatible-mode/v1/responses'
    if kind == 'chat_completions':
        return root + '/compatible-mode/v1/chat/completions'
    rule = model_rule(provider.get('model', '')) or {}
    service = 'multimodal-generation' if rule.get('multimodal') else 'text-generation'
    return root + f'/api/v1/services/aigc/{service}/generation'


def recommended_models(api_type: str = 'auto') -> list[str]:
    return [model for rule in CATALOG['rules'] for model in rule['models']
            if api_type == 'auto' or api_type in api_types(model)]

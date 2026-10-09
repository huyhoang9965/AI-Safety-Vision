"""Operational measurements only; never persist prompts, audio, API keys or estimates."""
from __future__ import annotations

import logging
import math
from queue import Queue, Empty, Full
from threading import Lock, Thread, Event
from typing import Any

import httpx

from app.config import get_settings
from app.database.database import connection

logger = logging.getLogger(__name__)
_pending: Queue[tuple[str, str]] = Queue(maxsize=64)
_worker_lock = Lock()
_worker: Thread | None = None
_queued: set[str] = set()


def number(value: Any) -> float | None:
    if isinstance(value, bool): return None
    try: result = float(value)
    except (TypeError, ValueError, OverflowError): return None
    return result if math.isfinite(result) and result >= 0 else None


def tokens(value: Any) -> int | None:
    result = number(value)
    return int(result) if result is not None and result.is_integer() else None


def usage_fields(usage: Any) -> dict[str, Any]:
    usage = usage if isinstance(usage, dict) else {}
    incoming = usage.get('prompt_tokens_details') or {}
    outgoing = usage.get('completion_tokens_details') or {}
    return {
        'input_tokens': tokens(usage.get('prompt_tokens')),
        'output_tokens': tokens(usage.get('completion_tokens')),
        'cached_tokens': tokens(incoming.get('cached_tokens')) if isinstance(incoming, dict) else None,
        'reasoning_tokens': tokens(outgoing.get('reasoning_tokens')) if isinstance(outgoing, dict) else None,
        'cost_usd': number(usage.get('cost')),
    }


def record_provider_event(user: dict[str, Any], event: dict[str, Any]) -> str | None:
    memberships = user.get('memberships', [])
    membership = next((m for m in memberships if m.get('is_default')), memberships[0] if memberships else None)
    if not membership or not user.get('id'): return
    fields = ['service','model','provider_request_id','status','latency_ms','first_byte_ms',
              'input_tokens','output_tokens','cached_tokens','reasoning_tokens','cost_usd',
              'input_characters','audio_seconds','error_code','result_count']
    try:
        with connection() as conn:
            row = conn.execute(
                f"""INSERT INTO safety.ai_usage_events(organization_id,user_id,{','.join(fields)})
                    VALUES ({','.join(['%s'] * (len(fields) + 2))})
                    ON CONFLICT (provider_request_id) WHERE provider_request_id IS NOT NULL DO NOTHING RETURNING id""",
                [membership['organization_id'], user['id'], *[event.get(k) for k in fields]],
            ).fetchone()
        if row and event.get('provider_request_id') and event.get('cost_usd') is None:
            enqueue_generation(str(row['id']), event['provider_request_id'])
        return str(row['id']) if row else None
    except Exception:
        # Observability must not turn a successful paid response into a failed chat.
        logger.warning('Could not persist AI usage measurement')


def enqueue_generation(event_id: str, generation_id: str) -> None:
    global _worker
    with _worker_lock:
        if event_id in _queued: return
        try: _pending.put_nowait((event_id, generation_id))
        except Full: return
        _queued.add(event_id)
        if _worker is None or not _worker.is_alive():
            _worker = Thread(target=_reconcile_worker, name='ai-cost-reconciliation', daemon=True)
            _worker.start()


def reconcile_generation(event_id: str, generation_id: str) -> bool:
    settings = get_settings()
    if not settings.openrouter_api_key: return False
    with httpx.Client(timeout=httpx.Timeout(5, connect=2), follow_redirects=False) as client:
        response = client.get('https://openrouter.ai/api/v1/generation', params={'id': generation_id},
                              headers={'Authorization': 'Bearer ' + settings.openrouter_api_key})
        if response.status_code != 200: return False
        data = response.json().get('data', {})
    cost = number(data.get('total_cost'))
    if cost is None: return False
    with connection() as conn:
        conn.execute("""UPDATE safety.ai_usage_events SET cost_usd=%s,
          input_tokens=COALESCE(input_tokens,%s),output_tokens=COALESCE(output_tokens,%s),
          cached_tokens=COALESCE(cached_tokens,%s),reasoning_tokens=COALESCE(reasoning_tokens,%s)
          WHERE id=%s AND provider_request_id=%s AND cost_usd IS NULL""",
          (cost, tokens(data.get('native_tokens_prompt', data.get('tokens_prompt'))),
           tokens(data.get('native_tokens_completion', data.get('tokens_completion'))),
           tokens(data.get('native_tokens_cached')),tokens(data.get('native_tokens_reasoning')),event_id, generation_id))
    return True


def _reconcile_worker() -> None:
    global _worker
    while True:
        try: event_id, generation_id = _pending.get(timeout=60)
        except Empty:
            # Exit under the same lock as enqueue to avoid losing a wake-up.
            with _worker_lock:
                if _pending.empty():
                    _worker = None
                    return
            continue
        try:
            for delay in [0, 1, 3]:
                if delay: Event().wait(delay)
                if reconcile_generation(event_id, generation_id): break
        except Exception:
            logger.warning('AI provider usage is not available yet')
        finally:
            with _worker_lock: _queued.discard(event_id)
            _pending.task_done()


def _percentiles(field: str = 'latency_ms') -> str:
    return ','.join(f"percentile_cont({p}) WITHIN GROUP (ORDER BY {field}) FILTER (WHERE status='completed') AS p{label}_ms"
                    for p, label in [(.5,50),(.95,95),(.99,99)])


def retrieval_event(record: dict[str, Any]) -> dict[str, Any]:
    result = record.get('result') or {}
    count = None
    if isinstance(result.get('items'), list): count = len(result['items'])
    elif isinstance(result.get('incident'), dict): count = int(bool(result['incident']))
    elif record['name'] == 'get_dashboard_summary': count = len(set(result) - {'source_url'})
    return {'service':'rag','model':record['name'], 'status':record['status'],
            'latency_ms':record['duration_ms'], 'result_count':count}


def assistant_metrics(user: dict[str, Any], period: str = '7d') -> dict[str, Any]:
    organizations = [m['organization_id'] for m in user.get('memberships', []) if 'camera.manage' in m.get('permissions', [])]
    days = {'24h': 1, '7d': 7, '30d': 30, 'all': None}[period]
    after = "AND created_at >= now() - %s * interval '1 day'" if days else ''
    params = [organizations, days] if days else [organizations]
    with connection() as conn:
        exists = bool(conn.execute("SELECT to_regclass('safety.ai_usage_events') AS relation").fetchone()['relation'])
        provider, daily, pending = [], [], []
        if exists:
            provider = conn.execute(f"""SELECT service,model,count(*)::int AS requests,
              count(*) FILTER (WHERE status='completed')::int AS completed,
              count(*) FILTER (WHERE status='failed')::int AS failed,
              count(*) FILTER (WHERE error_code=429)::int AS rate_limited,
              {_percentiles()},avg(latency_ms) FILTER (WHERE status='completed') AS average_ms,
              percentile_cont(.5) WITHIN GROUP (ORDER BY first_byte_ms) FILTER (WHERE status='completed') AS first_byte_p50_ms,
              percentile_cont(.99) WITHIN GROUP (ORDER BY first_byte_ms) FILTER (WHERE status='completed') AS first_byte_p99_ms,
              sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,
              sum(cached_tokens) AS cached_tokens,sum(reasoning_tokens) AS reasoning_tokens,
              sum(output_tokens) FILTER (WHERE status='completed') * 1000.0 /
                NULLIF(sum(latency_ms) FILTER (WHERE status='completed' AND output_tokens IS NOT NULL),0) AS tokens_per_second,
              count(*) FILTER (WHERE input_tokens IS NOT NULL AND output_tokens IS NOT NULL)::int AS token_samples,
              sum(cost_usd)::float8 AS cost_usd,count(cost_usd)::int AS priced_requests,
              sum(cost_usd) FILTER (WHERE input_tokens IS NOT NULL AND output_tokens IS NOT NULL) * 1000000.0 /
                NULLIF(sum(input_tokens+output_tokens) FILTER (WHERE cost_usd IS NOT NULL),0) AS usd_per_million_tokens,
              sum(cost_usd) FILTER (WHERE input_characters IS NOT NULL) * 1000.0 /
                NULLIF(sum(input_characters) FILTER (WHERE cost_usd IS NOT NULL),0) AS usd_per_thousand_characters,
              sum(cost_usd) FILTER (WHERE audio_seconds IS NOT NULL) * 60.0 /
                NULLIF(sum(audio_seconds) FILTER (WHERE cost_usd IS NOT NULL),0) AS usd_per_audio_minute,
              sum(input_characters) AS input_characters,sum(audio_seconds) AS audio_seconds,
              avg(latency_ms / 1000 / NULLIF(audio_seconds,0)) FILTER (WHERE status='completed') AS rtf,
              max(created_at) AS last_request_at
              FROM safety.ai_usage_events WHERE organization_id=ANY(%s::uuid[]) {after} AND service IN ('llm','tts')
              GROUP BY service,model ORDER BY service,requests DESC""", params).fetchall()
            daily = conn.execute(f"""SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
              service,count(*)::int AS requests,sum(cost_usd)::float8 AS cost_usd,
              count(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced_requests
              FROM safety.ai_usage_events WHERE organization_id=ANY(%s::uuid[]) {after} AND service IN ('llm','tts')
              GROUP BY day,service ORDER BY day,service""", params).fetchall()
            pending = conn.execute(f"""SELECT id,provider_request_id FROM safety.ai_usage_events
              WHERE organization_id=ANY(%s::uuid[]) {after} AND cost_usd IS NULL AND provider_request_id IS NOT NULL
              AND created_at > now()-interval '1 day' ORDER BY created_at DESC LIMIT 10""", params).fetchall()
        # Historical full-answer latency is distinct from provider-call latency.
        message_after = after.replace('created_at', 'm.created_at')
        answers = dict(conn.execute(f"""SELECT count(*)::int AS requests,
          percentile_cont(.5) WITHIN GROUP (ORDER BY m.latency_ms) AS p50_ms,
          percentile_cont(.95) WITHIN GROUP (ORDER BY m.latency_ms) AS p95_ms,
          percentile_cont(.99) WITHIN GROUP (ORDER BY m.latency_ms) AS p99_ms,
          sum(m.input_tokens) AS input_tokens,sum(m.output_tokens) AS output_tokens,
          count(*) FILTER (WHERE jsonb_array_length(CASE WHEN jsonb_typeof(m.metadata->'tools')='array'
            THEN m.metadata->'tools' ELSE '[]'::jsonb END)>0)::int AS retrieval_answers,
          count(*) FILTER (WHERE jsonb_array_length(CASE WHEN jsonb_typeof(m.metadata->'tools')='array'
            THEN m.metadata->'tools' ELSE '[]'::jsonb END)>0 AND jsonb_array_length(CASE WHEN
            jsonb_typeof(m.metadata->'sources')='array' THEN m.metadata->'sources' ELSE '[]'::jsonb END)>0)::int AS sourced_answers,
          count(f.rating)::int AS feedback_samples,count(*) FILTER (WHERE f.rating=1)::int AS positive_feedback
          FROM safety.chat_messages m JOIN safety.chat_conversations c ON c.id=m.conversation_id
          LEFT JOIN safety.chat_feedback f ON f.message_id=m.id AND f.user_id=c.user_id
          WHERE c.organization_id=ANY(%s::uuid[]) AND m.role='assistant' {message_after}""", params).fetchone())
        retrieval_union = f""" UNION ALL SELECT status,latency_ms,result_count FROM safety.ai_usage_events
          WHERE organization_id=ANY(%s::uuid[]) {after} AND service='rag'""" if exists else ''
        rag = dict(conn.execute(f"""WITH retrieval AS (
          SELECT t.status,t.duration_ms AS latency_ms,
            CASE WHEN jsonb_typeof(t.result_summary->'items')='array' THEN jsonb_array_length(t.result_summary->'items')
                 WHEN jsonb_typeof(t.result_summary->'incident')='object' THEN 1
                 WHEN t.tool_name='get_dashboard_summary' THEN
                   (SELECT count(*) FROM jsonb_object_keys(t.result_summary) k WHERE k!='source_url')
                 ELSE NULL END AS result_count
          FROM safety.chat_tool_calls t JOIN safety.chat_conversations c ON c.id=t.conversation_id
          WHERE c.organization_id=ANY(%s::uuid[]) {after.replace('created_at','t.created_at')}
          AND {'(t.result_summary->>\'_observability_id\' IS NULL)' if exists else 'TRUE'} {retrieval_union})
          SELECT count(*)::int AS requests,count(*) FILTER (WHERE status='completed')::int AS completed,
            count(*) FILTER (WHERE status!='completed')::int AS failed,{_percentiles()},
            count(latency_ms) FILTER (WHERE status='completed')::int AS latency_samples,
            count(result_count) FILTER (WHERE status='completed')::int AS result_samples,
            count(*) FILTER (WHERE status='completed' AND result_count=0)::int AS empty_results,
            avg(result_count) FILTER (WHERE status='completed') AS average_results FROM retrieval""", params + params if exists else params).fetchone())
    for row in pending: enqueue_generation(str(row['id']), row['provider_request_id'])
    settings = get_settings()
    return {'period': period, 'available': exists, 'providers': [dict(r) for r in provider],
            'daily': [dict(r) for r in daily], 'answers': answers, 'rag': rag,
            'configuration': {'llm_model': settings.openrouter_model, 'tts_model': settings.chat_tts_model,
              'llm_configured': bool(settings.openrouter_api_key), 'tts_enabled': settings.chat_tts_enabled,
              'retrieval_mode': 'sql_tools', 'internal_data_shared': settings.chat_llm_share_internal_data}}

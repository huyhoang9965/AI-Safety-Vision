from contextlib import contextmanager, nullcontext
from dataclasses import replace
import json
import os
from unittest.mock import Mock
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import current_user
from app.api import models
from app.config import get_settings
from app.database.database import connection
from app.services import ai_observability as metrics, chat_llm


@pytest.mark.parametrize('value,expected', [(0,0),(None,None),(-1,None),(True,None),('NaN',None),('Infinity',None),('0.00001',.00001)])
def test_missing_or_invalid_cost_is_not_reported_as_free(value, expected):
    assert metrics.number(value) == expected


def test_usage_fields_preserve_missing_tokens_and_include_cache_reasoning():
    assert metrics.usage_fields(None)['cost_usd'] is None
    assert metrics.usage_fields({})['input_tokens'] is None
    assert metrics.tokens(1.5) is None
    usage = metrics.usage_fields({'prompt_tokens':20,'completion_tokens':10,'cost':0,
        'prompt_tokens_details':{'cached_tokens':5},'completion_tokens_details':{'reasoning_tokens':2}})
    assert usage == dict(input_tokens=20,output_tokens=10,cached_tokens=5,reasoning_tokens=2,cost_usd=0)


def test_llm_observer_reports_real_usage_and_provider_errors_without_content(monkeypatch):
    original = httpx.Client
    replies = [httpx.Response(200, json={'id':'gen-synthetic','model':'synthetic-model',
        'usage':{'prompt_tokens':30,'completion_tokens':10,'cost':.0002},
        'choices':[{'message':{'content':'PRIVATE CONTENT'}}]}), httpx.Response(429)]
    transport = httpx.MockTransport(lambda request: replies.pop(0))
    seen = []
    with original(transport=transport,base_url='https://openrouter.ai/api/v1/') as client:
        chat_llm._completion(client, {'model':'synthetic-model'}, seen.append)
        with pytest.raises(chat_llm.ChatProviderError):
            chat_llm._completion(client, {'model':'synthetic-model'}, seen.append)
    assert seen[0]['input_tokens'] == 30 and seen[0]['cost_usd'] == .0002
    assert seen[1]['status'] == 'failed' and seen[1]['error_code'] == 429
    assert seen[1]['cost_usd'] is None
    assert 'PRIVATE' not in json.dumps(seen)


def test_record_is_scoped_sanitized_and_schedules_only_unknown_generation_cost(monkeypatch):
    conn = Mock()
    event_id, org, user_id = uuid4(), uuid4(), uuid4()
    conn.execute.return_value.fetchone.return_value = {'id':event_id}
    monkeypatch.setattr(metrics,'connection',lambda: nullcontext(conn))
    enqueue = Mock(); monkeypatch.setattr(metrics,'enqueue_generation',enqueue)
    metrics.record_provider_event({'id':user_id,'memberships':[{'organization_id':org}]},
      {'service':'tts','model':'test-model','status':'completed','latency_ms':1,
       'provider_request_id':'gen-test','prompt':'PRIVATE SECRET','cost_usd':None})
    sql,args = conn.execute.call_args.args
    assert args[:2] == [org,user_id]
    assert 'PRIVATE' not in repr(args)
    assert 'ON CONFLICT' in sql
    enqueue.assert_called_once_with(str(event_id),'gen-test')
    conn.execute.side_effect = RuntimeError('Database unavailable')
    metrics.record_provider_event({'id':user_id,'memberships':[{'organization_id':org}]}, {})


def test_generation_reconciliation_uses_bill_not_inferred_token_pricing(monkeypatch):
    settings = replace(get_settings(),openrouter_api_key='fake-test-key')
    monkeypatch.setattr(metrics,'get_settings',lambda: settings)
    original = httpx.Client
    def handler(request):
        assert request.method == 'GET' and request.url.params['id'] == 'gen-test'
        assert request.headers['authorization'] == 'Bearer fake-test-key'
        return httpx.Response(200,json={'data':{'total_cost':.0012,'native_tokens_prompt':15,'native_tokens_completion':40}})
    monkeypatch.setattr(metrics.httpx,'Client',lambda **kwargs: original(transport=httpx.MockTransport(handler),**kwargs))
    conn = Mock(); monkeypatch.setattr(metrics,'connection',lambda: nullcontext(conn))
    assert metrics.reconcile_generation('event-test','gen-test') is True
    sql,args = conn.execute.call_args.args
    assert args == (.0012,15,40,None,None,'event-test','gen-test')
    assert 'cost_usd IS NULL' in sql


def test_metrics_endpoint_requires_permission_and_valid_period(monkeypatch):
    app = FastAPI(); app.include_router(models.router)
    service = Mock(return_value={'period':'30d'})
    monkeypatch.setattr(models,'assistant_metrics',service)
    with TestClient(app) as client:
        assert client.get('/api/models/assistant-metrics').status_code == 401
        app.dependency_overrides[current_user] = lambda: {'memberships':[{'permissions':['chat.use']}]}
        assert client.get('/api/models/assistant-metrics').status_code == 403
        app.dependency_overrides[current_user] = lambda: {'memberships':[{'permissions':['camera.manage']}]}
        assert client.get('/api/models/assistant-metrics?period=bad').status_code == 422
        assert client.get('/api/models/assistant-metrics?period=30d').json()['period'] == '30d'
    assert service.call_count == 1


@pytest.mark.skipif(os.getenv('TEST_AI_METRICS_SQL') != '1',reason='Opt-in PostgreSQL session-local measurements')
def test_real_percentiles_cost_coverage_and_rag_are_scoped_in_postgresql(monkeypatch):
    org, foreign, conversation, other_conversation = [uuid4() for _ in range(4)]
    with connection() as conn:
        for source, target in [('ai_usage_events','test_usage'),('chat_conversations','test_conversations'),
          ('chat_messages','test_messages'),('chat_tool_calls','test_tools'),('chat_feedback','test_feedback')]:
            conn.execute(f'CREATE TEMP TABLE {target} AS SELECT * FROM safety.{source} WITH NO DATA')
        conn.execute("""INSERT INTO test_usage(id,organization_id,service,model,status,latency_ms,input_tokens,output_tokens,cost_usd,created_at)
          SELECT gen_random_uuid(),%s,'llm','test-model','completed',n*100,100,10,.001,now() FROM generate_series(1,100) n""",(org,))
        conn.execute("""INSERT INTO test_usage(id,organization_id,service,model,status,latency_ms,error_code,created_at)
          SELECT gen_random_uuid(),%s,'llm','test-model','failed',999999,429,now() FROM generate_series(1,8)""",(org,))
        conn.execute("""INSERT INTO test_usage(id,organization_id,service,model,status,latency_ms,cost_usd,audio_seconds,created_at)
          VALUES(gen_random_uuid(),%s,'tts','test-tts','completed',1000,NULL,2,now()),
                (gen_random_uuid(),%s,'llm','test-model','completed',999999,9,NULL,now())""",(org,foreign))
        conn.execute('INSERT INTO test_conversations(id,organization_id) VALUES(%s,%s),(%s,%s)',(conversation,org,other_conversation,foreign))
        conn.execute("""INSERT INTO test_tools(conversation_id,tool_name,status,duration_ms,result_summary,created_at)
          VALUES(%s,'list_cameras','completed',20,'{"items":[]}',now()),
          (%s,'list_cameras','completed',40,'{"items":[{},{}]}',now()),
          (%s,'list_cameras','failed',99999,'{"error":"unavailable"}',now()),
          (%s,'list_cameras','completed',999999,'{"items":[]}',now())""",(conversation,conversation,conversation,other_conversation))
        retrieval_id = uuid4()
        conn.execute("""INSERT INTO test_usage(id,organization_id,service,model,status,latency_ms,result_count,created_at)
          VALUES(%s,%s,'rag','list_cameras','completed',10,3,now()),
                (gen_random_uuid(),%s,'rag','list_cameras','failed',99999,NULL,now())""",(retrieval_id,org,org))
        conn.execute("""INSERT INTO test_tools(conversation_id,tool_name,status,duration_ms,result_summary,created_at)
          VALUES(%s,'list_cameras','completed',10,%s::jsonb,now())""",
          (conversation,json.dumps({'items':[{}, {}, {}],'_observability_id':str(retrieval_id)})))
        names={'safety.ai_usage_events':'pg_temp.test_usage','safety.chat_conversations':'pg_temp.test_conversations',
               'safety.chat_messages':'pg_temp.test_messages','safety.chat_tool_calls':'pg_temp.test_tools','safety.chat_feedback':'pg_temp.test_feedback'}
        class Isolated:
            def execute(self,sql,params=None):
                for source,target in names.items(): sql = sql.replace(source,target)
                return conn.execute(sql,params)
        @contextmanager
        def temporary_connection(): yield Isolated()
        monkeypatch.setattr(metrics,'connection',temporary_connection)
        monkeypatch.setattr(metrics,'enqueue_generation',Mock())
        payload=metrics.assistant_metrics({'memberships':[{'organization_id':org,'permissions':['camera.manage']},
          {'organization_id':foreign,'permissions':['chat.use']}]},'all')
        llm = next(row for row in payload['providers'] if row['service']=='llm')
        assert llm['requests']==108 and llm['failed']==8 and llm['rate_limited']==8
        assert llm['p50_ms']==5050 and llm['p95_ms']==pytest.approx(9505) and llm['p99_ms']==pytest.approx(9901)
        assert llm['cost_usd']==pytest.approx(.1) and llm['priced_requests']==100
        assert float(llm['usd_per_million_tokens'])==pytest.approx(.1/11000*1000000)
        tts=next(row for row in payload['providers'] if row['service']=='tts')
        assert tts['cost_usd'] is None and tts['rtf']==.5
        assert payload['rag']['requests']==5 and payload['rag']['p50_ms']==20
        assert payload['rag']['failed']==2
        assert payload['rag']['result_samples']==3 and payload['rag']['empty_results']==1
        conn.rollback()  # All sample rows existed only in this session's temp tables.

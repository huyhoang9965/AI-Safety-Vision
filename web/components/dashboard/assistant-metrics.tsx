'use client';

import { useEffect, useRef, useState } from 'react';
import { Activity, AudioLines, Coins, Database, Download, RefreshCw, Sparkles } from 'lucide-react';
import { authenticatedFetch } from '@/lib/auth';
import styles from './assistant-metrics.module.css';

type Provider = { service: 'llm'|'tts'; model: string; requests: number; completed: number; failed: number;
  rate_limited: number; p50_ms: number|null; p95_ms: number|null; p99_ms: number|null; average_ms: number|null;
  first_byte_p50_ms: number|null; first_byte_p99_ms: number|null; input_tokens: number|null; output_tokens: number|null;
  cached_tokens: number|null; reasoning_tokens: number|null; token_samples: number; cost_usd: number|null;
  priced_requests: number; input_characters: number|null; audio_seconds: number|null; rtf: number|null;
  tokens_per_second: number|null; usd_per_million_tokens: number|null;
  usd_per_thousand_characters: number|null; usd_per_audio_minute: number|null };
type Data = { period: string; available: boolean; providers: Provider[];
  daily: { day: string; service: string; requests: number; cost_usd: number|null; unpriced_requests: number }[];
  answers: { requests: number; p50_ms: number|null; p95_ms: number|null; p99_ms: number|null;
    input_tokens: number|null; output_tokens: number|null; retrieval_answers: number; sourced_answers: number;
    feedback_samples: number; positive_feedback: number };
  rag: { requests: number; completed: number; failed: number; p50_ms: number|null; p95_ms: number|null;
    p99_ms: number|null; latency_samples: number; result_samples: number; empty_results: number; average_results: number|null };
  configuration: { llm_model: string; tts_model: string; llm_configured: boolean; tts_enabled: boolean;
    retrieval_mode: string; internal_data_shared: boolean } };
const base = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');
const count = (n: number|null) => n == null ? '—' : new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(n);
const usd = (n: number|null) => n == null ? 'Chưa có số liệu' : n > 0 && n < .000001 ? '$' + n.toExponential(2)
  : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(n);
const ms = (n: number|null) => n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(2) + ' s' : Math.round(n) + ' ms';
const rate = (n: number, total: number) => total ? (n / total * 100).toFixed(1) + '%' : '—';
const sumKnown = (rows: Provider[], key: 'cost_usd'|'input_tokens'|'output_tokens'|'audio_seconds') => {
  const values = rows.map(row => row[key]).filter((n): n is number => n !== null);
  return values.length ? values.reduce((a,b) => a+b, 0) : null;
};

export default function AssistantMetrics() {
  const [period, setPeriod] = useState('7d');
  const [data, setData] = useState<Data|null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const version = useRef(0);
  useEffect(() => {
    const controller = new AbortController(), requestVersion = ++version.current;
    setBusy(true); setError('');
    void authenticatedFetch(base + '/api/models/assistant-metrics?period=' + period, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('Chưa tải được thống kê. Bạn có thể thử lại.'); return response.json(); })
      .then(payload => { if (!controller.signal.aborted && requestVersion === version.current) setData(payload); })
      .catch(() => { if (!controller.signal.aborted) setError('Chưa tải được thống kê LLM, RAG và TTS.'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [period, revision]);

  const exportCsv = () => {
    if (!data) return;
    const rows = [['Dịch vụ','Model','Lượt','Lỗi','p50_ms','p95_ms','p99_ms','Input token','Output token','Cached token','Reasoning token','Chi phí USD','Lượt có chi phí'],
      ...data.providers.map(row => [row.service,row.model,row.requests,row.failed,row.p50_ms,row.p95_ms,row.p99_ms,row.input_tokens,row.output_tokens,row.cached_tokens,row.reasoning_tokens,row.cost_usd,row.priced_requests]),
      ['RAG','SQL tools',data.rag.requests,data.rag.failed,data.rag.p50_ms,data.rag.p95_ms,data.rag.p99_ms,null,null,null,null,null,null]];
    const csv = '\ufeff' + rows.map(row => row.map(value => '"' + String(value ?? '').replaceAll('"','""') + '"').join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `ai-usage-${data.period}.csv`; link.click(); URL.revokeObjectURL(url);
  };
  const rows = data?.providers || [], requests = rows.reduce((s,r) => s+r.requests,0), priced = rows.reduce((s,r) => s+r.priced_requests,0);
  const tts = rows.filter(row => row.service === 'tts'), llm = rows.filter(row => row.service === 'llm');
  const audio = sumKnown(tts, 'audio_seconds');
  const days = Array.from(new Set(data?.daily.map(day => day.day) || []));
  const maxCost = Math.max(...days.map(day => data!.daily.filter(row => row.day === day).reduce((s,r) => s+(r.cost_usd || 0),0)), .000001);
  return <section className={styles.section} aria-label="Thống kê LLM RAG TTS" aria-busy={busy}>
    <header className={styles.header}><div><span><Sparkles size={17}/> TRỢ LÝ AI</span><h2>LLM, RAG & giọng nói</h2><p>Chi phí thực ghi nhận và hiệu năng theo từng thành phần.</p></div>
      <div className={styles.actions}><select aria-label="Khoảng thời gian thống kê AI" value={period} onChange={event => setPeriod(event.target.value)}>
        <option value="24h">24 giờ qua</option><option value="7d">7 ngày qua</option><option value="30d">30 ngày qua</option><option value="all">Toàn bộ lịch sử</option>
      </select><button disabled={busy} onClick={() => setRevision(value => value+1)}><RefreshCw size={15}/> Cập nhật</button>
      <button disabled={!data || busy} onClick={exportCsv}><Download size={15}/> CSV</button></div></header>
    {error && <p className={styles.error} role="alert">{error} <button onClick={() => setRevision(value => value+1)}>Thử lại</button></p>}
    {!data ? <p className={styles.empty}>{busy ? 'Đang đọc số liệu sử dụng…' : 'Chưa có thống kê.'}</p> : <>
      {!data.available && <p className={styles.error}>Dữ liệu chi phí đang chờ khởi tạo. Lịch sử câu trả lời vẫn được giữ.</p>}
      <p className={styles.configuration}><span>LLM: {data.configuration.llm_configured ? data.configuration.llm_model : 'Trợ lý cơ bản'}</span><span>TTS: {data.configuration.llm_configured && data.configuration.tts_enabled ? data.configuration.tts_model : 'Chưa bật'}</span><span>RAG: SQL qua công cụ</span></p>
      <p className={styles.note}>Phạm vi đang hiển thị: {({ '24h':'24 giờ qua', '7d':'7 ngày qua', '30d':'30 ngày qua', all:'Toàn bộ lịch sử' } as Record<string,string>)[data.period]}.</p>
      <div className={styles.cards}>
        <article><Coins/><div><small>Chi phí đã ghi nhận</small><strong>{usd(sumKnown(rows,'cost_usd'))}</strong><p>{priced}/{requests} lượt có số liệu chi phí</p></div></article>
        <article><Activity/><div><small>Token LLM đầu vào / đầu ra</small><strong>{count(sumKnown(llm,'input_tokens'))} / {count(sumKnown(llm,'output_tokens'))}</strong><p>{count(llm.reduce((s,r) => s+r.token_samples,0))} lượt có đủ token</p></div></article>
        <article><Database/><div><small>Lượt tra cứu RAG</small><strong>{count(data.rag.requests)}</strong><p>{data.rag.failed} lượt lỗi · SQL theo quyền truy cập</p></div></article>
        <article><AudioLines/><div><small>Âm thanh TTS đã tạo</small><strong>{audio === null ? '—' : count(audio/60) + ' phút'}</strong><p>{tts.reduce((s,r) => s+r.requests,0)} lượt gọi giọng AI</p></div></article>
      </div>
      <p className={styles.note}>Chi phí lấy từ OpenRouter bằng USD. Lượt chưa có chi phí không được tính là miễn phí. Chi phí hiệu dụng tính trên mẫu có đủ chi phí và đơn vị sử dụng, không phải bảng giá niêm yết. Cache âm thanh trên trình duyệt và giọng đọc của thiết bị không gọi TTS backend.</p>
      <div className={styles.tableWrap}><table><caption>Độ trễ của các lượt hoàn tất · p50 / p95 / p99</caption><thead><tr><th>Thành phần / Model</th><th>Lượt / lỗi</th><th>p50</th><th>p95</th><th>p99</th><th>Chi phí</th></tr></thead><tbody>
        {rows.map(row => <tr key={row.service+row.model}><td><b>{row.service.toUpperCase()}</b><small>{row.model}</small><small>{row.completed} mẫu hoàn tất · {row.rate_limited} lượt giới hạn 429</small></td><td>{row.requests} / {row.failed}<small>{rate(row.failed,row.requests)} lỗi</small></td><td>{ms(row.p50_ms)}</td><td>{ms(row.p95_ms)}</td><td>{ms(row.p99_ms)}</td><td>{usd(row.cost_usd)}<small>{row.priced_requests}/{row.requests} lượt đã đối soát</small></td></tr>)}
        <tr><td><b>RAG</b><small>Tra cứu SQL qua công cụ</small><small>{data.rag.latency_samples} mẫu độ trễ</small></td><td>{data.rag.requests} / {data.rag.failed}<small>{rate(data.rag.failed,data.rag.requests)} lỗi</small></td><td>{ms(data.rag.p50_ms)}</td><td>{ms(data.rag.p95_ms)}</td><td>{ms(data.rag.p99_ms)}</td><td>Không có phí token riêng<small>Token gọi công cụ nằm trong LLM</small></td></tr>
      </tbody></table></div>
      <p className={styles.note}>p50 là trung vị; p95/p99 là ngưỡng mà 95%/99% lượt hoàn tất không vượt quá. Ít mẫu có thể làm p99 dao động. Độ trễ LLM ở bảng là từng lần gọi API, chưa đo TTFT do trả lời không streaming.</p>
      <div className={styles.details}>
        <article><h3>LLM · token & phản hồi</h3>{llm.length ? llm.map(row => <div key={row.model}><p className={styles.model}>{row.model}</p><dl>
          <dt>Input / Output</dt><dd>{count(row.input_tokens)} / {count(row.output_tokens)}</dd><dt>Token cache / Reasoning</dt><dd>{count(row.cached_tokens)} / {count(row.reasoning_tokens)}</dd>
          <dt>Token ra/giây · cả lượt API</dt><dd>{count(row.tokens_per_second)}</dd><dt>Chi phí hiệu dụng / 1M token</dt><dd>{usd(row.usd_per_million_tokens)}</dd></dl></div>) : <p className={styles.empty}>Lượt API mới sẽ được thống kê từ khi bật ghi nhận.</p>}
          <dl><dt>Câu trả lời đã lưu</dt><dd>{data.answers.requests}</dd><dt>p50 / p95 / p99 toàn câu trả lời</dt><dd>{ms(data.answers.p50_ms)} / {ms(data.answers.p95_ms)} / {ms(data.answers.p99_ms)}</dd>
          <dt>Token lịch sử đầu vào / đầu ra</dt><dd>{count(data.answers.input_tokens)} / {count(data.answers.output_tokens)}</dd><dt>Phản hồi tích cực</dt><dd>{rate(data.answers.positive_feedback,data.answers.feedback_samples)} · {data.answers.feedback_samples} đánh giá</dd></dl>
          <p className={styles.note}>Độ trễ câu trả lời đo khâu tạo nội dung ở backend, chưa gồm đường truyền đến trình duyệt. Lịch sử câu trả lời và lượt API là hai phép đo riêng; không cộng hai nguồn token này. Token cache và reasoning đã nằm trong input/output.</p></article>
        <article><h3>RAG · chất lượng tra cứu</h3><dl><dt>Kết quả trung bình / lượt</dt><dd>{count(data.rag.average_results)}</dd>
          <dt>Tỷ lệ tra cứu rỗng</dt><dd>{rate(data.rag.empty_results,data.rag.result_samples)}</dd><dt>Câu trả lời tra cứu có nguồn</dt><dd>{rate(data.answers.sourced_answers,data.answers.retrieval_answers)} · {data.answers.retrieval_answers} câu</dd></dl>
          <p className={styles.note}>Tỷ lệ có nguồn đo khả năng dẫn nguồn, không phải độ chính xác câu trả lời.</p>
          <div className={styles.pending}><b>Recall@k · MRR · nDCG · Faithfulness</b><span>Chưa có bộ truy vấn và kết quả đúng được gán nhãn để đánh giá.</span></div>
          <p className={styles.note}>Hiện dùng dữ liệu có cấu trúc và công cụ SQL, chưa có embedding/vector search hoặc reranker.</p></article>
        <article><h3>TTS · tốc độ tạo giọng</h3>{tts.length ? tts.map(row => <div key={row.model}><p className={styles.model}>{row.model}</p><dl>
          <dt>Byte âm thanh đầu tiên p50 / p99</dt><dd>{ms(row.first_byte_p50_ms)} / {ms(row.first_byte_p99_ms)}</dd>
          <dt>RTF · thời gian tạo / độ dài audio</dt><dd>{row.rtf === null ? '—' : row.rtf.toFixed(2) + '×'}</dd>
          <dt>Ký tự đầu vào</dt><dd>{count(row.input_characters)}</dd><dt>Token đầu vào / đầu ra</dt><dd>{count(row.input_tokens)} / {count(row.output_tokens)}</dd>
          <dt>Chi phí hiệu dụng / 1.000 ký tự</dt><dd>{usd(row.usd_per_thousand_characters)}</dd><dt>Chi phí hiệu dụng / phút audio</dt><dd>{usd(row.usd_per_audio_minute)}</dd></dl></div>) : <p className={styles.empty}>Chưa có lượt tạo giọng AI trong khoảng thời gian này.</p>}
          <p className={styles.note}>Byte đầu tiên được đo từ nhà cung cấp; ứng dụng phát sau khi nhận đủ audio. RTF dưới 1× nghĩa là tạo nhanh hơn thời lượng phát. Chưa có đánh giá MOS từ người nghe.</p></article>
      </div>
      {days.length > 0 && <div className={styles.chart}><h3>Chi phí đã ghi nhận theo ngày (UTC)</h3>{days.map(day => {
        const dayRows = data.daily.filter(row => row.day === day), total = dayRows.reduce((s,r) => s+(r.cost_usd || 0),0), known = dayRows.some(row => row.cost_usd !== null);
        return <div className={styles.chartRow} key={day}><span>{day}</span><div className={styles.bar}>{dayRows.map(row => <i key={row.service} data-service={row.service} title={row.service.toUpperCase()+': '+usd(row.cost_usd)} style={{ width: ((row.cost_usd || 0)/maxCost*100)+'%' }}/>)}</div><strong>{usd(known ? total : null)}</strong></div>;
      })}<p className={styles.legend}><i/> LLM <i/> TTS · Phần chưa đối soát chưa nằm trong biểu đồ.</p></div>}
    </>}
  </section>;
}

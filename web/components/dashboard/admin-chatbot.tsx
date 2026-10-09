'use client';

import { authenticatedFetch } from '@/lib/auth';

import {
  Archive, Check, ChevronLeft, Copy, ExternalLink, History,
  LoaderCircle, Maximize2, MessageSquareText, Minimize2, Mic, Plus, Send, Square, Volume2,
  ShieldCheck, SlidersHorizontal, Sparkles, ThumbsDown, ThumbsUp, X,
} from 'lucide-react';
import Link from 'next/link';
import { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { ApiUser } from '@/lib/auth';
import { readAuthSession } from '@/lib/auth';
import styles from './admin-chatbot.module.css';
import { useChatVoice, type VoiceGender } from '@/lib/use-chat-voice';

const API_BASE=(process.env.NEXT_PUBLIC_API_URL||'http://localhost:8000').replace(/\/$/,'');
type ChatStatus={available:boolean;provider:string;model:string;mode:'openai'|'openrouter'|'local';suggested_prompts:string[];llm_configured?:boolean;speech_available?:boolean;speech_provider?:string;speech_model?:string|null};
type Conversation={id:string;title:string;status:string;message_count:number;last_message_at:string;created_at:string;preview:string|null};
type Source={label:string;url:string};
type Message={id:string;role:'user'|'assistant'|'system'|'tool';content:string;model_name:string|null;latency_ms:number|null;metadata:{sources?:Source[];tools?:string[];mode?:string;read_only?:boolean};created_at:string;feedback:number|null};
type ConversationDetail={id:string;title:string;status:string;created_at:string;messages:Message[]};
type SendResponse={conversation_id:string;user_message:Message;assistant_message:Message;tool_calls:Array<{name:string;label:string;status:string;duration_ms:number}>;mode:'openai'|'openrouter'|'local'};

function headers():HeadersInit{const stored=readAuthSession();return{'Content-Type':'application/json',...(stored?{Authorization:'Bearer '+stored.session.access_token}:{})};}
function apiError(payload:unknown):string{return payload&&typeof payload==='object'&&'detail'in payload?String((payload as {detail:unknown}).detail):'Không thể xử lý yêu cầu.';}
async function requestSpeech(messageId: string | null, voice: VoiceGender, signal: AbortSignal): Promise<Blob> {
  const response = await authenticatedFetch(API_BASE + '/api/chat/speech', {
    method: 'POST', headers: headers(), signal,
    body: JSON.stringify({ message_id: messageId, voice }),
  });
  if (!response.ok) throw new Error(apiError(await response.json().catch(() => null)));
  if (!response.headers.get('content-type')?.startsWith('audio/')) throw new Error('Dịch vụ chưa trả về âm thanh hợp lệ.');
  return response.blob();
}
function relative(value:string):string{const sec=Math.max(0,(Date.now()-new Date(value).getTime())/1000);if(sec<60)return'Vừa xong';if(sec<3600)return Math.floor(sec/60)+' phút';if(sec<86400)return Math.floor(sec/3600)+' giờ';return Math.floor(sec/86400)+' ngày';}

function AssistantMascot({ compact = false }: { compact?: boolean }) {
  return (
    <svg className={styles.mascotArtwork} viewBox={compact ? "14 0 68 60" : "0 0 96 104"} fill="none" aria-hidden="true" focusable="false">
      {!compact && <ellipse cx="48" cy="96" rx="23" ry="4" fill="#203D56" fillOpacity=".1" />}
      <g className={styles.mascotFloat}>
        <path d="M48 18V10" stroke="#8198AA" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="48" cy="7" r="4" fill="#4D93E8" />
        <rect x="17" y="32" width="9" height="16" rx="4.5" fill="#A9C3D1" />
        <rect x="70" y="32" width="9" height="16" rx="4.5" fill="#A9C3D1" />
        <rect x="24" y="17" width="48" height="39" rx="16" fill="#F1F6F8" stroke="#9CB3C3" strokeWidth="1.5" />
        <rect x="29" y="24" width="38" height="25" rx="10" fill="#203D56" />
        <g className={styles.mascotEyes}>
          <rect x="37" y="31" width="5" height="7" rx="2.5" fill="#B8E0FF" />
          <rect x="54" y="31" width="5" height="7" rx="2.5" fill="#B8E0FF" />
        </g>
        <path d="M44 42Q48 45 52 42" stroke="#B8E0FF" strokeWidth="1.7" strokeLinecap="round" />
        {!compact && (
          <>
            <path d="M32 61L27 71" stroke="#A9C3D1" strokeWidth="8" strokeLinecap="round" />
            <circle cx="26" cy="73" r="5" fill="#E3EEF2" stroke="#9CB3C3" strokeWidth="1.2" />
            <g className={styles.mascotWave}>
              <path d="M63 62L74 51" stroke="#A9C3D1" strokeWidth="8" strokeLinecap="round" />
              <rect x="69" y="40" width="11" height="15" rx="5.5" fill="#E3EEF2" stroke="#9CB3C3" strokeWidth="1.2" />
              <path d="M73 43V47M76 43V47" stroke="#9CB3C3" strokeWidth="1.2" strokeLinecap="round" />
            </g>
            <rect x="34" y="56" width="28" height="29" rx="10" fill="#DCEBF0" stroke="#9CB3C3" strokeWidth="1.5" />
            <path d="M48 62L55 65V70C55 75 48 78 48 78C48 78 41 75 41 70V65L48 62Z" fill="#FFF" />
            <path d="M45 69L47 71L51 67" stroke="#2A72CD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="38" y="81" width="8" height="10" rx="4" fill="#587A92" />
            <rect x="50" y="81" width="8" height="10" rx="4" fill="#587A92" />
          </>
        )}
      </g>
    </svg>
  );
}


export default function AdminChatbot({user}:{user:ApiUser}){
  const [open,setOpen]=useState(false);const [expanded,setExpanded]=useState(false);const [historyOpen,setHistoryOpen]=useState(false);
  const [status,setStatus]=useState<ChatStatus|null>(null);const [conversations,setConversations]=useState<Conversation[]>([]);
  const [conversationId,setConversationId]=useState<string|null>(null);const [messages,setMessages]=useState<Message[]>([]);
  const [input,setInput]=useState('');const [loading,setLoading]=useState(false);const [initializing,setInitializing]=useState(false);
  const [error,setError]=useState('');const [copied,setCopied]=useState('');const bottomRef=useRef<HTMLDivElement>(null);

  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);
  const sendInFlightRef = useRef(false);
  const voice = useChatVoice({
    enabled: open, canListen: !loading && !initializing && !historyOpen,
    cloudAvailable: Boolean(status?.speech_available), onTranscript: setInput,
    onAutoSend: text => { void sendMessage(text); }, getAudio: requestSpeech,
  });
  function stopVoice() { voice.stopListening(); voice.stopSpeaking(); }

  const loadConversations=useCallback(async()=>{try{const response=await authenticatedFetch(API_BASE+'/api/chat/conversations',{headers:headers()});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));setConversations(payload as Conversation[]);}catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể tải lịch sử.');}},[]);
  const initialize=useCallback(async()=>{setInitializing(true);setError('');try{const response=await authenticatedFetch(API_BASE+'/api/chat/status',{headers:headers()});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));setStatus(payload as ChatStatus);await loadConversations();}catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể kết nối chatbot.');}finally{setInitializing(false);}},[loadConversations]);
  useEffect(()=>{if(open&&!status)void initialize();},[open,status,initialize]);
  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:'smooth'});},[messages,loading]);

  async function selectConversation(id:string){stopVoice();setInitializing(true);setError('');try{const response=await authenticatedFetch(API_BASE+'/api/chat/conversations/'+id,{headers:headers()});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));const detail=payload as ConversationDetail;setConversationId(detail.id);setMessages(detail.messages);setHistoryOpen(false);}catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể mở hội thoại.');}finally{setInitializing(false);}}
  function newConversation(){stopVoice();setConversationId(null);setMessages([]);setInput('');setError('');setHistoryOpen(false);}
  async function archiveConversation(){if(!conversationId)return;try{const response=await authenticatedFetch(API_BASE+'/api/chat/conversations/'+conversationId+'/archive',{method:'POST',headers:headers()});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));newConversation();await loadConversations();}catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể lưu trữ hội thoại.');}}

  async function sendMessage(text=input){const content=text.trim();if(!content||loading||sendInFlightRef.current)return;sendInFlightRef.current=true;stopVoice();voice.clearError();setInput('');setError('');setLoading(true);const tempId='temp-'+Date.now();const optimistic:Message={id:tempId,role:'user',content,model_name:null,latency_ms:null,metadata:{},created_at:new Date().toISOString(),feedback:null};setMessages(current=>[...current,optimistic]);try{const response=await authenticatedFetch(API_BASE+'/api/chat/messages',{method:'POST',headers:headers(),body:JSON.stringify({message:content,conversation_id:conversationId})});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));const result=payload as SendResponse;setConversationId(result.conversation_id);setMessages(current=>[...current.filter(message=>message.id!==tempId),result.user_message,result.assistant_message]);voice.readReply(result.assistant_message.id,result.assistant_message.content);await loadConversations();}catch(requestError){setMessages(current=>current.filter(message=>message.id!==tempId));setInput(content);setError(requestError instanceof Error?requestError.message:'Không thể gửi tin nhắn.');}finally{sendInFlightRef.current=false;setLoading(false);}}
  function keyDown(event:KeyboardEvent<HTMLTextAreaElement>){if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void sendMessage();}}
  async function feedback(messageId:string,rating:-1|1){try{const response=await authenticatedFetch(API_BASE+'/api/chat/messages/'+messageId+'/feedback',{method:'POST',headers:headers(),body:JSON.stringify({rating})});if(!response.ok)throw new Error();setMessages(current=>current.map(message=>message.id===messageId?{...message,feedback:rating}:message));}catch{setError('Không thể ghi nhận phản hồi.');}}
  async function copyMessage(message:Message){await navigator.clipboard.writeText(message.content);setCopied(message.id);window.setTimeout(()=>setCopied(''),1500);}

  if (!open) return (
    <button
      type="button"
      className={styles.launcher}
      onClick={() => setOpen(true)}
      aria-label="Mở trợ lý AI"
      aria-haspopup="dialog"
      aria-expanded={false}
    >
      <span className={styles.launcherCopy}>
        <strong>Trợ lý AI</strong>
        <small>Hỗ trợ vận hành</small>
      </span>
      <AssistantMascot />
    </button>
  );
  return <section className={`${styles.chat} ${expanded?styles.expanded:''}`} aria-label="Trợ lý AI Safety" role="dialog" aria-modal={false}>
    <header className={styles.header}><div><span><AssistantMascot compact/><i/></span><div><strong>Trợ lý An toàn AI</strong><small>{status ? (status.mode === 'local' ? 'Chế độ cơ bản · Chỉ đọc' : status.provider + ' · Chỉ đọc') : 'Đang kết nối...'}</small></div></div><nav><button title="Lịch sử" disabled={loading} onClick={()=>{stopVoice();setHistoryOpen(value=>!value);}}><History size={17}/></button><button title={expanded?'Thu nhỏ':'Mở rộng'} onClick={()=>setExpanded(value=>!value)}>{expanded?<Minimize2 size={17}/>:<Maximize2 size={17}/>}</button><button title="Đóng" onClick={()=>{stopVoice();setOpen(false);}}><X size={18}/></button></nav></header>
    <div className={styles.securityBar}><ShieldCheck size={13}/><span>Phản hồi theo quyền của {user.full_name}</span><em>READ ONLY</em></div>
    {historyOpen&&<aside className={styles.historyPanel}><header><div><strong>Lịch sử hội thoại</strong><span>{conversations.length} cuộc trò chuyện</span></div><button onClick={newConversation} disabled={loading}><Plus size={14}/> Cuộc chat mới</button></header><div>{conversations.length?conversations.map(item=><button key={item.id} className={conversationId===item.id?styles.activeConversation:''} onClick={()=>void selectConversation(item.id)} disabled={loading}><MessageSquareText size={15}/><span><strong>{item.title}</strong><small>{item.preview||'Chưa có phản hồi'} · {relative(item.last_message_at)}</small></span><ChevronLeft size={14}/></button>):<p>Chưa có cuộc hội thoại nào.</p>}</div></aside>}
    <main className={styles.messages}>
      {initializing?<div className={styles.center}><LoaderCircle className={styles.spin}/><span>Đang kết nối trợ lý...</span></div>:messages.length===0?<Welcome status={status} user={user} send={prompt=>void sendMessage(prompt)}/>:messages.map(message=><MessageBubble key={message.id} message={message} copied={copied===message.id} copy={()=>void copyMessage(message)} rate={rating=>void feedback(message.id,rating)} speechSupported={voice.speechSupported} speaking={voice.speakingId===message.id} speak={()=>voice.speak(message.id,message.content)}/>)}
      {loading&&<div className={styles.thinking}><span><AssistantMascot compact/></span><div><i/><i/><i/></div><small>Đang soạn câu trả lời...</small></div>}
      <div ref={bottomRef}/>
    </main>
    {(error||voice.error)&&<div className={styles.error} role="alert"><span>{error||voice.error}</span><button aria-label="Đóng thông báo lỗi" onClick={()=>{setError('');voice.clearError();}}><X size={13}/></button></div>}
    <footer className={styles.composer}>
      {voice.listening && <p className={styles.voiceTranscript} role="status"><strong>Đang nghe...</strong>{voice.interimTranscript || 'Im lặng khoảng 2 giây để tự gửi. Nhấn dừng để giữ bản nháp.'}</p>}
      <div className={styles.inputRow}>
        <button type="button" className={[styles.microphoneButton, voice.listening ? styles.listening : ''].join(' ')} onClick={() => voice.toggleListening(input)} disabled={loading || initializing || historyOpen || !voice.recognitionSupported} aria-label={voice.listening ? 'Dừng ghi âm' : 'Nhập bằng giọng nói'} aria-pressed={voice.listening} title={voice.recognitionSupported ? 'Im lặng 2 giây để tự gửi' : 'Nhập giọng nói cần Chrome/Edge và HTTPS hoặc localhost'}>{voice.listening ? <Square size={16}/> : <Mic size={18}/>}</button>
        <textarea rows={1} value={input} maxLength={4000} onChange={event => setInput(event.target.value)} onKeyDown={keyDown} placeholder="Nhắn tin hoặc nhấn micro..." disabled={loading || voice.listening} aria-label="Tin nhắn cho trợ lý AI"/>
        <button type="button" onClick={() => void sendMessage()} disabled={!input.trim() || loading || voice.listening} aria-label="Gửi tin nhắn">{loading ? <LoaderCircle size={17} className={styles.spin}/> : <Send size={17}/>}</button>
      </div>
      <div className={styles.voiceToolbar}>
        <button type="button" onClick={() => voice.setAutoRead(!voice.autoRead)} disabled={!voice.speechSupported} aria-pressed={voice.autoRead} title="Tự đọc câu trả lời mới"><Volume2 size={14}/>Tự đọc câu trả lời</button>
        <div>{voice.speakingId && <button type="button" onClick={voice.stopSpeaking}><Square size={12}/>{voice.preparingAudio ? 'Dừng tạo giọng' : 'Dừng đọc'}</button>}<button type="button" onClick={() => setVoiceSettingsOpen(value => !value)} aria-expanded={voiceSettingsOpen} aria-controls="chat-voice-settings"><SlidersHorizontal size={14}/>Giọng đọc</button></div>
      </div>
      {voiceSettingsOpen && <div id="chat-voice-settings" className={styles.voiceSettings}>
        <label>Dịch vụ đọc<select aria-label="Dịch vụ đọc" value={voice.source} onChange={event => voice.setPreferences({ source: event.target.value as 'cloud' | 'browser' })}><option value="cloud" disabled={!status?.speech_available}>Giọng AI · Việt / Anh</option><option value="browser">Giọng trên thiết bị</option></select></label>
        <label>Giọng<select aria-label="Giọng nam hoặc nữ" value={voice.preferences.gender} onChange={event => voice.setPreferences({ gender: event.target.value as VoiceGender })}><option value="female">Nữ{voice.source === 'cloud' ? ' · Kore' : ''}</option><option value="male">Nam{voice.source === 'cloud' ? ' · Charon' : ''}</option></select></label>
        <label>Ngôn ngữ nói<select aria-label="Ngôn ngữ nhận dạng" value={voice.preferences.inputLanguage} onChange={event => voice.setPreferences({ inputLanguage: event.target.value as 'vi-VN' | 'en-US' })}><option value="vi-VN">Tiếng Việt</option><option value="en-US">English</option></select></label>
        <button type="button" className={styles.previewVoice} disabled={!voice.speechSupported} onClick={() => voice.speak('voice-preview', 'Xin chào! Mình là trợ lý AI của bạn. Hello! I am your AI assistant.', true)}><Volume2 size={14}/>Nghe thử</button>
        <p>{voice.source === 'cloud' ? 'Giọng AI tự đọc Việt/Anh theo nội dung. Tạo âm thanh qua OpenRouter, có tính phí.' : voice.hasVietnameseVoice ? 'Giọng đọc phụ thuộc các voice nam/nữ có trên thiết bị.' : 'Thiết bị chưa có giọng Việt. Chọn giọng AI để đọc tiếng Việt rõ hơn.'}</p>
      </div>}
      {!voice.recognitionSupported && <p className={styles.voiceHint}>Nhập giọng nói cần trình duyệt Chrome/Edge có hỗ trợ.</p>}
      <span>Enter để gửi · Shift + Enter để xuống dòng</span>
      {conversationId && <button className={styles.archive} disabled={loading} onClick={() => void archiveConversation()}><Archive size={12}/>Lưu trữ cuộc chat</button>}
    </footer>
  </section>;
}

function Welcome({status,user,send}:{status:ChatStatus|null;user:ApiUser;send:(prompt:string)=>void}){
  const prompts=status?.suggested_prompts||[
    'Tóm tắt tình hình an toàn hôm nay','Camera nào đang ngoại tuyến?',
    'Liệt kê cảnh báo nghiêm trọng chưa xử lý','Sự cố nào đang quá hạn?',
  ];
  return <div className={styles.welcome}><div className={styles.welcomeIcon}><span><AssistantMascot/></span></div><h2>Xin chào, {user.full_name.split(' ').slice(-1)[0]}!</h2><p>Mình có thể trò chuyện, giúp bạn tra cứu dữ liệu vận hành và đọc câu trả lời. Bạn có thể nhắn tin hoặc nói qua micro.</p><div className={styles.suggestions}>{prompts.map((prompt,index)=><button key={prompt} onClick={()=>send(prompt)}><span>{index===0?<Sparkles size={15}/>:index===1?<MessageSquareText size={15}/>:index===2?<ShieldCheck size={15}/>:<History size={15}/>}</span><em>{prompt}</em><ChevronLeft size={14}/></button>)}</div><small><ShieldCheck size={12}/> Mình chỉ tra cứu dữ liệu trong phạm vi quyền của bạn.</small></div>;
}

function MessageBubble({message,copied,copy,rate,speechSupported,speaking,speak}:{message:Message;copied:boolean;copy:()=>void;rate:(rating:-1|1)=>void;speechSupported:boolean;speaking:boolean;speak:()=>void}){
  const assistant=message.role==='assistant';
  return <article className={`${styles.message} ${assistant?styles.assistant:styles.user}`}>
    {assistant&&<span className={styles.botAvatar}><AssistantMascot compact/></span>}
    <div className={styles.messageBody}><div className={styles.content}>{message.content.split('\n').map((line,index)=><p key={index}>{line||'\u00a0'}</p>)}</div>
      {assistant&&message.metadata.sources&&message.metadata.sources.length>0&&<div className={styles.sources}><span>Nguồn dữ liệu</span><div>{message.metadata.sources.map(source=><Link href={source.url} key={source.url}><ExternalLink size={11}/>{source.label}</Link>)}</div></div>}
      {assistant&&<footer><span>{message.latency_ms!==null?message.latency_ms+' ms':'Nội bộ'}</span><nav><button type="button" title={speaking?"Dừng đọc":"Đọc câu trả lời"} aria-label={speaking?"Dừng đọc câu trả lời":"Đọc câu trả lời"} aria-pressed={speaking} className={speaking?styles.speaking:""} disabled={!speechSupported} onClick={speak}>{speaking?<Square size={13}/>:<Volume2 size={14}/>}</button><button title="Sao chép" onClick={copy}>{copied?<Check size={13}/>:<Copy size={13}/>}</button><button title="Hữu ích" className={message.feedback===1?styles.rated:''} onClick={()=>rate(1)}><ThumbsUp size={13}/></button><button title="Chưa hữu ích" className={message.feedback===-1?styles.ratedDown:''} onClick={()=>rate(-1)}><ThumbsDown size={13}/></button></nav></footer>}
    </div>
  </article>;
}

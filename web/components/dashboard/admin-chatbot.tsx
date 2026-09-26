'use client';

import {
  Archive, Bot, Check, ChevronLeft, Copy, ExternalLink, History,
  LoaderCircle, Maximize2, MessageSquareText, Minimize2, Plus, Send,
  ShieldCheck, Sparkles, ThumbsDown, ThumbsUp, Trash2, X,
} from 'lucide-react';
import Link from 'next/link';
import { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { ApiUser } from '@/lib/auth';
import { readAuthSession } from '@/lib/auth';
import styles from './admin-chatbot.module.css';

const API_BASE=(process.env.NEXT_PUBLIC_API_URL||'http://localhost:8000').replace(/\/$/,'');
type ChatStatus={available:boolean;provider:string;model:string;mode:'openai'|'local';suggested_prompts:string[]};
type Conversation={id:string;title:string;status:string;message_count:number;last_message_at:string;created_at:string;preview:string|null};
type Source={label:string;url:string};
type Message={id:string;role:'user'|'assistant'|'system'|'tool';content:string;model_name:string|null;latency_ms:number|null;metadata:{sources?:Source[];tools?:string[];mode?:string;read_only?:boolean};created_at:string;feedback:number|null};
type ConversationDetail={id:string;title:string;status:string;created_at:string;messages:Message[]};
type SendResponse={conversation_id:string;user_message:Message;assistant_message:Message;tool_calls:Array<{name:string;label:string;status:string;duration_ms:number}>;mode:'openai'|'local'};

function headers():HeadersInit{const stored=readAuthSession();return{'Content-Type':'application/json',...(stored?{Authorization:'Bearer '+stored.session.access_token}:{})};}
function apiError(payload:unknown):string{return payload&&typeof payload==='object'&&'detail'in payload?String((payload as {detail:unknown}).detail):'Không thể xử lý yêu cầu.';}
function relative(value:string):string{const sec=Math.max(0,(Date.now()-new Date(value).getTime())/1000);if(sec<60)return'Vừa xong';if(sec<3600)return Math.floor(sec/60)+' phút';if(sec<86400)return Math.floor(sec/3600)+' giờ';return Math.floor(sec/86400)+' ngày';}

export default function AdminChatbot({user}:{user:ApiUser}){
  const [open,setOpen]=useState(false);const [expanded,setExpanded]=useState(false);const [historyOpen,setHistoryOpen]=useState(false);
  const [status,setStatus]=useState<ChatStatus|null>(null);const [conversations,setConversations]=useState<Conversation[]>([]);
  const [conversationId,setConversationId]=useState<string|null>(null);const [messages,setMessages]=useState<Message[]>([]);
  const [input,setInput]=useState('');const [loading,setLoading]=useState(false);const [initializing,setInitializing]=useState(false);
  const [error,setError]=useState('');const [copied,setCopied]=useState('');const bottomRef=useRef<HTMLDivElement>(null);

  const loadConversations=useCallback(async()=>{try{const response=await fetch(API_BASE+'/api/chat/conversations',{headers:headers()});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));setConversations(payload as Conversation[]);}catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể tải lịch sử.');}},[]);
  const initialize=useCallback(async()=>{setInitializing(true);setError('');try{const response=await fetch(API_BASE+'/api/chat/status',{headers:headers()});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));setStatus(payload as ChatStatus);await loadConversations();}catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể kết nối chatbot.');}finally{setInitializing(false);}},[loadConversations]);
  useEffect(()=>{if(open&&!status)void initialize();},[open,status,initialize]);
  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:'smooth'});},[messages,loading]);

  async function selectConversation(id:string){setInitializing(true);setError('');try{const response=await fetch(API_BASE+'/api/chat/conversations/'+id,{headers:headers()});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));const detail=payload as ConversationDetail;setConversationId(detail.id);setMessages(detail.messages);setHistoryOpen(false);}catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể mở hội thoại.');}finally{setInitializing(false);}}
  function newConversation(){setConversationId(null);setMessages([]);setInput('');setError('');setHistoryOpen(false);}
  async function archiveConversation(){if(!conversationId)return;try{const response=await fetch(API_BASE+'/api/chat/conversations/'+conversationId+'/archive',{method:'POST',headers:headers()});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));newConversation();await loadConversations();}catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể lưu trữ hội thoại.');}}

  async function sendMessage(text=input){const content=text.trim();if(!content||loading)return;setInput('');setError('');setLoading(true);const tempId='temp-'+Date.now();const optimistic:Message={id:tempId,role:'user',content,model_name:null,latency_ms:null,metadata:{},created_at:new Date().toISOString(),feedback:null};setMessages(current=>[...current,optimistic]);try{const response=await fetch(API_BASE+'/api/chat/messages',{method:'POST',headers:headers(),body:JSON.stringify({message:content,conversation_id:conversationId})});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));const result=payload as SendResponse;setConversationId(result.conversation_id);setMessages(current=>[...current.filter(message=>message.id!==tempId),result.user_message,result.assistant_message]);await loadConversations();}catch(requestError){setMessages(current=>current.filter(message=>message.id!==tempId));setInput(content);setError(requestError instanceof Error?requestError.message:'Không thể gửi tin nhắn.');}finally{setLoading(false);}}
  function keyDown(event:KeyboardEvent<HTMLTextAreaElement>){if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();void sendMessage();}}
  async function feedback(messageId:string,rating:-1|1){try{const response=await fetch(API_BASE+'/api/chat/messages/'+messageId+'/feedback',{method:'POST',headers:headers(),body:JSON.stringify({rating})});if(!response.ok)throw new Error();setMessages(current=>current.map(message=>message.id===messageId?{...message,feedback:rating}:message));}catch{setError('Không thể ghi nhận phản hồi.');}}
  async function copyMessage(message:Message){await navigator.clipboard.writeText(message.content);setCopied(message.id);window.setTimeout(()=>setCopied(''),1500);}

  if(!open)return <button className={styles.launcher} onClick={()=>setOpen(true)} aria-label="Mở trợ lý AI"><span><Sparkles size={18}/></span><Bot size={22}/><em>Trợ lý AI</em></button>;
  return <section className={`${styles.chat} ${expanded?styles.expanded:''}`} aria-label="Trợ lý AI Safety">
    <header className={styles.header}><div><span><Bot size={20}/><i/></span><div><strong>Trợ lý An toàn AI</strong><small>{status?.mode==='local'?'Dữ liệu nội bộ · Chỉ đọc':'Đang kết nối...'}</small></div></div><nav><button title="Lịch sử" onClick={()=>setHistoryOpen(value=>!value)}><History size={17}/></button><button title={expanded?'Thu nhỏ':'Mở rộng'} onClick={()=>setExpanded(value=>!value)}>{expanded?<Minimize2 size={17}/>:<Maximize2 size={17}/>}</button><button title="Đóng" onClick={()=>setOpen(false)}><X size={18}/></button></nav></header>
    <div className={styles.securityBar}><ShieldCheck size={13}/><span>Phản hồi theo quyền của {user.full_name}</span><em>READ ONLY</em></div>
    {historyOpen&&<aside className={styles.historyPanel}><header><div><strong>Lịch sử hội thoại</strong><span>{conversations.length} cuộc trò chuyện</span></div><button onClick={newConversation}><Plus size={14}/> Cuộc chat mới</button></header><div>{conversations.length?conversations.map(item=><button key={item.id} className={conversationId===item.id?styles.activeConversation:''} onClick={()=>void selectConversation(item.id)}><MessageSquareText size={15}/><span><strong>{item.title}</strong><small>{item.preview||'Chưa có phản hồi'} · {relative(item.last_message_at)}</small></span><ChevronLeft size={14}/></button>):<p>Chưa có cuộc hội thoại nào.</p>}</div></aside>}
    <main className={styles.messages}>
      {initializing?<div className={styles.center}><LoaderCircle className={styles.spin}/><span>Đang kết nối trợ lý...</span></div>:messages.length===0?<Welcome status={status} user={user} send={prompt=>void sendMessage(prompt)}/>:messages.map(message=><MessageBubble key={message.id} message={message} copied={copied===message.id} copy={()=>void copyMessage(message)} rate={rating=>void feedback(message.id,rating)}/>)}
      {loading&&<div className={styles.thinking}><span><Bot size={16}/></span><div><i/><i/><i/></div><small>Đang đọc dữ liệu được phân quyền...</small></div>}
      <div ref={bottomRef}/>
    </main>
    {error&&<div className={styles.error}><span>{error}</span><button onClick={()=>setError('')}><X size={13}/></button></div>}
    <footer className={styles.composer}><div><textarea rows={1} value={input} maxLength={4000} onChange={event=>setInput(event.target.value)} onKeyDown={keyDown} placeholder="Hỏi về camera, cảnh báo, sự cố..." disabled={loading}/><button onClick={()=>void sendMessage()} disabled={!input.trim()||loading}>{loading?<LoaderCircle size={17} className={styles.spin}/>:<Send size={17}/>}</button></div><span>Enter để gửi · Shift + Enter để xuống dòng</span>{conversationId&&<button className={styles.archive} onClick={()=>void archiveConversation()}><Archive size={12}/> Lưu trữ cuộc chat</button>}</footer>
  </section>;
}

function Welcome({status,user,send}:{status:ChatStatus|null;user:ApiUser;send:(prompt:string)=>void}){
  const prompts=status?.suggested_prompts||[
    'Tóm tắt tình hình an toàn hôm nay','Camera nào đang ngoại tuyến?',
    'Liệt kê cảnh báo nghiêm trọng chưa xử lý','Sự cố nào đang quá hạn?',
  ];
  return <div className={styles.welcome}><div className={styles.welcomeIcon}><span><Bot size={29}/></span><i><Sparkles size={13}/></i></div><h2>Xin chào, {user.full_name.split(' ').slice(-1)[0]}!</h2><p>Mình có thể đọc và tổng hợp dữ liệu vận hành theo đúng quyền của bạn. Mọi công cụ hiện tại đều chỉ đọc.</p><div className={styles.suggestions}>{prompts.map((prompt,index)=><button key={prompt} onClick={()=>send(prompt)}><span>{index===0?<Sparkles size={15}/>:index===1?<MessageSquareText size={15}/>:index===2?<ShieldCheck size={15}/>:<History size={15}/>}</span><em>{prompt}</em><ChevronLeft size={14}/></button>)}</div><small><ShieldCheck size={12}/> Hội thoại và kết quả tool được lưu nội bộ trong safety_db.</small></div>;
}

function MessageBubble({message,copied,copy,rate}:{message:Message;copied:boolean;copy:()=>void;rate:(rating:-1|1)=>void}){
  const assistant=message.role==='assistant';
  return <article className={`${styles.message} ${assistant?styles.assistant:styles.user}`}>
    {assistant&&<span className={styles.botAvatar}><Bot size={15}/></span>}
    <div className={styles.messageBody}><div className={styles.content}>{message.content.split('\n').map((line,index)=><p key={index}>{line||'\u00a0'}</p>)}</div>
      {assistant&&message.metadata.sources&&message.metadata.sources.length>0&&<div className={styles.sources}><span>Nguồn dữ liệu</span><div>{message.metadata.sources.map(source=><Link href={source.url} key={source.url}><ExternalLink size={11}/>{source.label}</Link>)}</div></div>}
      {assistant&&<footer><span>{message.latency_ms!==null?message.latency_ms+' ms':'Nội bộ'} · {message.model_name||'local'}</span><nav><button title="Sao chép" onClick={copy}>{copied?<Check size={13}/>:<Copy size={13}/>}</button><button title="Hữu ích" className={message.feedback===1?styles.rated:''} onClick={()=>rate(1)}><ThumbsUp size={13}/></button><button title="Chưa hữu ích" className={message.feedback===-1?styles.ratedDown:''} onClick={()=>rate(-1)}><ThumbsDown size={13}/></button></nav></footer>}
    </div>
  </article>;
}

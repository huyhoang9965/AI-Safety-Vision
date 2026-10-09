'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type RecognitionResult = { isFinal: boolean; [index: number]: { transcript: string } };
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onstart: (() => void) | null; onend: (() => void) | null;
  onspeechstart: (() => void) | null; onspeechend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  start: () => void; abort: () => void;
};
type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
type Session = { recognition: Recognition; base: string; final: string; interim: string; timer?: number; heardSpeech: boolean; hasCarry: boolean };
export type VoiceGender = 'female' | 'male';
type Preferences = { gender: VoiceGender; source: 'auto' | 'cloud' | 'browser'; inputLanguage: 'vi-VN' | 'en-US' };
const DEFAULT_PREFERENCES: Preferences = { gender: 'female', source: 'auto', inputLanguage: 'vi-VN' };
const PREFERENCES_KEY = 'ai-safety-chat-voice-v1';
const SILENCE_MS = 2000;

export function speechChunks(text: string, size = 180): string[] {
  const clean = text.replace(/\x60{3}[\s\S]*?\x60{3}/g, ' Đoạn mã được hiển thị trong tin nhắn. ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/g, '')
    .replace(/^[#>\s]*[-*•]\s*/gm, '').replace(/[#*_\x60~]/g, '').replace(/\s+/g, ' ').trim();
  const chunks: string[] = [];
  let remaining = clean;
  while (remaining) {
    if (remaining.length <= size) { chunks.push(remaining); break; }
    const part = remaining.slice(0, size);
    const sentence = Math.max(part.lastIndexOf('. '), part.lastIndexOf('? '), part.lastIndexOf('! '));
    const split = sentence > size / 3 ? sentence + 1 : part.lastIndexOf(' ');
    const end = split > 0 ? split : size;
    chunks.push(remaining.slice(0, end).trim()); remaining = remaining.slice(end).trim();
  }
  return chunks.filter(Boolean);
}

function languageOf(text: string): 'vi' | 'en' {
  if (/[À-ỹĐđ]/u.test(text) || /\b(xin chao|cam on|ban|minh|hom nay|canh bao|su co|nguoi dung)\b/i.test(text)) return 'vi';
  if (/\b(hello|hi|thank|thanks|the|this|that|is|are|your|you|please|welcome|offline|online|english|assistant)\b/i.test(text)) return 'en';
  return 'vi';
}

function browserVoice(voices: SpeechSynthesisVoice[], language: 'vi' | 'en', gender: VoiceGender) {
  const candidates = voices.filter(voice => voice.lang.toLowerCase().startsWith(language));
  const names = gender === 'female' ? /\b(zira|hoaimy|aria|jenny|sonia|susan|hazel|kore|aoede|samantha)\b/i : /\b(david|mark|namminh|an|guy|ryan|george|charon|daniel|alex)\b/i;
  return candidates.find(voice => names.test(voice.name));
}

type Options = {
  enabled: boolean; canListen: boolean; cloudAvailable: boolean;
  onTranscript: (text: string) => void; onAutoSend: (text: string) => void;
  getAudio: (messageId: string | null, gender: VoiceGender, signal: AbortSignal) => Promise<Blob>;
};

export function useChatVoice(options: Options) {
  const [recognitionSupported, setRecognitionSupported] = useState(false);
  const [browserSupported, setBrowserSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [preparingAudio, setPreparingAudio] = useState(false);
  const [autoRead, setAutoReadState] = useState(false);
  const [preferences, setPreferencesState] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [error, setError] = useState('');
  const optionsRef = useRef(options); optionsRef.current = options;
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  const autoReadRef = useRef(false);
  const sessionRef = useRef<Session | null>(null);
  const playbackRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const utterancesRef = useRef<SpeechSynthesisUtterance[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const audioCacheRef = useRef(new Map<string, Blob>());

  const stopSpeaking = useCallback(() => {
    generationRef.current += 1; playbackRef.current = null;
    requestRef.current?.abort(); requestRef.current = null;
    const audio = audioRef.current; audioRef.current = null;
    if (audio) { audio.onended = null; audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load(); }
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null; utterancesRef.current = [];
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setSpeakingId(null); setPreparingAudio(false);
  }, []);

  const stopListening = useCallback((commit = false) => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    window.clearTimeout(session.timer);
    if (commit) optionsRef.current.onTranscript([session.base, session.final, session.interim].filter(Boolean).join(' ').slice(0, 4000));
    const recognition = session.recognition;
    recognition.onresult = recognition.onend = recognition.onerror = recognition.onstart = recognition.onspeechstart = recognition.onspeechend = null;
    try { recognition.abort(); } catch { /* Already ended. */ }
    setListening(false); setInterimTranscript('');
  }, []);

  useEffect(() => {
    const target = window as SpeechWindow;
    setRecognitionSupported(Boolean((target.SpeechRecognition || target.webkitSpeechRecognition) && window.isSecureContext));
    setBrowserSupported('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window);
    const refreshVoices = () => setAvailableVoices(window.speechSynthesis?.getVoices() || []);
    refreshVoices(); window.speechSynthesis?.addEventListener('voiceschanged', refreshVoices);
    try {
      autoReadRef.current = localStorage.getItem('ai-safety-chat-auto-read') === 'true';
      setAutoReadState(autoReadRef.current);
      const stored = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || '{}');
      setPreferencesState({
        gender: stored.gender === 'male' ? 'male' : 'female',
        source: ['cloud', 'browser'].includes(stored.source) ? stored.source : 'auto',
        inputLanguage: stored.inputLanguage === 'en-US' ? 'en-US' : 'vi-VN',
      });
    } catch { /* Optional storage. */ }
    return () => {
      window.speechSynthesis?.removeEventListener('voiceschanged', refreshVoices);
      stopListening(); stopSpeaking(); audioCacheRef.current.clear();
    };
  }, [stopListening, stopSpeaking]);

  useEffect(() => { if (!options.enabled) { stopListening(); stopSpeaking(); } else if (!options.canListen) stopListening(); }, [options.enabled, options.canListen, stopListening, stopSpeaking]);

  const toggleListening = useCallback((input: string) => {
    if (sessionRef.current) { stopListening(true); return; }
    if (!optionsRef.current.enabled || !optionsRef.current.canListen) return;
    const target = window as SpeechWindow;
    const Constructor = target.SpeechRecognition || target.webkitSpeechRecognition;
    if (!Constructor || !window.isSecureContext) { setError('Nhập giọng nói cần Chrome/Edge và HTTPS hoặc localhost.'); return; }
    stopSpeaking(); setError('');
    let recognition: Recognition;
    try { recognition = new Constructor(); } catch { setError('Trình duyệt chưa thể khởi tạo micro.'); return; }
    recognition.lang = preferencesRef.current.inputLanguage; recognition.continuous = true; recognition.interimResults = true;
    const session: Session = { recognition, base: input.trimEnd(), final: '', interim: '', heardSpeech: false, hasCarry: false };
    sessionRef.current = session;
    const armSend = () => {
      window.clearTimeout(session.timer);
      if (!session.heardSpeech) return;
      session.timer = window.setTimeout(() => {
        if (sessionRef.current !== session || !optionsRef.current.enabled || !optionsRef.current.canListen) return;
        const text = [session.base, session.final, session.interim].filter(Boolean).join(' ').trim().slice(0, 4000);
        stopListening();
        if (text) { optionsRef.current.onTranscript(text); optionsRef.current.onAutoSend(text); }
      }, SILENCE_MS);
    };
    recognition.onstart = () => { if (sessionRef.current === session) setListening(true); };
    recognition.onspeechstart = () => { if (sessionRef.current === session) window.clearTimeout(session.timer); };
    recognition.onspeechend = () => { if (sessionRef.current === session) armSend(); };
    recognition.onresult = event => {
      if (sessionRef.current !== session || !optionsRef.current.enabled) return;
      const final: string[] = [], interim: string[] = [];
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i], text = result[0]?.transcript.trim();
        if (text) (result.isFinal ? final : interim).push(text);
      }
      session.final = final.join(' '); session.interim = interim.join(' ');
      session.heardSpeech = Boolean(session.final || session.interim || session.hasCarry);
      optionsRef.current.onTranscript([session.base, session.final].filter(Boolean).join(' ').slice(0, 4000));
      setInterimTranscript(session.interim); armSend();
    };
    recognition.onend = () => {
      if (sessionRef.current !== session) return;
      // Retain the silence timer if an engine ends early. A restart allows
      // speaking again during the remaining two-second window to cancel it.
      if (!session.heardSpeech) { stopListening(); return; }
      session.base = [session.base, session.final, session.interim].filter(Boolean).join(' ').slice(0, 4000);
      session.hasCarry = true;
      session.final = ''; session.interim = '';
      optionsRef.current.onTranscript(session.base); setInterimTranscript('');
      try { recognition.start(); } catch { /* Pending timer completes the turn. */ }
    };
    recognition.onerror = event => {
      if (sessionRef.current !== session) return;
      const messages: Record<string, string> = {
        'not-allowed': 'Micro chưa được cấp quyền. Hãy cho phép micro trong cài đặt trình duyệt rồi thử lại.',
        'service-not-allowed': 'Trình duyệt chưa cho phép nhận dạng giọng nói.',
        'audio-capture': 'Không tìm thấy micro. Hãy kiểm tra thiết bị thu âm.',
        'network': 'Dịch vụ nhận dạng giọng nói chưa kết nối được. Hãy kiểm tra mạng.',
        'no-speech': 'Mình chưa nghe rõ. Bạn hãy thử nói lại.',
        'language-not-supported': 'Thiết bị chưa hỗ trợ ngôn ngữ nhận dạng đã chọn.',
      };
      if (event.error !== 'aborted') setError(messages[event.error] || 'Không nhận dạng được giọng nói. Bạn hãy thử lại.');
      stopListening(true);
    };
    try { setListening(true); recognition.start(); } catch { stopListening(); setError('Không thể bật micro lúc này.'); }
  }, [stopListening, stopSpeaking]);

  const speak = useCallback((id: string, text: string, preview = false) => {
    if (playbackRef.current === id) { stopSpeaking(); return; }
    if (!optionsRef.current.enabled) return;
    stopListening(); stopSpeaking(); setError('');
    const prefs = preferencesRef.current;
    const cloud = prefs.source === 'cloud' || (prefs.source === 'auto' && optionsRef.current.cloudAvailable);
    const generation = generationRef.current;
    if (cloud) {
      if (!optionsRef.current.cloudAvailable) { setError('Giọng AI chưa sẵn sàng. Hãy kiểm tra cấu hình OpenRouter.'); return; }
      playbackRef.current = id; setSpeakingId(id); setPreparingAudio(true);
      const controller = new AbortController(); requestRef.current = controller;
      void (async () => {
        try {
          const key = id + ':' + prefs.gender;
          let blob = audioCacheRef.current.get(key);
          if (!blob) {
            blob = await optionsRef.current.getAudio(preview ? null : id, prefs.gender, controller.signal);
            if (generation !== generationRef.current || controller.signal.aborted) return;
            if (audioCacheRef.current.size >= 6) audioCacheRef.current.delete(audioCacheRef.current.keys().next().value!);
            audioCacheRef.current.set(key, blob);
          }
          if (generation !== generationRef.current || !optionsRef.current.enabled) return;
          const url = URL.createObjectURL(blob); audioUrlRef.current = url;
          const audio = new Audio(url); audioRef.current = audio;
          audio.onended = () => { if (generation === generationRef.current) stopSpeaking(); };
          audio.onerror = () => { if (generation === generationRef.current) { audioCacheRef.current.delete(key); stopSpeaking(); setError('Không phát được âm thanh. Bạn hãy thử lại.'); } };
          await audio.play();
          if (generation === generationRef.current) setPreparingAudio(false);
        } catch (requestError) {
          if (generation !== generationRef.current || controller.signal.aborted) return;
          stopSpeaking();
          setError(requestError instanceof Error ? (requestError.name === 'NotAllowedError' ? 'Trình duyệt chặn tự phát âm thanh. Nhấn nút loa để đọc câu trả lời.' : requestError.message) : 'Không tạo được giọng AI.');
        }
      })();
      return;
    }
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) { setError('Thiết bị chưa có giọng đọc. Hãy chọn giọng AI.'); return; }
    const sentences = text.match(/[^.!?;\n]+(?:[.!?;]+|\n|$)/g) || [text];
    const parts = sentences.flatMap(sentence => speechChunks(sentence).map(content => ({ content, language: languageOf(sentence) })));
    const voices = window.speechSynthesis.getVoices();
    const selections = parts.map(part => browserVoice(voices, part.language, prefs.gender));
    if (selections.some(voice => !voice)) {
      setError('Thiết bị thiếu giọng Việt/Anh phù hợp với giọng nam/nữ đã chọn. Hãy chọn “Giọng AI” để đọc song ngữ.'); return;
    }
    if (!parts.length) return;
    playbackRef.current = id; setSpeakingId(id);
    const utterances = parts.map((part, index) => {
      const utterance = new SpeechSynthesisUtterance(part.content);
      utterance.voice = selections[index]!; utterance.lang = part.language === 'vi' ? 'vi-VN' : 'en-US';
      utterance.rate = 1; utterance.pitch = 1;
      utterance.onend = () => { if (generation === generationRef.current && index === parts.length - 1) stopSpeaking(); };
      utterance.onerror = event => {
        if (generation !== generationRef.current || ['interrupted', 'canceled'].includes(event.error)) return;
        stopSpeaking(); setError('Không đọc được tin nhắn bằng giọng thiết bị. Hãy chọn giọng AI.');
      };
      return utterance;
    });
    utterancesRef.current = utterances;
    try { window.speechSynthesis.resume(); utterances.forEach(utterance => window.speechSynthesis.speak(utterance)); }
    catch { stopSpeaking(); setError('Thiết bị chưa thể đọc tin nhắn lúc này.'); }
  }, [stopListening, stopSpeaking]);

  const setAutoRead = useCallback((value: boolean) => {
    autoReadRef.current = value; setAutoReadState(value);
    if (!value) stopSpeaking();
    try { localStorage.setItem('ai-safety-chat-auto-read', String(value)); } catch { /* Optional storage. */ }
  }, [stopSpeaking]);
  const setPreferences = useCallback((patch: Partial<Preferences>) => {
    stopSpeaking(); stopListening(true);
    const next = { ...preferencesRef.current, ...patch }; preferencesRef.current = next; setPreferencesState(next);
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next)); } catch { /* Optional storage. */ }
  }, [stopSpeaking, stopListening]);
  const readReply = useCallback((id: string, text: string) => { if (autoReadRef.current && optionsRef.current.enabled) speak(id, text); }, [speak]);

  return {
    recognitionSupported, speechSupported: browserSupported || options.cloudAvailable, listening, interimTranscript,
    speakingId, preparingAudio, autoRead, setAutoRead, preferences, setPreferences,
    source: preferences.source === 'auto' ? (options.cloudAvailable ? 'cloud' : 'browser') : preferences.source,
    hasVietnameseVoice: availableVoices.some(voice => voice.lang.toLowerCase().startsWith('vi')),
    error, clearError: () => setError(''), toggleListening, stopListening, speak, stopSpeaking, readReply,
  };
}

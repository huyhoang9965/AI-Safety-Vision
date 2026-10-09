import { test, expect, type Page } from '@playwright/test';

const user = {
  id: 'voice-test-user', email: 'preview@example.test', username: 'preview', full_name: 'Nguyễn Văn Kiểm Tra',
  department: null, job_title: null, phone: null, avatar_url: null, status: 'active', email_verified: true,
  memberships: [{ organization_id: 'test-org', organization_code: 'TEST', organization_name: 'Test',
    role_code: 'admin', role_name: 'Quản trị viên', is_default: true, permissions: ['dashboard.view', 'chat.use'] }],
};

type MockRecognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onstart: (() => void) | null; onend: (() => void) | null;
  onspeechstart: (() => void) | null; onspeechend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null;
  start: () => void; abort: () => void; stop: () => void;
};
type VoiceState = { recognition?: MockRecognition; starts: number; aborts: number; cancels: number; spoken: SpeechSynthesisUtterance[]; plays: string[]; pauses: number; lastAudio?: HTMLMediaElement; voices: { name: string; lang: string }[]; refreshVoices?: () => void };
declare global { interface Window { voiceTest: VoiceState } }
type TestWindow = Window;

function testWave(): Buffer {
  const audio = Buffer.alloc(44 + 48000);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(48000, 40);
  return audio;
}

async function setup(page: Page, supported = true, reply = 'Chào bạn! Mình có thể giúp gì hôm nay?', cloud = false) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ user, supported }) => {
    localStorage.setItem('ai-safety-auth-session-v1', JSON.stringify({
      access_token: 'test-only', refresh_token: 'test-only', token_type: 'bearer', expires_in: 3600, user,
    }));
    const state: VoiceState = { starts: 0, aborts: 0, cancels: 0, spoken: [], plays: [], pauses: 0, voices: [{ lang: 'vi-VN', name: 'Microsoft HoaiMy' }, { lang: 'vi-VN', name: 'Microsoft NamMinh' }, { lang: 'en-US', name: 'Microsoft Zira' }, { lang: 'en-US', name: 'Microsoft David' }] };
    const target = window as TestWindow;
    target.voiceTest = state;
    class Recognition implements MockRecognition {
      lang = ''; continuous = false; interimResults = false;
      onstart: MockRecognition['onstart'] = null; onend: MockRecognition['onend'] = null;
      onspeechstart: MockRecognition['onspeechstart'] = null; onspeechend: MockRecognition['onspeechend'] = null;
      onerror: MockRecognition['onerror'] = null; onresult: MockRecognition['onresult'] = null;
      constructor() { state.recognition = this; }
      start() { state.starts += 1; this.onstart?.(); }
      abort() { state.aborts += 1; this.onend?.(); }
      stop() { this.onend?.(); }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: supported ? Recognition : undefined });
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => state.voices,
      addEventListener: (_type: string, listener: () => void) => { state.refreshVoices = listener; }, removeEventListener: () => {},
      cancel: () => { state.cancels += 1; }, resume: () => {}, speak: (utterance: SpeechSynthesisUtterance) => { state.spoken.push(utterance); },
    } });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class {
      text: string; lang = ''; rate = 1; pitch = 1; voice: unknown; onend: (() => void) | null = null; onerror: unknown;
      constructor(text: string) { this.text = text; }
    } });
    HTMLMediaElement.prototype.play = function () { state.plays.push(this.src); state.lastAudio = this; return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () { state.pauses += 1; };
    HTMLMediaElement.prototype.load = function () {};
  }, { user, supported });
  const sent: { message: string; conversation_id: string | null }[] = [];
  const speechRequests: { message_id: string | null; voice: string }[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let body: unknown;
    if (path === '/api/auth/me') body = user;
    else if (path === '/api/health') body = { status: 'ok', database: 'connected', test_videos: 0, loaded_models: [] };
    else if (path === '/api/models') body = [];
    else if (path === '/api/chat/status') body = { available: true, provider: 'OpenRouter', model: 'test-model', mode: 'openrouter', llm_configured: true, speech_available: cloud, suggested_prompts: ['Camera nào đang ngoại tuyến?'] };
    else if (path === '/api/chat/conversations') body = [];
    else if (path === '/api/chat/messages' && request.method() === 'POST') {
      const payload = request.postDataJSON(); sent.push(payload);
      const message = { model_name: null, latency_ms: 20, metadata: {}, created_at: new Date().toISOString(), feedback: null };
      body = { conversation_id: 'test-conversation', mode: 'openrouter', tool_calls: [],
        user_message: { ...message, id: 'user-' + sent.length, role: 'user', content: payload.message },
        assistant_message: { ...message, id: 'assistant-' + sent.length, role: 'assistant', content: reply, model_name: 'test-model' } };
    } else if (path === '/api/chat/speech' && request.method() === 'POST') {
      speechRequests.push(request.postDataJSON());
      await route.fulfill({ contentType: 'audio/wav', body: testWave() });
      return;
    } else throw new Error('Unexpected request: ' + request.method() + ' ' + path);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Mở trợ lý AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Trợ lý AI Safety' });
  await expect(dialog.getByRole('heading', { name: /Xin chào/ })).toBeVisible();
  await expect(dialog.getByText('OpenRouter · Chỉ đọc', { exact: true })).toBeVisible();
  return { dialog, sent, speechRequests, errors };
}

test('Vietnamese speech accumulates without duplicates and sends only after review', async ({ page }) => {
  const { dialog, sent, errors } = await setup(page);
  const input = dialog.getByRole('textbox', { name: 'Tin nhắn cho trợ lý AI' });
  await input.fill('Mình muốn hỏi:');
  await dialog.getByRole('button', { name: 'Nhập bằng giọng nói', exact: true }).click();
  await expect(input).toBeDisabled();
  await page.evaluate(() => {
    const recognition = (window as TestWindow).voiceTest.recognition!;
    recognition.onresult?.({ results: [{ isFinal: true, 0: { transcript: 'chào bạn' } }, { isFinal: false, 0: { transcript: 'hôm nay' } }] });
    recognition.onresult?.({ results: [{ isFinal: true, 0: { transcript: 'chào bạn' } }, { isFinal: false, 0: { transcript: 'hôm nay' } }] });
  });
  await expect(input).toHaveValue('Mình muốn hỏi: chào bạn');
  await expect(dialog.getByRole('status')).toContainText('hôm nay');
  expect(sent).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Dừng ghi âm', exact: true }).click();
  await expect(input).toHaveValue('Mình muốn hỏi: chào bạn hôm nay');
  await expect(input).toBeEnabled();
  await dialog.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
  await expect(dialog.getByText('Chào bạn! Mình có thể giúp gì hôm nay?', { exact: true })).toBeVisible();
  expect(sent).toEqual([{ message: 'Mình muốn hỏi: chào bạn hôm nay', conversation_id: null }]);
  expect(await page.evaluate(() => (window as TestWindow).voiceTest.recognition!.lang)).toBe('vi-VN');
  expect(await page.evaluate(() => (window as TestWindow).voiceTest.spoken.length)).toBe(0);
  expect(errors).toEqual([]);
});

test('microphone permission errors preserve typed draft and allow retry', async ({ page }) => {
  const { dialog } = await setup(page);
  const input = dialog.getByRole('textbox');
  await input.fill('Nội dung đang soạn');
  await dialog.getByRole('button', { name: 'Nhập bằng giọng nói' }).click();
  await page.evaluate(() => (window as TestWindow).voiceTest.recognition!.onerror?.({ error: 'not-allowed' }));
  await expect(dialog.getByRole('alert')).toContainText('Micro chưa được cấp quyền');
  await expect(input).toHaveValue('Nội dung đang soạn');
  await expect(input).toBeEnabled();
  await dialog.getByRole('button', { name: 'Nhập bằng giọng nói' }).click();
  await expect(dialog.getByRole('button', { name: 'Dừng ghi âm' })).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('manual and automatic reading use Vietnamese chunks and stop on close', async ({ page }) => {
  const reply = 'Chào bạn! ' + 'Mình sẽ hỗ trợ bạn tra cứu dữ liệu vận hành. '.repeat(12);
  const { dialog, errors } = await setup(page, true, reply);
  await dialog.getByRole('textbox').fill('chào bạn');
  await dialog.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  const read = dialog.getByRole('button', { name: 'Đọc câu trả lời', exact: true });
  await read.click();
  const utterances = await page.evaluate(() => (window as TestWindow).voiceTest.spoken.map(item => ({ text: item.text, lang: item.lang })));
  expect(utterances.length).toBeGreaterThan(1);
  expect(utterances.every(item => item.text.length <= 180 && item.lang === 'vi-VN')).toBe(true);
  await dialog.getByRole('button', { name: 'Dừng đọc', exact: true }).click();
  await expect(read).toBeVisible();
  await dialog.getByRole('button', { name: 'Tự đọc câu trả lời', exact: true }).click();
  await dialog.getByRole('textbox').fill('cảm ơn bạn');
  await dialog.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  await expect(dialog.getByRole('button', { name: 'Dừng đọc', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ai-safety-chat-auto-read'))).toBe('true');
  const before = await page.evaluate(() => (window as TestWindow).voiceTest.cancels);
  await dialog.getByRole('button', { name: 'Đóng', exact: true }).click();
  expect(await page.evaluate(() => (window as TestWindow).voiceTest.cancels)).toBeGreaterThan(before);
  expect(errors).toEqual([]);
});

test('closing aborts recognition and late results cannot alter a new conversation', async ({ page }) => {
  const { dialog } = await setup(page);
  await dialog.getByRole('textbox').fill('Bản nháp');
  await dialog.getByRole('button', { name: 'Nhập bằng giọng nói' }).click();
  await dialog.getByRole('button', { name: 'Đóng', exact: true }).click();
  expect(await page.evaluate(() => (window as TestWindow).voiceTest.aborts)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Mở trợ lý AI', exact: true }).click();
  await dialog.getByRole('button', { name: 'Lịch sử', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cuộc chat mới' }).click();
  await page.evaluate(() => (window as TestWindow).voiceTest.recognition!.onresult?.({ results: [{ isFinal: true, 0: { transcript: 'kết quả cũ' } }] }));
  await expect(dialog.getByRole('textbox')).toHaveValue('');
});

test('provider failure restores the draft and a retry saves one complete turn', async ({ page }) => {
  const { dialog, sent } = await setup(page);
  let fail = true;
  await page.route('**/api/chat/messages', async route => {
    if (!fail) return route.fallback();
    fail = false;
    await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ detail: 'OpenRouter chưa thể trả lời lúc này.' }) });
  });
  const input = dialog.getByRole('textbox');
  await input.fill('chào bạn');
  await dialog.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  await expect(dialog.getByRole('alert')).toContainText('OpenRouter');
  await expect(input).toHaveValue('chào bạn');
  expect(sent).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  await expect(dialog.getByText('Chào bạn! Mình có thể giúp gì hôm nay?', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect(sent).toHaveLength(1);
});

test('an in-flight reply cannot be placed in a different conversation', async ({ page }) => {
  const { dialog } = await setup(page);
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/chat/messages', async route => { await pending; await route.fallback(); });
  await dialog.getByRole('textbox').fill('chào bạn');
  await dialog.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  await expect(dialog.getByRole('button', { name: 'Lịch sử', exact: true })).toBeDisabled();
  release();
  await expect(dialog.getByText('Chào bạn! Mình có thể giúp gì hôm nay?', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Lịch sử', exact: true })).toBeEnabled();
});

test('unsupported speech input keeps text chat available on a small screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { dialog, errors } = await setup(page, false);
  await expect(dialog.getByRole('button', { name: 'Nhập bằng giọng nói' })).toBeDisabled();
  await expect(dialog.getByText('Nhập giọng nói cần trình duyệt Chrome/Edge có hỗ trợ.')).toBeVisible();
  await dialog.getByRole('textbox').fill('chào bạn');
  await dialog.getByRole('textbox').press('Enter');
  await expect(dialog.getByText('Chào bạn! Mình có thể giúp gì hôm nay?', { exact: true })).toBeVisible();
  const layout = await dialog.evaluate(element => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, width: innerWidth, scroll: element.scrollWidth, client: element.clientWidth };
  });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.width);
  expect(layout.scroll).toBeLessThanOrEqual(layout.client);
  expect(errors).toEqual([]);
});

test('two seconds of silence sends once, including an interim-only transcript', async ({ page }) => {
  const { dialog, sent } = await setup(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await dialog.getByRole('textbox').fill('Mình muốn hỏi:');
  await dialog.getByRole('button', { name: 'Nhập bằng giọng nói' }).click();
  await page.evaluate(() => (window as TestWindow).voiceTest.recognition!.onresult?.({ results: [{ isFinal: false, 0: { transcript: 'chào bạn' } }] }));
  await page.clock.runFor(1999);
  expect(sent).toHaveLength(0);
  await page.clock.runFor(1);
  await expect(dialog.getByText('Chào bạn! Mình có thể giúp gì hôm nay?', { exact: true })).toBeVisible();
  expect(sent).toEqual([{ message: 'Mình muốn hỏi: chào bạn', conversation_id: null }]);
  await page.clock.runFor(5000);
  expect(sent).toHaveLength(1);
  await expect(dialog.getByRole('button', { name: 'Nhập bằng giọng nói' })).toBeVisible();
});

test('resuming speech cancels the pending send and restarts the silence window', async ({ page }) => {
  const { dialog, sent } = await setup(page);
  await page.clock.install();
  await dialog.getByRole('button', { name: 'Nhập bằng giọng nói' }).click();
  await page.evaluate(() => (window as TestWindow).voiceTest.recognition!.onresult?.({ results: [{ isFinal: true, 0: { transcript: 'chào bạn' } }] }));
  await page.clock.runFor(1500);
  await page.evaluate(() => (window as TestWindow).voiceTest.recognition!.onspeechstart?.());
  await page.clock.runFor(1000);
  expect(sent).toHaveLength(0);
  await page.evaluate(() => (window as TestWindow).voiceTest.recognition!.onresult?.({ results: [{ isFinal: true, 0: { transcript: 'chào bạn' } }, { isFinal: true, 0: { transcript: 'hôm nay' } }] }));
  await page.clock.runFor(1999);
  expect(sent).toHaveLength(0);
  await page.clock.runFor(1);
  await expect(dialog.getByText('Chào bạn! Mình có thể giúp gì hôm nay?', { exact: true })).toBeVisible();
  expect(sent[0].message).toBe('chào bạn hôm nay');
});

test('empty audio, manual stop and closing cannot auto-send a typed draft', async ({ page }) => {
  const { dialog, sent } = await setup(page);
  await page.clock.install();
  await dialog.getByRole('textbox').fill('Bản nháp');
  await dialog.getByRole('button', { name: 'Nhập bằng giọng nói' }).click();
  await page.evaluate(() => (window as TestWindow).voiceTest.recognition!.onspeechend?.());
  await page.clock.runFor(5000);
  expect(sent).toHaveLength(0);
  await page.evaluate(() => (window as TestWindow).voiceTest.recognition!.onresult?.({ results: [{ isFinal: true, 0: { transcript: 'chào bạn' } }] }));
  await page.clock.runFor(1000);
  await dialog.getByRole('button', { name: 'Dừng ghi âm' }).click();
  await page.clock.runFor(3000);
  expect(sent).toHaveLength(0);
  await expect(dialog.getByRole('textbox')).toHaveValue('Bản nháp chào bạn');
  await dialog.getByRole('button', { name: 'Nhập bằng giọng nói' }).click();
  await page.evaluate(() => (window as TestWindow).voiceTest.recognition!.onresult?.({ results: [{ isFinal: true, 0: { transcript: 'tạm biệt' } }] }));
  await dialog.getByRole('button', { name: 'Đóng', exact: true }).click();
  await page.clock.runFor(3000);
  expect(sent).toHaveLength(0);
});

test('an early recognition end preserves the pending turn and does not duplicate speech', async ({ page }) => {
  const { dialog, sent } = await setup(page);
  await page.clock.install();
  await dialog.getByRole('button', { name: 'Nhập bằng giọng nói' }).click();
  await page.evaluate(() => {
    const recognition = (window as TestWindow).voiceTest.recognition!;
    recognition.onresult?.({ results: [{ isFinal: true, 0: { transcript: 'chào bạn' } }] });
    recognition.onend?.();
  });
  await page.clock.runFor(2000);
  await expect(dialog.getByText('Chào bạn! Mình có thể giúp gì hôm nay?', { exact: true })).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0].message).toBe('chào bạn');
});

test('browser reading chooses native Vietnamese and English voices per sentence', async ({ page }) => {
  const { dialog } = await setup(page, true, 'Xin chào! Hello, how are you?');
  await dialog.getByRole('textbox').fill('chào bạn');
  await dialog.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  await dialog.getByRole('button', { name: 'Đọc câu trả lời', exact: true }).click();
  const selected = await page.evaluate(() => (window as TestWindow).voiceTest.spoken.map(item => ({ lang: item.lang, voice: item.voice?.name })));
  expect(selected).toEqual([{ lang: 'vi-VN', voice: 'Microsoft HoaiMy' }, { lang: 'en-US', voice: 'Microsoft Zira' }]);
  await dialog.getByRole('button', { name: 'Giọng đọc', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Giọng nam hoặc nữ' }).selectOption('male');
  await dialog.getByRole('button', { name: 'Nghe thử', exact: true }).click();
  const male = await page.evaluate(() => (window as TestWindow).voiceTest.spoken.slice(2).map(item => item.voice?.name));
  expect(male).toContain('Microsoft NamMinh');
  expect(male).toContain('Microsoft David');
});

test('missing Vietnamese voice never falls back to an English voice', async ({ page }) => {
  const { dialog } = await setup(page);
  await page.evaluate(() => { const state = (window as TestWindow).voiceTest; state.voices = state.voices.filter(voice => voice.lang.startsWith('en')); state.refreshVoices?.(); });
  await dialog.getByRole('textbox').fill('chào bạn');
  await dialog.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  await dialog.getByRole('button', { name: 'Đọc câu trả lời', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Thiết bị thiếu giọng Việt/Anh');
  expect(await page.evaluate(() => (window as TestWindow).voiceTest.spoken.length)).toBe(0);
  await dialog.getByRole('button', { name: 'Giọng đọc', exact: true }).click();
  await expect(dialog.getByText('Thiết bị chưa có giọng Việt. Chọn giọng AI để đọc tiếng Việt rõ hơn.')).toBeVisible();
});

test('cloud voice supports male/female, previews, caching and saved preference', async ({ page }) => {
  const { dialog, speechRequests, errors } = await setup(page, true, 'Xin chào! Hello!', true);
  await dialog.getByRole('button', { name: 'Giọng đọc', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Dịch vụ đọc' })).toHaveValue('cloud');
  await dialog.getByRole('button', { name: 'Nghe thử', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as TestWindow).voiceTest.plays.length)).toBe(1);
  expect(speechRequests).toEqual([{ message_id: null, voice: 'female' }]);
  await dialog.getByRole('combobox', { name: 'Giọng nam hoặc nữ' }).selectOption('male');
  await dialog.getByRole('button', { name: 'Nghe thử', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as TestWindow).voiceTest.plays.length)).toBe(2);
  expect(speechRequests[1]).toEqual({ message_id: null, voice: 'male' });
  await dialog.getByRole('button', { name: 'Nghe thử', exact: true }).click();
  await dialog.getByRole('button', { name: 'Nghe thử', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as TestWindow).voiceTest.plays.length)).toBe(3);
  expect(speechRequests).toHaveLength(2);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ai-safety-chat-voice-v1')!).gender)).toBe('male');
  await dialog.getByRole('combobox', { name: 'Ngôn ngữ nhận dạng' }).selectOption('en-US');
  await dialog.getByRole('button', { name: 'Nhập bằng giọng nói' }).click();
  expect(await page.evaluate(() => (window as TestWindow).voiceTest.recognition!.lang)).toBe('en-US');
  expect(errors).toEqual([]);
});

test('cloud auto-reading requests only the saved reply ID and stops on closing', async ({ page }) => {
  const { dialog, speechRequests } = await setup(page, true, 'Xin chào! Hello!', true);
  await dialog.getByRole('button', { name: 'Tự đọc câu trả lời', exact: true }).click();
  await dialog.getByRole('textbox').fill('chào bạn');
  await dialog.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  await expect.poll(() => page.evaluate(() => (window as TestWindow).voiceTest.plays.length)).toBe(1);
  expect(speechRequests).toEqual([{ message_id: 'assistant-1', voice: 'female' }]);
  await dialog.getByRole('button', { name: 'Đóng', exact: true }).click();
  expect(await page.evaluate(() => (window as TestWindow).voiceTest.pauses)).toBeGreaterThan(0);
});

test('closing while cloud synthesis is pending prevents late audio playback', async ({ page }) => {
  const { dialog } = await setup(page, true, 'Xin chào!', true);
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/chat/speech', async route => { await pending; await route.fulfill({ contentType: 'audio/wav', body: testWave() }).catch(() => {}); });
  await dialog.getByRole('button', { name: 'Giọng đọc', exact: true }).click();
  await dialog.getByRole('button', { name: 'Nghe thử', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Dừng tạo giọng', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Đóng', exact: true }).click();
  release();
  await page.getByRole('button', { name: 'Mở trợ lý AI', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Dừng đọc', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as TestWindow).voiceTest.plays.length)).toBe(0);
});

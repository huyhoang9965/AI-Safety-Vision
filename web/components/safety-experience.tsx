'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, BellRing, Camera, Check, ChevronRight, Circle, Eye, EyeOff, Fingerprint, Focus, HardHat, KeyRound, Layers3, Lock, LogOut, Mail, Maximize, Pause, Play, ScanLine, Shield, ShieldCheck, TriangleAlert, User, X } from 'lucide-react';
import { clamp, lerp, segmentInOut, smoothstep } from '@/lib/motion';

const SCROLL_LENGTH = 3700;
const chapters = ['Overview', 'PPE Detection', 'Behavior', 'Pipeline', 'Capabilities'];
const chapterPositions = [0, 1050, 2050, 2760, 3500];
const ppeClasses = ['Helmet', 'Vest', 'Gloves', 'Goggles', 'Mask', 'Safety Shoes'];
const behaviors = ['Safe Walkway', 'Safe Walkway Violation', 'Unauthorized Intervention', 'Authorized Intervention', 'Opened Panel Cover', 'Closed Panel Cover', 'Safe Carrying', 'Carrying Overload with Forklift'];
const capabilities = [
  { kicker: 'Visual Detection', title: 'PPE Compliance', description: 'Detect helmets, vests, gloves, goggles, masks and safety footwear.', icon: HardHat },
  { kicker: 'Temporal AI', title: 'Behavior Recognition', description: 'Understand actions across video rather than judging isolated frames.', icon: ScanLine },
  { kicker: 'Spatial Safety', title: 'Danger Zones', description: 'Detect when tracked workers enter restricted or hazardous regions.', icon: Focus },
  { kicker: 'Identity Through Time', title: 'Person Tracking', description: 'Associate safety observations with workers across consecutive frames.', icon: Fingerprint },
  { kicker: 'Risk Intelligence', title: 'Smart Alerts', description: 'Combine PPE, behavior and spatial context to trigger meaningful warnings.', icon: BellRing },
];
const pipeline = [
  { name: 'CAMERA', detail: 'Visual input', icon: Camera },
  { name: 'PERSON / PPE DETECTION', detail: 'YOLO · spatial', icon: ScanLine },
  { name: 'BEHAVIOR RECOGNITION', detail: 'VideoMAE · temporal', icon: Eye },
  { name: 'RISK FUSION', detail: 'Contextual signals', icon: Layers3 },
  { name: 'SAFETY ALERT', detail: 'Human review', icon: BellRing },
];

function CapabilitySlider() {
  const viewport = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(5);
  const [step, setStep] = useState(414);
  const [animate, setAnimate] = useState(false);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touch = useRef<number | null>(null);
  useEffect(() => {
    const element = viewport.current!;
    const observer = new ResizeObserver(() => {
      const card = element.querySelector<HTMLElement>('.capability-card');
      if (card) setStep(card.getBoundingClientRect().width + 18);
    });
    observer.observe(element);
    return () => { observer.disconnect(); clearTimeout(timer.current); };
  }, []);
  const move = (direction: number) => {
    if (busy.current) return;
    busy.current = true;
    const next = index + direction;
    setAnimate(true);
    setIndex(next);
    timer.current = setTimeout(() => {
      setAnimate(false);
      setIndex(5 + ((next % 5) + 5) % 5);
      busy.current = false;
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 520);
  };
  return <div className="capability-slider" aria-roledescription="carousel" aria-label="System capabilities">
    <div className="card-viewport" ref={viewport} onTouchStart={e => { touch.current = e.touches[0].clientX; }} onTouchEnd={e => {
      if (touch.current !== null && Math.abs(e.changedTouches[0].clientX - touch.current) > 35) move(e.changedTouches[0].clientX < touch.current ? 1 : -1);
      touch.current = null;
    }}>
      <div className="card-track" style={{ transform: `translate3d(${-index * step}px,0,0)`, transition: animate ? 'transform 500ms cubic-bezier(.2,.7,.2,1)' : 'none' }}>
        {[0, 1, 2].flatMap(set => capabilities.map((card, i) => <article className="capability-card" key={`${set}-${i}`} aria-hidden={set !== 1}>
          <div className="card-top"><card.icon size={23} strokeWidth={1.4} /><span>0{i + 1}</span></div>
          <span className="card-kicker">{card.kicker}</span><h3>{card.title}</h3><p>{card.description}</p>
        </article>))}
      </div>
    </div>
    <div className="slider-controls"><span className="mono" aria-live="polite">0{index % 5 + 1} <span className="muted">/ 05</span></span><div><button aria-label="Previous capability" onClick={() => move(-1)}><ArrowLeft size={19} /></button><button aria-label="Next capability" onClick={() => move(1)}><ArrowRight size={19} /></button></div></div>
  </div>;
}

export default function SafetyExperience() {
  const rig = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const authDialog = useRef<HTMLDialogElement>(null);
  const [chapter, setChapter] = useState(0);
  const [modal, setModal] = useState<'demo' | 'results'>('demo');
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const [branch, setBranch] = useState<'ppe' | 'behavior'>('ppe');

  // Authentication state
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [showPassword, setShowPassword] = useState(false);
  const [user, setUser] = useState<{ name: string; email: string; role: string } | null>(null);
  const [authNotice, setAuthNotice] = useState('');

  useEffect(() => {
    let targetScroll = 0, smoothScroll = 0;
    let targetMouseX = 0, targetMouseY = 0, mouseX = 0, mouseY = 0;
    let raf = 0, lastChapter = -1, lastTime = 0;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = preference.matches;
    let stageHeight = window.innerHeight;
    const measure = () => { stageHeight = stage.current?.clientHeight || window.innerHeight; updateScroll(); };
    const updateScroll = () => { targetScroll = clamp(-rig.current!.getBoundingClientRect().top, 0, SCROLL_LENGTH); wake(); };
    const pointer = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || window.innerWidth < 768 || reduced) return;
      targetMouseX = (e.clientX / window.innerWidth - .5) * 2;
      targetMouseY = (e.clientY / stageHeight - .5) * 2;
      wake();
    };
    const resetPointer = () => { targetMouseX = 0; targetMouseY = 0; wake(); };
    const preferenceChanged = () => { reduced = preference.matches; resetPointer(); };
    const tick = (time: number) => {
      const delta = Math.min((time - (lastTime || time - 16.67)) / 16.67, 2.5);
      lastTime = time;
      // Silky smooth, organic inertia interpolation
      smoothScroll = reduced ? targetScroll : lerp(smoothScroll, targetScroll, 1 - Math.pow(1 - .088, delta));
      mouseX = reduced ? 0 : lerp(mouseX, targetMouseX, .045);
      mouseY = reduced ? 0 : lerp(mouseY, targetMouseY, .045);
      const s = smoothScroll;
      const phase = s < 550 ? 0 : s < 1720 ? 1 : s < 2480 ? 2 : s < 3040 ? 3 : 4;
      if (phase !== lastChapter) { lastChapter = phase; setChapter(phase); }
      const hero = 1 - smoothstep(20, 650, s);
      const ppe = segmentInOut(s, 550, 850, 1490, 1770);
      const behavior = segmentInOut(s, 1680, 1880, 2360, 2560);
      const pipe = segmentInOut(s, 2400, 2570, 2970, 3150);
      const cards = smoothstep(2980, 3320, s);
      const style = stage.current!.style;
      const vars: Record<string, string | number> = {
        '--hero-opacity': reduced ? Number(phase === 0) : hero,
        '--hero-y': `${reduced ? 0 : -200 * (1 - hero)}px`,
        '--hero-scale': reduced ? 1 : 1 - .045 * (1 - hero),
        '--copy-y': `${reduced ? 0 : 55 * (1 - hero)}px`,
        '--scene-scale': reduced ? 1.04 : 1.04 + s / SCROLL_LENGTH * .17,
        '--scene-brightness': 1 - smoothstep(450, 1300, s) * .26,
        '--mouse-x': `${mouseX * 9}px`, '--mouse-y': `${mouseY * 5}px`,
        '--foreground-x': `${reduced ? 0 : smoothstep(450, 1200, s) * 240}px`,
        '--ppe-opacity': reduced ? Number(phase === 1) : ppe,
        '--ppe-y': `${reduced ? 0 : (1 - smoothstep(550, 850, s)) * 58 - smoothstep(1490, 1770, s) * 65}px`,
        '--ppe-blur': `${reduced ? 0 : smoothstep(1490, 1770, s) * 10}px`,
        '--behavior-opacity': reduced ? Number(phase === 2) : behavior,
        '--behavior-y': `${reduced ? 0 : (1 - smoothstep(1680, 1880, s)) * 58 - smoothstep(2360, 2560, s) * 50}px`,
        '--behavior-scale': reduced ? 1 : 1 + smoothstep(1680, 2560, s) * .08,
        '--pipeline-opacity': reduced ? Number(phase === 3) : pipe,
        '--pipe-progress': reduced ? Number(phase === 3) : clamp((s - 2440) / 280),
        '--cards-opacity': reduced ? Number(phase === 4) : cards,
        '--cards-x': `${reduced ? 0 : (1 - cards) * 60}vw`,
        '--dark-opacity': smoothstep(2380, 2580, s) * .88,
        '--progress': s / SCROLL_LENGTH,
      };
      pipeline.forEach((_, i) => { vars[`--step-${i}`] = reduced ? Number(phase === 3) : smoothstep(2420 + i * 60, 2490 + i * 60, s); });
      Object.entries(vars).forEach(([key, value]) => style.setProperty(key, String(value)));
      if (Math.abs(targetScroll - s) > .008 || Math.abs(targetMouseX - mouseX) > .0005 || Math.abs(targetMouseY - mouseY) > .0005) raf = requestAnimationFrame(tick);
      else { raf = 0; lastTime = 0; }
    };
    function wake() { if (!raf) raf = requestAnimationFrame(tick); }
    measure();
    window.addEventListener('scroll', updateScroll, { passive: true });
    window.addEventListener('resize', measure);
    window.addEventListener('pointermove', pointer, { passive: true });
    document.addEventListener('pointerleave', resetPointer);
    preference.addEventListener('change', preferenceChanged);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', updateScroll); window.removeEventListener('resize', measure);
      window.removeEventListener('pointermove', pointer); document.removeEventListener('pointerleave', resetPointer);
      preference.removeEventListener('change', preferenceChanged);
    };
  }, []);

  useEffect(() => {
    if (!playing) return;
    const interval = setInterval(() => setFrame(f => (f + 1) % 16), 380);
    return () => clearInterval(interval);
  }, [playing]);

  const goTo = (index: number) => {
    const top = rig.current!.getBoundingClientRect().top + window.scrollY + chapterPositions[index];
    window.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  const openModal = (type: 'demo' | 'results') => { setModal(type); setPlaying(false); dialog.current?.showModal(); };
  const closeModal = () => { dialog.current?.close(); setPlaying(false); };

  const openAuth = (mode: 'signin' | 'signup') => {
    setAuthMode(mode);
    setAuthNotice('');
    authDialog.current?.showModal();
  };
  const closeAuth = () => {
    authDialog.current?.close();
    setAuthNotice('');
  };

  const handleAuthSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const emailInput = form.querySelector<HTMLInputElement>('#auth-email');
    const nameInput = form.querySelector<HTMLInputElement>('#auth-name');
    const roleInput = form.querySelector<HTMLSelectElement>('#auth-role');

    const email = emailInput?.value || 'safety.lead@factory-ai.org';
    const name = nameInput?.value || (authMode === 'signin' ? 'Trần Văn Minh' : 'Kỹ sư An toàn');
    const role = roleInput?.value || 'EHS Director';

    setUser({ name, email, role });
    setAuthNotice(authMode === 'signin' ? 'Đăng nhập thành công! Đang kích hoạt phiên làm việc...' : 'Đăng ký thành công! Trạm giám sát đã sẵn sàng.');
    setTimeout(() => {
      closeAuth();
    }, 650);
  };

  return <main>
    <a href="#closing" className="skip-link">Skip cinematic experience</a>
    <section className="scroll-rig" ref={rig} aria-label="Interactive safety monitoring story">
      <div className="cinematic-stage" ref={stage}>
        <div className="factory-scene" aria-hidden="true"><div className="scene-canvas factory-image" /></div>
        <div className="scene-shade" aria-hidden="true" />
        <div className="atmosphere" aria-hidden="true" />
        <div className="behavior-background" aria-hidden="true"><div className="scene-canvas behavior-image" /><div className="behavior-shade" /></div>
        <div className="pipeline-dark" aria-hidden="true" />

        <header className="site-header">
          <button className="brand" onClick={() => goTo(0)} aria-label="AI Safety — back to overview"><span className="brand-mark"><ScanLine size={25} strokeWidth={1.6} /></span><span>AI SAFETY<span className="brand-sub">VISION. AWARENESS. ACTION.</span></span></button>
          <nav aria-label="Main navigation">{chapters.slice(0, 4).map((name, i) => <button key={name} onClick={() => goTo(i)} className={chapter === i ? 'active' : ''} aria-current={chapter === i ? 'step' : undefined}>{name}</button>)}<button onClick={() => openModal('demo')}>Demo <ArrowUpRight size={12} /></button></nav>
          <div className="header-actions">
            <button className="live-status" onClick={() => openModal('demo')}><span className="status-light" /> LIVE SYSTEM <ArrowUpRight size={13} /></button>
            {user ? (
              <div className="user-badge">
                <span className="user-avatar"><User size={13} /></span>
                <span className="user-info"><strong>{user.name}</strong><small>{user.role}</small></span>
                <button className="user-logout" onClick={() => setUser(null)} title="Đăng xuất" aria-label="Đăng xuất"><LogOut size={13} /></button>
              </div>
            ) : (
              <div className="auth-btns">
                <button className="auth-btn signin" onClick={() => openAuth('signin')}>Đăng nhập</button>
                <button className="auth-btn signup" onClick={() => openAuth('signup')}>Đăng ký</button>
              </div>
            )}
          </div>
        </header>

        <section className="hero-title-layer" aria-hidden={chapter !== 0}>
          <div className="eyebrow"><span className="tiny-square" /> INTELLIGENCE THAT LOOKS OUT FOR PEOPLE</div>
          <h1>AI SAFETY<br /><span>MONITORING</span><span className="title-period">.</span></h1>
        </section>
        <div className="worker-foreground" aria-hidden="true"><div className="scene-canvas factory-image worker-cutout" /></div>
        <div className="structural-foreground structural-left" aria-hidden="true"><div className="scene-canvas factory-image" /></div>
        <div className="structural-foreground structural-right" aria-hidden="true"><div className="scene-canvas factory-image" /></div>
        <div className="hero-support" aria-hidden={chapter !== 0}>
          <h2>See risk before it becomes an accident.</h2>
          <p>AI-powered workplace monitoring for personal protective<br className="desktop-break" /> equipment compliance and unsafe behavior recognition.</p>
          <div className="hero-pills"><span><HardHat size={14} /> 6 PPE Classes</span><span><ScanLine size={14} /> 8 Behaviors</span><span><Play size={12} /> Video Intelligence</span></div>
        </div>
        <div className="hero-coordinate" aria-hidden="true"><span className="crosshair">+</span><span>HUMAN-CENTERED INTELLIGENCE<br /><span className="muted">01 / INDUSTRIAL ENVIRONMENT</span></span></div>

        <section className="story-panel ppe-panel" aria-hidden={chapter !== 1}>
          <div className="eyebrow orange"><span className="tiny-square" /> 01 / VISUAL INTELLIGENCE</div>
          <h2>PPE compliance<br />starts with<br /><em>visibility.</em></h2>
          <p>The vision system identifies essential protective equipment on workers before safety violations become incidents.</p>
          <div className="stats"><div><strong>6</strong><span>PPE categories</span></div><div><strong className="word-stat">REAL-TIME</strong><span>visual inspection</span></div></div>
          <div className="model-label"><Circle size={9} /> YOLO OBJECT DETECTION <span>ILLUSTRATIVE OVERLAY</span></div>
        </section>
        <div className="ppe-overlay" aria-hidden={chapter !== 1}>
          <div className="scene-canvas">
            <div className="detection-box helmet-box"><span><Check size={10} /> Helmet 0.98</span></div>
            <div className="detection-box goggles-box"><span><Check size={10} /> Goggles 0.94</span></div>
            <div className="detection-box mask-box"><span><Check size={10} /> Mask 0.91</span></div>
            <div className="detection-box vest-box"><span><Check size={10} /> Vest 0.99</span></div>
            <div className="detection-box gloves-box"><span>Gloves 0.93</span></div>
            <div className="detection-box shoes-box"><span>Safety Shoes 0.96</span></div>
          </div>
        </div>

        <section className="story-panel behavior-panel" aria-hidden={chapter !== 2}>
          <div className="eyebrow orange"><span className="tiny-square" /> 02 / TEMPORAL INTELLIGENCE</div>
          <h2>Safety is more<br />than what<br />workers <em>wear.</em></h2>
          <p>VideoMAE analyzes temporal patterns to recognize unsafe and operational behaviors across video sequences.</p>
          <div className="stats behavior-stats"><div><strong>8</strong><span>behavior classes</span></div><div><strong>16</strong><span>frames sampled per clip</span></div><div><strong className="small-stat">MULTI-<br />LABEL</strong><span>recognition</span></div></div>
          <div className="behavior-tags">{behaviors.map(label => <span key={label}>{label}</span>)}</div>
        </section>
        <div className="temporal-overlay" aria-hidden={chapter !== 2}>
          <div className="temporal-corner top-left" /><div className="temporal-corner bottom-right" />
          <div className="temporal-label"><span className="status-light" /> SEQUENCE ANALYSIS <span>VIDEOMAE 16-FRAME WINDOW</span></div>
          <div className="motion-trail" /><div className="motion-trail trail-two" />
          <div className="temporal-box forklift-temporal-box"><span>Carrying Overload with Forklift · 0.92</span></div>
          <div className="temporal-box walkway-temporal-box"><span>Safe Walkway · 0.98</span></div>
          <div className="walkway-label"><Focus size={15} /> SPATIAL + TEMPORAL CONTEXT</div>
          <div className="frame-strip">{Array.from({ length: 16 }, (_, i) => <div key={i} style={{ backgroundPosition: `${i * 6.6}% center` }}><span>{String(i + 1).padStart(2, '0')}</span></div>)}</div>
          <div className="frame-caption"><span>16 FRAMES SAMPLED / CLIP</span><span>VIDEOMAE TEMPORAL ENCODER</span></div>
        </div>

        <section className="pipeline-panel" aria-hidden={chapter !== 3}>
          <div className="eyebrow orange"><span className="tiny-square" /> 03 / CONNECTED INTELLIGENCE</div>
          <h2>One camera.<br /><em>Multiple layers of intelligence.</em></h2>
          <div className="pipeline">
            <div className="pipeline-track" aria-hidden="true"><div className="pipeline-progress-bar" /></div>
            {pipeline.map((item, i) => <div className="pipeline-node" key={item.name} style={{ '--node-opacity': `var(--step-${i}, 0)` } as CSSProperties}><div className="pipeline-icon"><item.icon size={26} strokeWidth={1.25} /></div><span className="node-number">0{i + 1}</span><h3>{item.name}</h3><p>{item.detail}</p>{i < 4 && <ChevronRight className="pipeline-arrow" size={14} />}</div>)}
          </div>
          <p className="pipeline-copy">Visual compliance and temporal behavior analysis can be combined<br className="desktop-break" /> to understand workplace risk in context.</p>
          <span className="architecture-note">RESEARCH ARCHITECTURE · FUSION AND ALERTING ARE PROPOSED EXTENSIONS</span>
        </section>

        <section className="capabilities-panel" aria-hidden={chapter !== 4} inert={chapter !== 4}>
          <div className="capabilities-heading"><div><div className="eyebrow orange"><span className="tiny-square" /> 04 / A MORE COMPLETE PICTURE</div><h2>Every layer.<br /><em>A clearer perspective.</em></h2></div><p>From visual signals to meaningful context.<br />Explore the system’s research capabilities<br />and proposed extensions.</p></div>
          <CapabilitySlider />
        </section>

        <footer className="stage-footer"><button className="scroll-cue" onClick={() => chapter < 4 ? goTo(chapter + 1) : document.getElementById('closing')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })}><span className="scroll-icon"><ArrowDown size={14} /></span><span>{chapter === 0 ? 'SCROLL TO SEE THE UNSEEN' : chapter === 4 ? 'EXPLORE WHAT’S NEXT' : 'SCROLL TO EXPLORE'}</span></button><div className="chapter-control"><span className="mono">0{chapter + 1} <span className="muted">/ 05</span></span><div className="chapter-dots">{chapters.map((name, i) => <button key={name} aria-label={`Go to ${name}`} aria-current={chapter === i ? 'step' : undefined} className={chapter === i ? 'selected' : ''} onClick={() => goTo(i)} />)}</div><span className="chapter-name">{chapters[chapter]}</span></div><span className="research-label">COMPUTER VISION <span>×</span> DEEP LEARNING</span></footer>
        <div className="scroll-progress" aria-hidden="true" /><div className="grain" aria-hidden="true" />
      </div>
    </section>

    <section id="closing" className="closing-section">
      <div className="closing-top"><div className="eyebrow"><span className="tiny-square" /> BUILT TO SEE THE BIGGER PICTURE</div><span className="mono muted">AN ACADEMIC RESEARCH PROJECT</span></div>
      <div className="closing-content"><h2>FROM CAMERA<br />TO ACTIONABLE<br /><span>SAFETY.</span></h2><div className="closing-detail"><span className="closing-symbol"><ShieldCheck size={37} strokeWidth={1} /></span><p>A computer vision system designed to monitor protective equipment, understand unsafe behavior and support faster workplace safety response.</p><div className="cta-actions"><button className="primary-button" onClick={() => openModal('demo')}><Play size={14} fill="currentColor" /> Watch Demo <ArrowUpRight size={17} /></button><button className="text-button" onClick={() => openModal('results')}>Explore Detection Results <ArrowUpRight size={16} /></button><button className="text-button" onClick={() => openAuth(user ? 'signin' : 'signin')}><Shield size={14} /> {user ? `Tài khoản: ${user.name} (${user.role})` : 'Cổng Đăng Nhập Giám Sát'} <ArrowUpRight size={16} /></button></div><span className="academic-note">Research in progress. Designed to assist safety personnel.</span></div></div>
      <div className="project-details"><p>Deep Learning and Computer Vision for PPE Compliance<br className="desktop-break" /> and Unsafe Behavior Recognition</p><div><span>YOLO <small>OBJECT DETECTION</small></span><span>VideoMAE <small>VIDEO CLASSIFICATION</small></span></div></div>
      <footer className="site-footer"><span className="footer-brand"><ScanLine size={20} /> AI SAFETY MONITORING</span><span>SEE RISK. <span className="muted">BEFORE IT BECOMES AN INCIDENT.</span></span><button onClick={() => goTo(0)}>BACK TO TOP <ArrowUpRight size={14} /></button></footer>
    </section>

    <dialog ref={dialog} className="demo-dialog" onClose={() => { setPlaying(false); document.body.style.overflow = ''; }} onClick={event => { if (event.target === event.currentTarget) closeModal(); }} aria-labelledby="dialog-title">
      <div className="dialog-content"><div className="dialog-heading"><div><span className="eyebrow orange">RESEARCH PREVIEW</span><h2 id="dialog-title">{modal === 'demo' ? 'A closer look at the system.' : 'Detection & evaluation.'}</h2></div><button className="close-button" aria-label="Close dialog" onClick={closeModal}><X size={22} /></button></div>
        <div className="branch-tabs" role="tablist" aria-label="Model branch"><button role="tab" aria-selected={branch === 'ppe'} onClick={() => { setBranch('ppe'); setFrame(0); }}>PPE Detection <span>YOLO</span></button><button role="tab" aria-selected={branch === 'behavior'} onClick={() => { setBranch('behavior'); setFrame(0); }}>Behavior <span>VideoMAE</span></button></div>
        {modal === 'demo' ? <><div className={`demo-preview ${branch}`}><div className="demo-preview-image" style={{ transform: `scale(${1 + frame * .003})` }} /><span className="demo-image-label">ILLUSTRATIVE SCENE · NO LIVE INFERENCE</span><div className="demo-bounding-box"><span>{branch === 'ppe' ? 'PERSON / PPE REGION' : 'TEMPORAL OBSERVATION REGION'}</span></div><span className="demo-frame">FRAME {String(frame + 1).padStart(2, '0')} / 16</span></div><div className="demo-playback"><button onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause sequence preview' : 'Play sequence preview'}>{playing ? <Pause size={17} /> : <Play size={17} />}</button><input aria-label="Preview frame" type="range" min="0" max="15" value={frame} onChange={e => { setPlaying(false); setFrame(Number(e.target.value)); }} /><span className="mono">{String(frame + 1).padStart(2, '0')} / 16</span><Maximize size={16} /></div><p className="dialog-explanation">{branch === 'ppe' ? 'YOLO identifies people and protective equipment within individual frames. The illustration highlights the observation region; it is not a model prediction.' : 'VideoMAE examines 16 sampled frames to recognize behavior over time. This storyboard uses a still image to explain frame sampling; it is not a recorded inference run.'}</p></> : <><div className="results-heading"><span><TriangleAlert size={16} /> Evaluation results pending</span><p>Metrics will be populated from a verified evaluation run. No performance values are claimed.</p></div><div className="metric-grid">{(branch === 'ppe' ? ['mAP@50', 'Precision', 'Recall'] : ['F1 score', 'Precision', 'Recall']).map(metric => <div key={metric}><span>{metric}</span><strong>—</strong><small>Awaiting evaluation</small></div>)}</div></>}
        <div className="dialog-classes"><span className="mono">{branch === 'ppe' ? '6 PPE CATEGORIES' : '8 BEHAVIOR CLASSES'}</span><div>{(branch === 'ppe' ? ppeClasses : behaviors).map(name => <span key={name}>{name}</span>)}</div></div>
      </div>
    </dialog>

    <dialog ref={authDialog} className="demo-dialog auth-dialog" onClose={() => { document.body.style.overflow = ''; }} onClick={event => { if (event.target === event.currentTarget) closeAuth(); }} aria-labelledby="auth-dialog-title">
      <div className="dialog-content auth-content">
        <div className="dialog-heading">
          <div>
            <span className="eyebrow orange"><span className="tiny-square" /> HỆ THỐNG AN TOÀN · CỔNG TRUY CẬP</span>
            <h2 id="auth-dialog-title">{authMode === 'signin' ? 'Đăng nhập Cổng An Toàn' : 'Đăng ký Tài khoản Giám sát'}</h2>
            <p className="auth-dialog-sub">
              {authMode === 'signin'
                ? 'Xác thực tài khoản để truy cập dữ liệu thời gian thực và quản lý cảnh báo vi phạm.'
                : 'Đăng ký tài khoản dành cho cán bộ an toàn (EHS), giám sát viên và kỹ sư phân tích.'}
            </p>
          </div>
          <button className="close-button" aria-label="Đóng cửa sổ" onClick={closeAuth}><X size={22} /></button>
        </div>

        <div className="branch-tabs" role="tablist" aria-label="Hình thức xác thực">
          <button role="tab" aria-selected={authMode === 'signin'} onClick={() => { setAuthMode('signin'); setAuthNotice(''); }}>
            Đăng nhập <span>SIGN IN</span>
          </button>
          <button role="tab" aria-selected={authMode === 'signup'} onClick={() => { setAuthMode('signup'); setAuthNotice(''); }}>
            Đăng ký <span>REGISTER</span>
          </button>
        </div>

        {authNotice && (
          <div className="auth-alert" role="status">
            <ShieldCheck size={16} />
            <span>{authNotice}</span>
          </div>
        )}

        <form className="auth-form" onSubmit={handleAuthSubmit}>
          {authMode === 'signup' && (
            <div className="form-group">
              <label htmlFor="auth-name">Họ và tên cán bộ</label>
              <div className="input-wrapper">
                <User size={15} />
                <input id="auth-name" type="text" required placeholder="Ví dụ: Nguyễn Văn An" defaultValue="Alex Trần" />
              </div>
            </div>
          )}

          <div className="form-group">
            <label htmlFor="auth-email">Email công vụ / Doanh nghiệp</label>
            <div className="input-wrapper">
              <Mail size={15} />
              <input id="auth-email" type="email" required placeholder="name@industrial.corp" defaultValue={authMode === 'signin' ? "safety.lead@factory-ai.org" : "engineer@factory-ai.org"} />
            </div>
          </div>

          {authMode === 'signup' && (
            <div className="form-group">
              <label htmlFor="auth-role">Bộ phận & Chức danh</label>
              <div className="input-wrapper">
                <Shield size={15} />
                <select id="auth-role" defaultValue="Chuyên viên An toàn Lao động (EHS)">
                  <option value="Chuyên viên An toàn (EHS Lead)">Chuyên viên An toàn Lao động (EHS Lead)</option>
                  <option value="Giám sát viên Hiện trường">Giám sát viên Hiện trường (Site Supervisor)</option>
                  <option value="Kỹ sư Computer Vision / AI">Kỹ sư Computer Vision / AI</option>
                  <option value="Quản lý Nhà máy">Quản lý Nhà máy (Plant Manager)</option>
                </select>
              </div>
            </div>
          )}

          <div className="form-group">
            <div className="label-with-link">
              <label htmlFor="auth-pass">Mật khẩu trạm</label>
              {authMode === 'signin' && (
                <button type="button" className="forgot-link" onClick={() => setAuthNotice('Yêu cầu đặt lại mật khẩu đã được gửi đến quản trị viên.')}>
                  Quên mật khẩu?
                </button>
              )}
            </div>
            <div className="input-wrapper">
              <Lock size={15} />
              <input id="auth-pass" type={showPassword ? 'text' : 'password'} required placeholder="••••••••••••" defaultValue="SafetyVision2026@" />
              <button type="button" className="toggle-pass" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}>
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {authMode === 'signup' && (
            <div className="form-group">
              <label htmlFor="auth-pass-confirm">Xác nhận mật khẩu</label>
              <div className="input-wrapper">
                <KeyRound size={15} />
                <input id="auth-pass-confirm" type={showPassword ? 'text' : 'password'} required placeholder="••••••••••••" defaultValue="SafetyVision2026@" />
              </div>
            </div>
          )}

          <div className="form-options">
            <label className="checkbox-label">
              <input type="checkbox" defaultChecked />
              <span>{authMode === 'signin' ? 'Duy trì phiên bảo mật trên thiết bị này' : 'Cam kết tuân thủ quy chuẩn giám sát an toàn'}</span>
            </label>
          </div>

          <div className="auth-submit-row">
            <button type="submit" className="primary-button auth-submit-btn">
              <ShieldCheck size={15} />
              <span>{authMode === 'signin' ? 'Xác thực & Vào hệ thống' : 'Đăng ký tài khoản trạm'}</span>
              <ArrowUpRight size={15} />
            </button>
          </div>

          {authMode === 'signin' && (
            <div className="quick-access">
              <span className="mono">TRUY CẬP NHANH BẰNG TÀI KHOẢN MẪU</span>
              <div className="quick-buttons">
                <button type="button" onClick={() => {
                  setUser({ name: 'Trần Văn Minh', email: 'minh.tv@safety.corp', role: 'EHS Director' });
                  closeAuth();
                }}>
                  <HardHat size={13} /> EHS Director
                </button>
                <button type="button" onClick={() => {
                  setUser({ name: 'Lê Hoàng Hải', email: 'hai.lh@vision.ai', role: 'CV Researcher' });
                  closeAuth();
                }}>
                  <ScanLine size={13} /> AI Engineer
                </button>
              </div>
            </div>
          )}
        </form>
      </div>
    </dialog>
  </main>;
}

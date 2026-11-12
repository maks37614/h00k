import React, { useState } from 'react';
import {
  Activity, ArrowRight, ArrowUpRight, BarChart3, Bell, Bookmark, Check, ChevronRight,
  Clock3, Crosshair, Eye, Globe2, Grid2X2, History, Layers3, LockKeyhole,
  Menu, Play, Radar, Send, Settings2, ShieldCheck, SlidersHorizontal, Sparkles,
  Target, TrendingUp, X, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { AuthModal } from './AuthModal';
import { SiteFooter } from './SiteFooter';
import './guestLanding.css';

type DemoTab = 'screener' | 'formations' | 'chart' | 'terminal';
type Feature = { icon: LucideIcon; title: string; body: string; value: string };
const features: Feature[] = [
  { icon: Radar, title: 'Скрінер у реальному часі', body: 'Стежте за доступними парами Binance та Bybit: ціна, зміна за 24 години, обсяг, волатильність, локальні максимуми й мінімуми. Швидко відсіюйте зайве фільтрами.', value: 'Менше ручного пошуку' },
  { icon: Layers3, title: 'Автоматичний пошук формацій', body: 'Пошук графічних патернів за напрямком, статусом, таймфреймом та іншими умовами. Картки ведуть прямо до аналізу монети.', value: 'Сценарії в одному місці' },
  { icon: Zap, title: 'Раннє виявлення W / M', body: 'Окремий режим розпізнає потенційні подвійні вершини та дна ще під час формування, до остаточного підтвердження пробоєм.', value: 'Можливість підготуватись раніше' },
  { icon: Target, title: 'Оцінка якості сигналу', body: 'Автоматична оцінка 0–100 з урахуванням структури, тригера, ретесту, обсягів, волатильності, співвідношення ризику й прибутку та доступних індикаторів.', value: 'Зрозумілий контекст входу' },
  { icon: Crosshair, title: 'HookChart — власний графік', body: 'Повноекранний графік із масштабуванням, переміщенням, інструментами розмітки, таймфреймами та рівнями підтримки й опору.', value: 'Аналіз без зайвих вікон' },
  { icon: BarChart3, title: 'Щільності BID / ASK', body: 'Відображення помітних заявок стакана та цінових зон на графіку. Окремі пороги, автоматичний відбір і параметри відображення.', value: 'Видимі зони ліквідності' },
  { icon: Activity, title: 'Ліквідації на графіку', body: 'Позначки Long та Short ліквідацій із фільтрами за сумою, власними порогами й лічильником отриманих подій.', value: 'Розуміння ринкового тиску' },
  { icon: SlidersHorizontal, title: 'Глибокі налаштування графіка', body: 'Кольори, лінії, підписи, рівні різних таймфреймів, щільності, ліквідації, масштаб і персональні параметри HookChart.', value: 'Робочий простір під себе' },
  { icon: Target, title: 'Конструктор TP / SL', body: 'Візуальне налаштування входу, стопа та цілей для сценаріїв і окремих монет. Рівні можна переміщувати на графіку, а налаштування — зберігати.', value: 'Власні правила ризику' },
  { icon: Grid2X2, title: 'Термінал із багатьма графіками', body: 'Кілька монет і таймфреймів одночасно, готові сітки та налаштування робочої області. Зручно спостерігати за різними ринками.', value: 'Контроль на одному екрані' },
  { icon: Zap, title: 'Швидкість оновлення та алертів', body: 'Ринкові потоки та фонові перевірки допомагають оперативно бачити зміни й реагувати на власні умови. Фактична затримка залежить від біржі, мережі та Telegram.', value: 'Без постійного ручного оновлення' },
  { icon: TrendingUp, title: 'Настрій ринку й новини', body: 'Огляд загального настрою за доступними показниками динаміки та обсягів, а також стрічка ринкових новин поруч зі скрінером.', value: 'Контекст усього ринку' },
  { icon: Eye, title: 'Свіжі формації та деталізація', body: 'Переходьте з картки знайденої формації до детального графіка, відкривайте її статус, ключові рівні та супутні індикатори.', value: 'Від списку до аналізу в один перехід' },
  { icon: Bell, title: 'Telegram-сповіщення', body: 'Персональні цінові алерти та повідомлення про вибрані події. Налаштування прив’язані до акаунта, а не до спільного списку гостей.', value: 'Менше часу біля монітора' },
  { icon: Radar, title: 'Комплексне стеження за монетою', body: 'Окремий моніторинг торгових умов: структура на кількох таймфреймах, рівні, обсяги, відкритий інтерес та інші доступні дані.', value: 'Не лише одна формація' },
  { icon: Send, title: 'Лінковка з MetaScalp', body: 'Передавання вибраного інструмента до MetaScalp через персонально налаштовану лінковку й групу. Працює після налаштування інтеграції.', value: 'Швидкий перехід до стакана' },
  { icon: History, title: 'Відтворення ринку', body: 'Режим Replay дозволяє повертатися до історичних свічок, покроково програвати розвиток графіка та перевіряти власні рішення.', value: 'Навчання на реальних даних' },
  { icon: Play, title: 'Симулятор торгових рішень', body: 'Перевіряйте входи, стопи та цілі в режимі відтворення, аналізуйте результат і ведіть журнал тестових сценаріїв без реального виконання ордерів.', value: 'Практика без реальної угоди' },
  { icon: Bookmark, title: 'Обране та архів формацій', body: 'Зберігайте цікаві монети у власні папки, повертайтеся до збережених формацій і повторно відкривайте їх на графіку.', value: 'Історія ваших ідей' },
  { icon: TrendingUp, title: 'Індикатори й підтвердження', body: 'RSI, ATR, RVOL, OI, дельта, круглі числа (ROUND) та інші доступні сигнали допомагають порівнювати силу сценаріїв.', value: 'Більше аргументів для аналізу' },
  { icon: Globe2, title: 'На телефоні й комп’ютері', body: 'Адаптивний інтерфейс, підтримка сенсорного керування та можливість встановити сайт як вебзастосунок на підтримуваних пристроях.', value: 'Робота там, де вам зручно' },
];
const candles = [
  [64,88,57,100],[88,112,75,118],[112,98,90,125],[98,130,91,137],[130,142,117,151],
  [142,127,120,155],[127,151,123,163],[151,170,144,179],[170,164,155,187],[164,192,158,200],
  [192,184,174,204],[184,201,179,210],[201,182,175,214],[182,210,179,227],[210,234,204,248],
  [234,222,211,246],[222,247,216,259],[247,231,226,268],[231,253,225,264],[253,280,245,288],
  [280,267,259,299],[267,294,260,301],[294,284,274,304],[284,307,278,317],[307,294,287,328],
  [294,311,290,326],[311,301,295,323],[301,326,296,336],[326,313,307,340],[313,336,305,347]
] as const;
const demoTabs: { id: DemoTab; label: string }[] = [
  { id: 'screener', label: 'Скрінер' }, { id: 'formations', label: 'Формації' },
  { id: 'chart', label: 'HookChart' }, { id: 'terminal', label: 'Термінал' },
];

function DemoChart({ compact = false }: { compact?: boolean }) {
  return <svg viewBox="0 0 620 335" role="img" aria-label="Демонстраційний свічковий графік зі смугами обсягу та рівнем" className={compact ? 'gl-chart-svg gl-chart-small' : 'gl-chart-svg'}>
    <defs><linearGradient id="glArea" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#22d3ee" stopOpacity=".12"/><stop offset="1" stopColor="#22d3ee" stopOpacity="0"/></linearGradient></defs>
    {Array.from({length: 6}, (_, i) => <line key={'h'+i} x1="18" x2="604" y1={35+i*52} y2={35+i*52} stroke="#24334c" strokeWidth="1" strokeDasharray="3 6"/>)}
    {Array.from({length: 8}, (_, i) => <line key={'v'+i} y1="16" y2="320" x1={40+i*78} x2={40+i*78} stroke="#1c293e" strokeWidth="1"/>)}
    <path d="M18 168 H604" stroke="#eab308" strokeDasharray="7 5" strokeWidth="1.5" opacity=".85"/>
    <text x="510" y="161" fontSize="10" fill="#facc15" fontFamily="monospace">S/R · 1H</text>
    <path d="M18 253 H604" stroke="#22d3ee" strokeWidth="1.5" strokeDasharray="3 6" opacity=".8"/>
    <text x="510" y="244" fontSize="10" fill="#67e8f9" fontFamily="monospace">BID / ASK</text>
    {candles.map(([o,c,lo,hi],i) => {
      const x=28+i*19.1; const up=c>=o; const top=300-hi*.71; const bottom=300-lo*.71;
      const bTop=300-Math.max(o,c)*.71; const bBottom=300-Math.min(o,c)*.71;
      const color=up?'#22d3a0':'#fb7185';
      return <g key={i}><line x1={x} x2={x} y1={top} y2={bottom} stroke={color} strokeWidth="1.4"/><rect x={x-4.8} y={bTop} width="9.6" height={Math.max(2,bBottom-bTop)} rx="1.2" fill={color}/><rect x={x-5} y={308-(i%7+3)*3.6} width="10" height={(i%7+3)*3.6} fill={color} opacity=".23"/></g>;
    })}
    <circle cx="467" cy="132" r="4.5" fill="#f59e0b"/><circle cx="467" cy="132" r="10" fill="none" stroke="#f59e0b" opacity=".5"/>
    <text x="20" y="18" fontSize="11" fill="#94a3b8" fontFamily="monospace">BTC/USDT · 15m</text>
  </svg>;
}
function DemoWindow({ tab }: { tab: DemoTab }) {
  return <div className="gl-window" aria-label="Ілюстративний макет торгового інтерфейсу h00k">
    <div className="gl-window-top"><div className="gl-dots"><i/><i/><i/></div><span>h00k.top / {tab}</span><span className="gl-window-live"><i/> ДЕМО</span></div>
    <div className="gl-window-nav"><img src="/h00k-robot-logo.svg" alt="" /><span>Скрінер</span><span>Формації</span><span>Відтворення</span><span>Термінал</span></div>
    {tab === 'screener' && <div className="gl-table-demo">
      <div className="gl-demo-filters"><span>Усі</span><span>Активні</span><span>Топ ріст 24г</span><span>На хаях</span><span className="gl-demo-search">Пошук монети…</span></div>
      <div className="gl-demo-tablehead"><span>МОНЕТА</span><span>ЦІНА</span><span>24 ГОД</span><span>ОБСЯГ</span><span>ВОЛАТИЛЬНІСТЬ</span></div>
      {[
        ['BTC / USDT', '71 820.10', '+2.84%', '1.42B', '2.6%'],
        ['ETH / USDT', '3 275.40', '+1.63%', '822M', '3.2%'],
        ['SOL / USDT', '162.85', '−1.12%', '354M', '4.8%'],
        ['XRP / USDT', '2.38', '+3.75%', '291M', '5.1%'],
        ['DOGE / USDT', '0.184', '−0.82%', '181M', '3.9%'],
      ].map((row,i)=><div className="gl-demo-row" key={i}><strong><span className="gl-symbol">{row[0][0]}</span>{row[0]}</strong><span>{row[1]}</span><span className={row[2][0]==='−'?'gl-loss':'gl-gain'}>{row[2]}</span><span>{row[3]}</span><span>{row[4]}</span></div>)}
      <div className="gl-demo-foot">Binance & Bybit <span>Фільтри • Spot / Futures</span></div>
    </div>}
    {tab === 'formations' && <div className="gl-form-demo">
      {['Подвійне дно · W','Пробій опору','Голова й плечі'].map((v,i)=><div className="gl-formation" key={v}><div className="gl-formation-chart"><DemoChart compact /></div><div><span className="gl-form-label">ПОТЕНЦІЙНА ФОРМАЦІЯ</span><strong>{v}</strong><p>{['BTC/USDT · Binance','SOL/USDT · Bybit','ETH/USDT · Binance'][i]}</p><span className="gl-quality">{[87,79,72][i]} / 100</span></div></div>)}
    </div>}
    {tab === 'chart' && <div className="gl-fullchart"><div className="gl-chart-head">BTC / USDT <span>5m · 15m · 1h · 4h · 1d</span></div><DemoChart /><div className="gl-chart-tags"><span>Підтримка / опір</span><span>Щільності BID/ASK</span><span>Ліквідації Long/Short</span></div></div>}
    {tab === 'terminal' && <div className="gl-terminal-demo">{['BTC / USDT','SOL / USDT','ETH / USDT','XRP / USDT'].map(v=><div className="gl-terminal-panel" key={v}><span>{v} <b>15m</b></span><DemoChart compact/></div>)}</div>}
    <div className="gl-window-note">Ілюстративний макет. Дані та ціни — приклади, не поточні котирування.</div>
  </div>;
}
export function GuestLanding() {
  const [tab, setTab] = useState<DemoTab>('screener');
  const [authMode, setAuthMode] = useState<'signin' | 'signup' | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const enterScreener = () => { window.location.assign('/#screener'); };
  const openAuth = (mode: 'signin' | 'signup') => { setAuthMode(mode); setMobileMenu(false); };
  return <div className="gl-page" data-no-translate>
    <header className="gl-header"><div className="gl-header-inner">
      <a href="/" className="gl-brand" aria-label="h00k — на головну"><img src="/h00k-robot-logo.svg" alt="h00k" /></a>
      <nav className={mobileMenu?'gl-nav gl-nav-open':'gl-nav'} aria-label="Розділи презентації">
        <a onClick={()=>setMobileMenu(false)} href="#gl-platform">Платформа</a>
        <a onClick={()=>setMobileMenu(false)} href="#gl-functions">Можливості</a>
        <a onClick={()=>setMobileMenu(false)} href="#gl-workflow">Як це працює</a>
        <a onClick={()=>setMobileMenu(false)} href="#gl-faq">Запитання</a>
      </nav>
      <div className="gl-header-actions"><button type="button" className="gl-text-btn" onClick={()=>openAuth('signin')}>Увійти</button><button type="button" className="gl-btn gl-btn-sm" onClick={()=>openAuth('signup')}>Реєстрація <ArrowUpRight size={15}/></button></div>
      <button type="button" className="gl-menu" aria-label={mobileMenu?'Закрити меню':'Відкрити меню'} onClick={()=>setMobileMenu(!mobileMenu)}>{mobileMenu?<X size={22}/>:<Menu size={22}/>}</button>
    </div></header>
    <main>
      <section className="gl-hero gl-container">
        <div className="gl-hero-copy">
          <div className="gl-eyebrow"><span className="gl-pulse"/> BINANCE & BYBIT <span className="gl-eyebrow-dot">•</span> CRYPTO MARKET INTELLIGENCE</div>
          <h1>Побачити можливість <span>раніше за натовп.</span></h1>
          <p className="gl-lead">h00k об’єднує криптоскрінер, автоматичний пошук формацій, власний графік HookChart, аналіз ліквідності, сповіщення та тренажер торгових рішень.</p>
          <div className="gl-hero-ctas"><button type="button" className="gl-btn gl-btn-main" onClick={()=>openAuth('signup')}>Почати користуватися <ArrowRight size={18}/></button><button type="button" className="gl-btn-outline" onClick={enterScreener}><Eye size={17}/> Переглянути скрінер без входу</button></div>
          <div className="gl-hero-foot"><Check size={15}/> Гостьовий перегляд списку монет <span>•</span> Особисті інструменти після входу</div>
        </div>
        <div className="gl-hero-display"><DemoWindow tab={tab}/><div className="gl-floating-tag"><Zap size={15}/> Пошук · Аналіз · Сповіщення</div></div>
      </section>
      <section className="gl-benefits gl-container" aria-label="Переваги платформи">
        <div><Radar size={22}/><strong>Моніторинг ринку</strong><span>Спостереження за інструментами та важливими змінами</span></div>
        <div><Crosshair size={22}/><strong>Графік HookChart</strong><span>Технічний аналіз, рівні й візуальні інструменти</span></div>
        <div><Target size={22}/><strong>Сигнал з контекстом</strong><span>Формації, підтвердження та оцінка до 100 балів</span></div>
        <div><Bell size={22}/><strong>Персональні сповіщення</strong><span>Налаштовуйте події, які важливі саме вам</span></div>
      </section>
      <section id="gl-platform" className="gl-section gl-container">
        <div className="gl-section-top"><div><span className="gl-kicker">ПЛАТФОРМА В ДІЇ</span><h2>Один простір. Різні сценарії роботи.</h2><p>Оберіть вкладку, щоб подивитися, як організовані головні робочі розділи.</p></div></div>
        <div className="gl-tabbar" role="tablist" aria-label="Демонстрація розділів">
          {demoTabs.map(t=><button type="button" role="tab" aria-selected={tab===t.id} onClick={()=>setTab(t.id)} key={t.id} className={tab===t.id?'gl-tab-active':''}>{t.label}</button>)}
        </div>
        <div className="gl-platform-preview"><DemoWindow tab={tab}/><div className="gl-platform-caption"><span><Sparkles size={16}/> Зрозумілий інтерфейс для практичного аналізу</span><button type="button" onClick={enterScreener}>Відкрити живий скрінер <ArrowRight size={16}/></button></div></div>
      </section>
      <section className="gl-spotlight gl-container"><div className="gl-spotlight-copy"><span className="gl-kicker">HOOKCHART</span><h2>Графік, на якому видно більше.</h2><p>Не просто свічки. Додавайте рівні підтримки й опору, щільності заявок зі стакана, ліквідації та інші доступні підтвердження. Налаштовуйте відображення, масштаб, кольори й підписи під свою торгову систему.</p><div className="gl-tags"><span>Підтримка / опір</span><span>Щільності BID / ASK</span><span>Long / Short Liq</span><span>ROUND</span><span>TP / SL</span><span>Мультитаймфрейм</span></div></div><div className="gl-spotlight-visual"><DemoChart/><div className="gl-diagram-key"><span><i className="gl-key-amber"/> Рівні</span><span><i className="gl-key-cyan"/> Зони ліквідності</span><span><i className="gl-key-green"/> Свічки</span></div></div></section>
      <section id="gl-functions" className="gl-section gl-container">
        <div className="gl-section-top"><div><span className="gl-kicker">МОЖЛИВОСТІ</span><h2>Від першого фільтра до готового сценарію.</h2><p>Кожен інструмент має конкретну задачу: знайти, перевірити, зафіксувати або відстежити можливість на ринку.</p></div><span className="gl-count">{features.length} напрямків роботи</span></div>
        <div className="gl-features">{features.map(({icon:Icon,title,body,value})=><article className="gl-feature" key={title}><div className="gl-icon"><Icon size={20}/></div><h3>{title}</h3><p>{body}</p><div className="gl-feature-bottom"><Check size={14}/>{value}</div></article>)}</div>
      </section>
      <section className="gl-personal gl-container"><div><span className="gl-kicker">ВАШ РОБОЧИЙ ПРОСТІР</span><h2>Ваші монети, ваші правила.</h2><p>Обране, папки, параметри HookChart, Telegram-алерти та лінковка MetaScalp налаштовуються для окремого акаунта. Керуйте власними інструментами без необхідності щоразу починати з нуля.</p><div className="gl-personal-checks"><span><ShieldCheck size={16}/> Індивідуальні налаштування</span><span><Bookmark size={16}/> Списки й архів</span><span><Settings2 size={16}/> Збережені параметри графіка</span><span><Send size={16}/> Персональна лінковка</span></div></div><div className="gl-personal-card"><LockKeyhole size={31}/><strong>Профіль трейдера</strong><span>Мій список обраного</span><span>Мої Telegram-сповіщення</span><span>Мій HookChart</span><span>Мій MetaScalp</span></div></section>
      <section id="gl-workflow" className="gl-section gl-container"><span className="gl-kicker">ЯК ЦЕ ПРАЦЮЄ</span><h2>Знайшли → перевірили → відстежили.</h2><div className="gl-steps">
        {[['01','Знайдіть монету','Відфільтруйте ринок у скрінері або знайдіть ранню формацію.'],['02','Перевірте на HookChart','Порівняйте рівні, обсяги, щільності, ліквідації та якість сценарію.'],['03','Позначте точки входу','Налаштуйте потенційні вхід, Stop Loss і Take Profit у конструкторі.'],['04','Стежте або тренуйтеся','Увімкніть сповіщення чи перевірте ідею у відтворенні ринку.']].map(([n,t,d])=><div key={n} className="gl-step"><b>{n}</b><strong>{t}</strong><p>{d}</p></div>)}
      </div></section>
      <section className="gl-device gl-container"><div><span className="gl-kicker">ДОСТУП З РІЗНИХ ПРИСТРОЇВ</span><h2>Аналітика поруч — не лише за комп’ютером.</h2><p>Працюйте в браузері на комп’ютері, планшеті чи смартфоні. Сенсорне керування HookChart і адаптивні блоки дозволяють швидко повернутися до спостереження за ринком.</p><button type="button" className="gl-btn-outline" onClick={enterScreener}>Спробувати гостьовий перегляд <ArrowRight size={16}/></button></div><div className="gl-device-show"><div className="gl-device-monitor"><DemoChart compact/></div><div className="gl-device-phone"><DemoChart compact/></div></div></section>
      <section id="gl-faq" className="gl-section gl-container gl-faq"><div><span className="gl-kicker">ЗАПИТАННЯ</span><h2>Що потрібно знати перед початком?</h2></div><div className="gl-faq-items">
        <details><summary>Чи можна користуватися без реєстрації? <ChevronRight size={16}/></summary><p>Так. Гостям доступний перегляд списку монет і котирувань на сторінці «Скрінер». Інтерактивні графіки, персональні налаштування та частина інструментів потребують входу.</p></details>
        <details><summary>Що потрібно для реєстрації? <ChevronRight size={16}/></summary><p>Електронна пошта або Google та спеціальний код доступу, який можна отримати через Telegram-канал автора. Реєстрація використовує чинну систему акаунтів.</p></details>
        <details><summary>Чи відкриває h00k реальні позиції? <ChevronRight size={16}/></summary><p>Графічний конструктор і симулятор призначені для аналізу та навчального тестування сценаріїв. Позначки входу, стопа й цілей самі собою не відкривають біржові ордери.</p></details>
        <details><summary>Чи гарантує оцінка 0–100 вдалу угоду? <ChevronRight size={16}/></summary><p>Ні. Це автоматизована оцінка доступних підтверджень, а не прогноз із гарантованою точністю. Ризик і остаточне рішення залишаються за трейдером.</p></details>
      </div></section>
      <section className="gl-final gl-container"><div className="gl-final-glow"/><span className="gl-kicker">ГОТОВІ ДО ГЛИБШОГО АНАЛІЗУ?</span><h2>Ринок не потрібно переглядати вручну, монету за монетою.</h2><p>Сформуйте власний робочий простір у h00k та перевіряйте сигнали в одному місці.</p><div className="gl-final-ctas"><button type="button" className="gl-btn gl-btn-main" onClick={()=>openAuth('signup')}>Створити акаунт <ArrowRight size={18}/></button><button type="button" className="gl-btn-outline" onClick={enterScreener}>Дивитися без реєстрації</button></div></section>
    </main>
    <SiteFooter/>
    <AuthModal isOpen={authMode!==null} initialMode={authMode||'signin'} onClose={()=>setAuthMode(null)} onSuccess={()=>{setAuthMode(null);window.location.assign('/#screener');}}/>
  </div>;
}

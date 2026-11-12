import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpen, ChevronRight, Layers, Search, ShieldCheck } from 'lucide-react';
import { KOTAPYCH_SETUPS, KOTAPYCH_TOPICS, type KotapychSetup } from './kotapychGuideData';
import type { KotapychSourcePage } from './kotapychArchive';

type Screen = 'overview' | 'setup1' | 'setup2' | 'setup3' | 'setup4' | 'topics' | 'archive';
type SourceName = KotapychSourcePage['source'];

const NAV: Array<{ id: Screen; label: string }> = [
  { id: 'overview', label: 'Огляд' },
  { id: 'setup1', label: 'Сетап №1' },
  { id: 'setup2', label: 'Сетап №2' },
  { id: 'setup3', label: 'Сетап №3' },
  { id: 'setup4', label: 'Сетап №4' },
  { id: 'topics', label: 'Поглиблений аналіз' },
  { id: 'archive', label: 'Повні нотатки' },
];

function Diagram({ setup }: { setup: KotapychSetup['id'] }) {
  const paths: Record<KotapychSetup['id'], string> = {
    setup1: '8,141 31,116 54,70 76,51 97,70 115,63 134,77 151,66 166,105 181,68 204,73 227,59 249,62 270,41 295,42 328,20 352,11',
    setup2: '8,136 38,105 65,79 93,77 113,65 130,70 151,38 173,45 196,48 217,32 232,19 244,44 262,61 279,86 309,99 340,135 352,144',
    setup3: '8,145 45,145 73,131 100,83 120,20 139,34 157,57 181,64 203,44 220,52 235,38 249,64 276,94 308,119 352,145',
    setup4: '8,51 43,45 74,56 100,48 121,83 143,131 164,136 184,128 200,132 220,122 240,126 262,100 281,88 303,73 326,44 351,25',
  };
  return (
    <figure className="rounded-2xl border border-slate-700/70 bg-slate-950/70 px-3 pt-3 pb-2">
      <svg className="w-full h-auto" viewBox="0 0 360 160" role="img" aria-label="Умовна схема розвитку ціни для цього сетапу">
        <defs><pattern id={'kgrid-'+setup} width="25" height="24" patternUnits="userSpaceOnUse">
          <path d="M 25 0 L 0 0 0 24" stroke="#263346" strokeWidth="0.6" fill="none" />
        </pattern></defs>
        <rect width="360" height="160" fill={'url(#kgrid-'+setup+')'} />
        <path d="M 0 60 L 360 60" stroke="#6b7f9f" strokeWidth="1" strokeDasharray="5 5" opacity=".65" />
        <path d="M 0 113 L 360 113" stroke="#6b7f9f" strokeWidth="1" strokeDasharray="5 5" opacity=".65" />
        <polyline points={paths[setup]} fill="none" stroke={setup === 'setup2' || setup === 'setup3' ? '#fb7185' : '#34d399'} strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <figcaption className="text-[10px] text-slate-500 mt-1">Умовна схема логіки, не реальний графік з документа</figcaption>
    </figure>
  );
}

function Lines({ label, lines, color = 'text-sky-300' }: { label: string; lines: string[]; color?: string }) {
  return <section className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5">
    <h5 className={'text-xs font-bold mb-2 ' + color}>{label}</h5>
    <ul className="space-y-2">
      {lines.map((line, index) => <li className="flex gap-2 text-xs leading-relaxed text-slate-300" key={index}>
        <span className="text-slate-600 shrink-0" aria-hidden="true">•</span><span>{line}</span>
      </li>)}
    </ul>
  </section>;
}

function SetupDetails({ setup }: { setup: KotapychSetup }) {
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2">
      <span className={'rounded-lg px-2 py-1 text-[11px] font-extrabold border ' +
        (setup.direction === 'LONG' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' : 'bg-rose-500/15 border-rose-500/30 text-rose-300')}>{setup.direction}</span>
      <span className="text-[11px] text-slate-500">{setup.focus.join(' · ')}</span>
    </div>
    <h4 className="text-base sm:text-lg font-extrabold text-white">Сетап №{setup.number}. {setup.title}</h4>
    <p className="text-xs sm:text-sm leading-relaxed text-slate-200">{setup.summary}</p>
    <Diagram setup={setup.id} />
    <Lines label="1. Ринковий контекст" lines={setup.context} />
    <Lines label="2. Як розпізнати" lines={setup.recognition} color="text-cyan-300" />
    <Lines label="3. Точки входу" lines={setup.entry} color="text-emerald-300" />
    <Lines label="4. Набір і супровід позиції" lines={setup.management} color="text-amber-300" />
    <Lines label="5. Стоп і контроль ризику" lines={setup.stop} color="text-rose-300" />
    <Lines label="6. Цілі та фіксація" lines={setup.targets} color="text-emerald-300" />
    <Lines label="7. Коли сценарій скасовано" lines={setup.cancellation} color="text-rose-300" />
    <p className="text-[11px] text-slate-500 italic">Джерело: {setup.source}</p>
  </div>;
}

export function KotapychGuide() {
  const [screen, setScreen] = useState<Screen>('overview');
  const [topicId, setTopicId] = useState(KOTAPYCH_TOPICS[0].id);
  const [archive, setArchive] = useState<KotapychSourcePage[] | null>(null);
  const [archiveError, setArchiveError] = useState(false);
  const [sourceName, setSourceName] = useState<SourceName>('Копатыч.docx');
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (screen !== 'archive' || archive || archiveError) return;
    let cancelled = false;
    import('./kotapychArchive')
      .then(module => { if (!cancelled) setArchive(module.KOTAPYCH_SOURCE_PAGES); })
      .catch(() => { if (!cancelled) setArchiveError(true); });
    return () => { cancelled = true; };
  }, [screen, archive, archiveError]);

  const sourcePages = useMemo(() => (archive || []).filter(entry => entry.source === sourceName), [archive, sourceName]);
  const matchingPages = useMemo(() => {
    const normalized = query.toLocaleLowerCase('ru').trim();
    return !normalized ? sourcePages : sourcePages.filter(item => item.text.toLocaleLowerCase('ru').includes(normalized));
  }, [sourcePages, query]);
  const selectedPage = matchingPages.find(item => item.page === page) || matchingPages[0];
  const setup = KOTAPYCH_SETUPS.find(item => item.id === screen);
  const topic = KOTAPYCH_TOPICS.find(item => item.id === topicId) || KOTAPYCH_TOPICS[0];

  return <div className="space-y-4" aria-label="Підкатегорія Котапич">
    <div className="rounded-2xl border border-cyan-500/20 bg-gradient-to-r from-cyan-950/50 via-slate-900 to-slate-900 p-3 sm:p-4">
      <div className="flex items-center gap-2 text-cyan-300 text-[11px] font-bold uppercase tracking-wider"><Layers className="w-3.5 h-3.5" /> Скальпінг / Котапич</div>
      <h3 className="text-lg sm:text-xl font-extrabold text-white mt-1">Торгова методика «Котапич»</h3>
      <p className="mt-1 text-xs text-slate-300 leading-relaxed">Чотири сетапи, читання контексту й ліквідності, ризик-менеджмент і повні записи з двох наданих документів.</p>
    </div>
    <div role="tablist" aria-label="Розділи методики Котапич" className="flex flex-wrap gap-1.5">
      {NAV.map(item => <button key={item.id} type="button" role="tab" aria-selected={screen===item.id}
        onClick={() => setScreen(item.id)}
        className={'rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors ' + (screen===item.id
          ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/40'
          : 'bg-slate-950/50 text-slate-400 border-slate-800 hover:bg-slate-800 hover:text-slate-200')}>
        {item.label}
      </button>)}
    </div>

    {screen==='overview' && <div className="space-y-4">
      <p className="text-xs leading-relaxed text-slate-300">Основна ідея: шукати підтверджену реакцію ринку на межі проторговки, оцінювати швидкість руху, обсяги та поведінку покупців і продавців. Прокол ліквідності — лише частина контексту.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {KOTAPYCH_SETUPS.map(item => <button type="button" key={item.id} onClick={()=>setScreen(item.id)} className="text-left rounded-xl border border-slate-700/70 bg-slate-950/60 hover:border-cyan-500/50 p-3 transition-colors">
          <span className={'text-[10px] font-extrabold ' + (item.direction==='LONG'?'text-emerald-300':'text-rose-300')}>{item.direction} · СЕТАП №{item.number}</span>
          <h4 className="font-bold text-sm text-white mt-1">{item.title}</h4>
          <p className="text-xs text-slate-400 mt-1 line-clamp-3 leading-relaxed">{item.summary}</p>
          <span className="mt-2 flex items-center text-cyan-300 text-[11px]">Відкрити аналіз <ChevronRight className="w-3.5 h-3.5" /></span>
        </button>)}
      </div>
      <Lines label="Спільні принципи" color="text-cyan-300" lines={[
        'Старший таймфрейм і попередній рух важливіші за красивий локальний патерн.',
        'Прокол рівня сам по собі не підтверджує угоду: потрібні повернення, утримання й динаміка.',
        'Автор описує набір частинами, застерігає від усереднення збитків і радить спершу зібрати статистику.',
        'Чотири сетапи — це авторська інтерпретація ринку, а не гарантія прибутку.',
      ]} />
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 flex gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
        <p className="text-xs leading-relaxed text-slate-300">Відсотки прибутковості та співвідношення R:R у файлах — особисті приклади автора, не підтверджені бектестом. Ризик кожної угоди розраховується окремо.</p>
      </div>
    </div>}

    {setup && <SetupDetails setup={setup} />}

    {screen==='topics' && <div className="space-y-3">
      <p className="text-xs text-slate-400 leading-relaxed">Додаткові пояснення з великого документа, згруповані за темами без зміни авторської логіки.</p>
      <div className="flex flex-wrap gap-1.5">{KOTAPYCH_TOPICS.map(item=>
        <button type="button" key={item.id} onClick={()=>setTopicId(item.id)}
          className={'rounded-md border px-2.5 py-1.5 text-[11px] ' + (topicId===item.id?'border-indigo-400/50 text-indigo-200 bg-indigo-500/20':'border-slate-700 text-slate-400 hover:text-white')}>
          {item.title}
        </button>)}</div>
      <h4 className="text-base text-white font-extrabold">{topic.title}</h4>
      <p className="text-xs text-slate-400">{topic.summary}</p>
      <Lines label="Основні висновки з нотаток" lines={topic.points} />
      <div className="flex flex-wrap gap-1.5 items-center"><span className="text-[11px] text-slate-500 mr-1">Сторінки нотаток:</span>
        {topic.notePages.map(n=><button key={n} type="button" onClick={()=>{setSourceName('Копатыч.docx');setPage(n);setQuery('');setScreen('archive');}}
          className="text-[11px] px-2 py-1 border border-slate-700 rounded-md hover:border-cyan-600 text-slate-300">{n}</button>)}
      </div>
    </div>}

    {screen==='archive' && <div className="space-y-3">
      <div className="flex items-center gap-2 text-slate-200"><BookOpen className="w-4 h-4" /><h4 className="font-bold text-sm">Повний текст наданих матеріалів</h4></div>
      <p className="text-[11px] text-slate-400 leading-relaxed">Оригінальний російськомовний текст збережено за сторінками, без редагування формулювань. Два документи мають також фотографії графіків; тут подано їхній текстовий вміст і окремі умовні схеми сетапів, а не копії всіх зображень.</p>
      <div className="flex flex-wrap gap-2">
        {(['Копатыч.docx','4 set.docx'] as SourceName[]).map(name=>
          <button key={name} type="button" onClick={()=>{setSourceName(name);setPage(1);setQuery('');}}
            className={'px-3 py-2 rounded-lg border text-xs ' + (name===sourceName?'bg-cyan-500/20 border-cyan-500/40 text-cyan-200':'border-slate-700 bg-slate-950 text-slate-300')}>
            {name} <span className="text-slate-500">· {name==='Копатыч.docx'?'79':'8'} с.</span>
          </button>)}
      </div>
      <label className="relative block">
        <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
        <input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Пошук у вибраному документі…" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 pl-9 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500" />
      </label>
      {archiveError && <div role="alert" className="text-rose-300 text-xs">Не вдалося завантажити архів. Перевір підключення та перезавантаж сторінку.</div>}
      {!archive && !archiveError && <div role="status" className="text-slate-400 text-xs">Завантажуємо повні нотатки…</div>}
      {archive && <>
        <p className="text-[11px] text-slate-500">Знайдено сторінок: {matchingPages.length} із {sourcePages.length}. Вибери сторінку для читання.</p>
        <div className="flex flex-wrap gap-1 max-h-36 overflow-y-auto rounded-lg border border-slate-800 p-2">
          {matchingPages.map(item=><button type="button" key={item.page} onClick={()=>setPage(item.page)}
            aria-pressed={selectedPage?.page===item.page}
            className={'min-w-8 h-8 px-1 rounded-md text-[11px] font-semibold ' + (page===item.page?'bg-cyan-500/20 text-cyan-200 border border-cyan-500/50':'bg-slate-900 text-slate-400 border border-slate-800 hover:text-white')}>
            {item.page}
          </button>)}
        </div>
        {!matchingPages.length && <p className="text-xs text-slate-400">Збігів не знайдено. Спробуй інший запит.</p>}
        {selectedPage && <article className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 sm:p-4">
          <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2 mb-3">
            <h5 className="text-xs font-bold text-white">{sourceName} · сторінка {selectedPage.page}</h5>
            <span className="text-[10px] text-slate-500">Оригінал</span>
          </div>
          {selectedPage.text
            ? <p lang="ru" className="whitespace-pre-wrap break-words text-xs leading-6 text-slate-300">{selectedPage.text}</p>
            : <p className="text-xs text-slate-400">На сторінці графічний приклад без окремого тексту. Дивись оригінальний документ.</p>}
          <div className="flex justify-between gap-2 mt-4">
            <button type="button" disabled={matchingPages.findIndex(item=>item.page===selectedPage.page)<=0} onClick={()=>setPage(matchingPages[Math.max(0,matchingPages.findIndex(item=>item.page===selectedPage.page)-1)].page)} className="disabled:opacity-30 text-xs px-2.5 py-1.5 border border-slate-700 rounded-lg">Попередня</button>
            <button type="button" disabled={matchingPages.findIndex(item=>item.page===selectedPage.page)>=matchingPages.length-1} onClick={()=>setPage(matchingPages[Math.min(matchingPages.length-1,matchingPages.findIndex(item=>item.page===selectedPage.page)+1)].page)} className="disabled:opacity-30 text-xs px-2.5 py-1.5 border border-slate-700 rounded-lg">Наступна</button>
          </div>
        </article>}
      </>}
    </div>}

    <div className="flex items-center gap-2 pt-3 border-t border-slate-800 text-[11px] text-slate-500">
      <ShieldCheck className="w-3.5 h-3.5 text-slate-500" /> Навчальна енциклопедія. Не є індивідуальною інвестиційною рекомендацією.
    </div>
  </div>;
}

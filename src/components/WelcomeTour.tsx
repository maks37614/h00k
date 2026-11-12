import React, { useEffect, useState } from 'react';
import { ArrowRight, BarChart3, Bell, Check, ChevronLeft, Clock3, Crosshair, Grid2X2, Layers3, Radar, ShieldCheck, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ActivePageType } from '../types';

type TourStep = {
  title: string; text: string; where: string; icon: LucideIcon; page?: ActivePageType;
};
const steps: TourStep[] = [
  { title: 'Ласкаво просимо до h00k', text: 'У верхньому меню розміщені головні розділи. Почніть зі Скрінера: тут можна знайти монети за зміною ціни, обсягом, біржею та іншими параметрами.', where: 'Верхнє меню → Скрінер', icon: Radar, page: 'screener' },
  { title: 'Знайдіть формації', text: 'У розділі «Формації» зібрані автоматично знайдені сценарії, оцінка якості до 100 балів та раннє виявлення потенційних W/M.', where: 'Верхнє меню → Формації', icon: Layers3, page: 'patterns' },
  { title: 'Відкрийте HookChart', text: 'Натисніть на монету або її графік. У HookChart можна переглянути рівні, щільності, ліквідації та змінити вигляд графіка під себе.', where: 'Монета → Іконка графіка', icon: Crosshair },
  { title: 'Порівнюйте кілька графіків', text: 'У Терміналі розмістіть потрібні монети одночасно, оберіть сітку та розміри блоків — усе на одному екрані.', where: 'Верхнє меню → Термінал', icon: Grid2X2, page: 'terminal' },
  { title: 'Перевіряйте ідеї у Відтворенні', text: 'У режимі відтворення можна програвати історичні свічки та випробовувати тестові входи, стопи й цілі без реальної угоди.', where: 'Верхнє меню → Відтворення', icon: Clock3, page: 'replay' },
  { title: 'Налаштуйте спостереження', text: 'Створюйте умови моніторингу монет і Telegram-сповіщення. У профілі також доступні власні налаштування, обране та лінковка MetaScalp.', where: 'Шапка → Сповіщення / Профіль', icon: Bell, page: 'surveillance' },
];
export function WelcomeTour({ onFinish, onNavigate }: {
  onFinish: () => void;
  onNavigate: (page: ActivePageType) => void;
}) {
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const Icon = step.icon;
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onFinish();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onFinish]);
  return <div className="fixed inset-0 z-[75] bg-[#020916]/70 backdrop-blur-[3px] flex items-end sm:items-center justify-center p-3 sm:p-5" role="presentation">
    <section role="dialog" aria-modal="true" aria-labelledby="h00k-tour-title" className="relative w-full max-w-[480px] rounded-2xl border border-cyan-500/40 bg-gradient-to-br from-[#12263b] to-[#0a1220] p-5 sm:p-7 shadow-2xl shadow-black/60">
      <button type="button" onClick={onFinish} aria-label="Пропустити ознайомлення" className="absolute right-4 top-4 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"><X size={18}/></button>
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-cyan-400"><ShieldCheck size={15}/> Перший запуск · {index + 1} / {steps.length}</div>
      <div className="mt-5 flex h-12 w-12 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-300"><Icon size={24}/></div>
      <h2 id="h00k-tour-title" className="mt-4 pr-5 text-xl font-extrabold text-white">{step.title}</h2>
      <p className="mt-3 text-sm leading-7 text-slate-300">{step.text}</p>
      <div className="mt-5 flex items-center gap-2 rounded-xl border border-slate-700/70 bg-slate-950/65 px-3 py-3 text-xs text-cyan-200"><BarChart3 size={15} className="shrink-0"/><span><strong>Де знайти:</strong> {step.where}</span></div>
      {step.page && <button type="button" className="mt-3 text-xs font-semibold text-sky-300 hover:text-white hover:underline" onClick={() => onNavigate(step.page!)}>Показати цей розділ →</button>}
      <div className="mt-6 flex gap-1.5" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={index + 1} aria-label="Крок ознайомлення">{steps.map((_, i) => <span key={i} className={'h-1.5 flex-1 rounded-full ' + (i <= index ? 'bg-cyan-400' : 'bg-slate-700')} />)}</div>
      <div className="mt-6 flex items-center justify-between gap-3">
        <button type="button" onClick={onFinish} className="text-xs font-medium text-slate-400 hover:text-white">Пропустити</button>
        <div className="flex items-center gap-2">
          {index > 0 && <button type="button" onClick={() => setIndex(i => i - 1)} className="rounded-xl border border-slate-600 bg-slate-800 px-3 py-2.5 text-xs font-semibold text-white"><ChevronLeft size={16}/></button>}
          <button type="button" autoFocus onClick={() => index === steps.length - 1 ? onFinish() : setIndex(i => i + 1)} className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 to-blue-500 px-4 py-2.5 text-xs font-extrabold text-slate-950">{index === steps.length - 1 ? <>Завершити <Check size={16}/></> : <>Далі <ArrowRight size={16}/></>}</button>
        </div>
      </div>
    </section>
  </div>;
}

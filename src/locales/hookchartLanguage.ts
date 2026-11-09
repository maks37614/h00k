import uk from './hookchart/uk.json';
import en from './hookchart/en.json';
import ru from './hookchart/ru.json';
import pl from './hookchart/pl.json';
import { normalizeLanguage, translatePhrase, type SupportedLanguage } from './index';
import type { HookChartPreferences } from '../types';

/** Original, user-supplied dictionaries; their keys are phrases, not executable code. */
export const hookChartLanguagePacks: Record<SupportedLanguage, Record<string, string>> = { uk, en, ru, pl };

// These controls were added after the supplied packs. Keep the original JSON files intact.
const additions = [
  ['Перехрестя', 'Crosshair', 'Перекрестие', 'Krzyżyk'],
  ['Товщина ліній', 'Line width', 'Толщина линий', 'Grubość linii'],
  ['Горизонтальна та вертикальна лінії курсора.', 'Horizontal and vertical cursor lines.', 'Горизонтальная и вертикальная линии курсора.', 'Pozioma i pionowa linia kursora.'],
  ['Живий стакан вимкнено у відтворенні', 'Live order book is disabled in replay', 'Живой стакан отключён в воспроизведении', 'Arkusz na żywo jest wyłączony podczas odtwarzania'],
  ['Біржовий стакан недоступний', 'Exchange order book unavailable', 'Биржевой стакан недоступен', 'Arkusz zleceń giełdy jest niedostępny'],
  ['Відновлення стакана', 'Reconnecting order book', 'Восстановление стакана', 'Ponowne łączenie arkusza zleceń'],
  ['Синхронізація стакана', 'Synchronizing order book', 'Синхронизация стакана', 'Synchronizacja arkusza zleceń'],
  ['Підключення стакана', 'Connecting order book', 'Подключение стакана', 'Łączenie arkusza zleceń'],
  ['Множник порогу AUTO', 'AUTO threshold multiplier', 'Множитель порога AUTO', 'Mnożnik progu AUTO'],
  ['Недостатньо рівнів для AUTO', 'Not enough levels for AUTO', 'Недостаточно уровней для AUTO', 'Za mało poziomów dla AUTO'],
  ['Очікування даних', 'Waiting for data', 'Ожидание данных', 'Oczekiwanie na dane'],
  ['Поріг щільностей (USDT)', 'Density threshold (USDT)', 'Порог плотностей (USDT)', 'Próg zleceń (USDT)'],
  ['Дистанція від ціни', 'Distance from price', 'Дистанция от цены', 'Odległość od ceny'],
  ['Дистанція щільностей (%)', 'Density distance (%)', 'Дистанция плотностей (%)', 'Odległość zleceń (%)'],
  ['Стакан наживо', 'Live order book', 'Стакан в реальном времени', 'Arkusz zleceń na żywo'],
  ['Очікування стакана', 'Waiting for order book', 'Ожидание стакана', 'Oczekiwanie na arkusz zleceń'],
  ['У межах доступної глибини стакана біржі.', 'Within the exchange’s available order-book depth.', 'В пределах доступной глубины стакана биржи.', 'W granicach dostępnej głębokości arkusza giełdy.'],
  ['Відступ праворуч', 'Right margin', 'Отступ справа', 'Odstęp po prawej'],
  ['Вільне місце після останньої свічки перед шкалою цін.', 'Empty space after the last candle before the price scale.', 'Свободное место после последней свечи перед шкалой цен.', 'Wolne miejsce za ostatnią świecą przed skalą cen.'],
  ['Розмір відступу праворуч, від 0 до 500 свічок.', 'Right margin size, from 0 to 500 candles.', 'Размер отступа справа, от 0 до 500 свечей.', 'Wielkość odstępu po prawej, od 0 do 500 świec.'],
  ['Увімкніть обидва перемикачі, щоб показати повну сітку.', 'Enable both switches to show the full grid.', 'Включите оба переключателя, чтобы показать полную сетку.', 'Włącz oba przełączniki, aby wyświetlić pełną siatkę.'],
  ['свічок', 'candles', 'свечей', 'świec'],
] as const;
const languages: SupportedLanguage[] = ['uk', 'en', 'ru', 'pl'];
const dictionaries = Object.fromEntries(languages.map((language, index) => [language, {
  ...Object.fromEntries(additions.map(row => [row[0], row[index]])),
  ...hookChartLanguagePacks[language],
}])) as Record<SupportedLanguage, Record<string, string>>;

// The imported packs use original Russian/English keys; the integrated UI also uses
// Ukrainian phrases. Accept every language's values so already-rendered text can switch.
const keys = [...new Set(Object.values(dictionaries).flatMap(dictionary => Object.keys(dictionary)))];
const aliases = new Map<string, string>();
for (const key of keys) for (const dictionary of Object.values(dictionaries)) {
  const value = dictionary[key]?.trim();
  if (value && !aliases.has(value)) aliases.set(value, key);
}
for (const key of keys) aliases.set(key.trim(), key);

export function translateHookChartPhrase(language: SupportedLanguage, input: string): string {
  const key = aliases.get(input.trim());
  const translated = key ? (dictionaries[language][key] ?? dictionaries.uk[key]) : undefined;
  if (translated !== undefined) {
    return `${input.match(/^\s*/)?.[0] || ''}${translated}${input.match(/\s*$/)?.[0] || ''}`;
  }
  return translatePhrase(language, input);
}

export function resolveHookChartLanguage(preferences: HookChartPreferences | undefined, siteLanguage: SupportedLanguage): SupportedLanguage {
  // A later site selection supersedes a chart-specific choice, including when the
  // chart was closed during the site change. Old, inactive language preferences migrate here.
  return preferences?.siteLanguageAtSelection === siteLanguage && preferences.language
    ? normalizeLanguage(preferences.language) : siteLanguage;
}

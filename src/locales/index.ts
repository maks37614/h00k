import uk from './uk';
import en from './en';
import ru from './ru';
import pl from './pl';
import type { LocaleFile, LocaleParams, SupportedLanguage } from './types';
import hookchartPhrases from './hookchartPhrases';

export type { LocaleFile, LocaleParams, SupportedLanguage } from './types';

export const locales: Record<SupportedLanguage, LocaleFile> = { uk, en, ru, pl };

for (const language of Object.keys(locales) as SupportedLanguage[]) {
  locales[language].phrases = {
    ...locales[language].phrases,
    ...hookchartPhrases[language],
  };
}

export const supportedLanguages = Object.keys(locales) as SupportedLanguage[];

export function normalizeLanguage(value?: string | null): SupportedLanguage {
  return supportedLanguages.includes(value as SupportedLanguage) ? value as SupportedLanguage : 'uk';
}

export function interpolate(template: string, params: LocaleParams = {}): string {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, key: string) => {
    const value = params[key];
    return value === null || value === undefined ? '' : String(value);
  });
}

export function translateKey(language: SupportedLanguage, key: string, params?: LocaleParams): string {
  const value = locales[language]?.strings[key] ?? locales.uk.strings[key] ?? key;
  return interpolate(value, params);
}

export function telegramText(language: SupportedLanguage, key: string, params?: LocaleParams): string {
  const value = locales[language]?.telegram[key] ?? locales.uk.telegram[key] ?? key;
  return interpolate(value.replace(/\\r\\n|\\n|\\r/g, '\n'), params);
}

const semanticAliases = new Map<string, string>();
for (const key of Object.keys(locales.uk.strings)) {
  for (const locale of Object.values(locales)) {
    const value = locale.strings[key]?.trim();
    if (value) semanticAliases.set(value, key);
  }
}

const phraseAliases = new Map<string, string>();
for (const source of Object.keys(locales.uk.phrases)) {
  phraseAliases.set(source.trim(), source);
  for (const locale of Object.values(locales)) {
    const value = locale.phrases[source]?.trim();
    if (value) phraseAliases.set(value, source);
  }
}

export function translatePhrase(language: SupportedLanguage, input: string): string {
  if (!input) return input;
  const leading = input.match(/^\s*/)?.[0] ?? '';
  const trailing = input.match(/\s*$/)?.[0] ?? '';
  const trimmed = input.trim();
  if (!trimmed) return input;

  const semanticKey = semanticAliases.get(trimmed);
  if (semanticKey) return leading + (locales[language].strings[semanticKey] ?? trimmed) + trailing;

  const phraseKey = phraseAliases.get(trimmed);
  if (phraseKey) return leading + (locales[language].phrases[phraseKey] ?? phraseKey) + trailing;

  return input;
}

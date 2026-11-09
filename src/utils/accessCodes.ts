/**
 * Author Access & Registration Codes System
 * Codes can only be obtained from the author's Telegram channel.
 * Registration works without email verification.
 */

// Official Telegram channel link of the author
export const AUTHOR_TELEGRAM_CHANNEL_URL = 'https://t.me/hookprofi';
export const AUTHOR_TELEGRAM_USERNAME = '@hookprofi';

export interface CodeVerificationResult {
  valid: boolean;
  normalizedCode: string;
  message?: string;
}

/**
 * Normalizes an access code (trims whitespace, converts to uppercase)
 */
export function normalizeAccessCode(code: string): string {
  return (code || '').trim().toUpperCase();
}

/**
 * Validates an author invite code through the server. Valid codes stay server-side.
 */
export async function verifyAccessCode(code: string): Promise<CodeVerificationResult> {
  const clean = normalizeAccessCode(code);

  if (!clean) {
    return {
      valid: false,
      normalizedCode: '',
      message: 'Будь ласка, введіть спеціальний код доступу.',
    };
  }

  // Try server verification first. If it is unavailable, fail closed.
  try {
    const res = await fetch('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: clean }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.valid === 'boolean') {
        return {
          valid: data.valid,
          normalizedCode: clean,
          message: data.valid
            ? 'Код успішно підтверджено!'
            : 'Невірний спеціальний код доступу. Отримайте дійсний код у Telegram каналі автора.',
        };
      }
    }
  } catch {}

  return {
    valid: false,
    normalizedCode: clean,
    message:
      'Невірний спеціальний код доступу. Незареєстровані користувачі можуть отримати код тільки від автора у його Telegram каналі.',
  };
}

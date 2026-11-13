import React from 'react';

interface Props { children: React.ReactNode; onClose: () => void }
interface State { failed: boolean }

/** Prevent a failed browser audio/IndexedDB interaction from blanking the entire profile modal. */
export class ProfileNotificationsErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State { return { failed: true }; }

  componentDidCatch(error: Error): void {
    console.error('Failed to render profile notification settings:', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section role="alert" className="space-y-3 rounded-xl border border-rose-500/40 bg-slate-950 p-5 text-sm text-slate-200">
        <h3 className="font-semibold text-rose-300">Не вдалося відкрити налаштування сповіщень.</h3>
        <p className="text-xs text-slate-400">
          Можливо, браузер перервав обробку аудіофайлу. Збережені налаштування не видалено.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => this.setState({ failed: false })}
            className="rounded-lg border border-cyan-600 px-3 py-2 text-cyan-300">Спробувати ще раз</button>
          <button type="button" onClick={this.props.onClose}
            className="rounded-lg border border-slate-600 px-3 py-2">Закрити профіль</button>
        </div>
      </section>
    );
  }
}

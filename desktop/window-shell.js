'use strict';
const actions = new Set(['settings', 'minimize', 'toggle-maximize', 'close']);
document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (actions.has(action)) window.h00kShell?.command(action);
  });
});
const maximize = document.getElementById('maximize');
window.h00kShell?.onState(state => {
  const label = state?.maximized ? 'Відновити' : 'Розгорнути';
  maximize.title = label;
  maximize.setAttribute('aria-label', label);
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === ',') {
    event.preventDefault();
    window.h00kShell?.command('settings');
  }
});

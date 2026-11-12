import {StrictMode, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { GuestLanding } from './components/GuestLanding';
import { shouldShowGuestLanding } from './utils/guestEntry';
import { LegalPage } from './components/LegalPage';
import './index.css';
import './components/replay/replayCoinPicker.css';
import './components/terminal/addChartModal.css';
import './components/watchlistDrawer.css';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AlertsProvider } from './context/AlertsContext';
import { ArchiveProvider } from './context/ArchiveContext';
import { SurveillanceProvider } from './context/SurveillanceContext';
import { LanguageProvider } from './context/LanguageContext';
import { TelegramProvider } from './context/TelegramContext';
import { installChunkRecovery } from './utils/chunkRecovery';

installChunkRecovery(window);

const legalPath = window.location.pathname.replace(/\/+$/, '');
const publicLegalPage = legalPath === '/terms' ? 'terms' : legalPath === '/privacy' ? 'privacy' : null;

/** Public landing is the default for logged-out visitors; #screener preserves guest table access. */
function Entry() {
  const { user } = useAuth();
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return shouldShowGuestLanding(legalPath, hash, Boolean(user)) ? <GuestLanding /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <AlertsProvider>
        <ArchiveProvider>
          <SurveillanceProvider>
            <LanguageProvider>
              <TelegramProvider>
                {publicLegalPage ? <LegalPage page={publicLegalPage} /> : <Entry />}
              </TelegramProvider>
            </LanguageProvider>
          </SurveillanceProvider>
        </ArchiveProvider>
      </AlertsProvider>
    </AuthProvider>
  </StrictMode>,
);

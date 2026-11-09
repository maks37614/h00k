import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { LegalPage } from './components/LegalPage';
import './index.css';
import { AuthProvider } from './context/AuthContext';
import { AlertsProvider } from './context/AlertsContext';
import { ArchiveProvider } from './context/ArchiveContext';
import { SurveillanceProvider } from './context/SurveillanceContext';
import { LanguageProvider } from './context/LanguageContext';
import { TelegramProvider } from './context/TelegramContext';

const legalPath = window.location.pathname.replace(/\/+$/, '');
const publicLegalPage = legalPath === '/terms' ? 'terms' : legalPath === '/privacy' ? 'privacy' : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <AlertsProvider>
        <ArchiveProvider>
          <SurveillanceProvider>
            <LanguageProvider>
              <TelegramProvider>
                {publicLegalPage ? <LegalPage page={publicLegalPage} /> : <App />}
              </TelegramProvider>
            </LanguageProvider>
          </SurveillanceProvider>
        </ArchiveProvider>
      </AlertsProvider>
    </AuthProvider>
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { LOCKED, LOCK_F } from './edition';
import { GrblController } from './grbl/controller';
import { limitLine } from './mobile/limit';

// Публичная версия: ни одна команда не уходит на машину быстрее LOCK_F, «скорость +» на ходу запрещена
if (LOCKED) {
  GrblController.lineFilter = (l) => limitLine(l, LOCK_F);
  for (const b of [0x91, 0x93]) GrblController.blockedRealtime.add(b);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Офлайн-режим (PWA): после первой загрузки программа работает без интернета
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !import.meta.env.DEV) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

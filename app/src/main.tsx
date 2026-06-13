import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

const harness = new URLSearchParams(location.search).get('harness');
if (import.meta.env.DEV && harness) {
  // Dev-only render harnesses (compositor/post-fx/procedural). Lazily imported so they
  // never reach the production bundle.
  import('./dev/Harness').then(({ mountHarness }) => mountHarness(rootEl));
} else {
  createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const rootElement = document.getElementById('root');

// Mobile Debugging: Catch global errors and display them on screen
// This prevents the "White Screen of Death" on mobile devices
window.onerror = function(message, source, lineno, colno, error) {
  if (rootElement) {
    // Only show error overlay if the app hasn't mounted or crashes completely
    const errorHtml = `
      <div style="position:fixed; top:0; left:0; width:100%; height:100%; background:black; color:red; padding:20px; z-index:9999; overflow:auto; font-family:monospace;">
        <h2 style="color:white; border-bottom:1px solid #333; padding-bottom:10px;">Application Error</h2>
        <p style="font-size: 14px; margin-top: 10px;">${message}</p>
        <p style="color:#666; font-size: 12px;">${source}:${lineno}:${colno}</p>
        <pre style="background:#111; padding:10px; margin-top:10px; white-space:pre-wrap; font-size: 10px; color: #ff8888;">${error?.stack || 'No stack trace'}</pre>
        <button onclick="window.location.reload()" style="margin-top:20px; padding:10px 20px; background:#333; color:white; border:none; border-radius:4px;">Reload Page</button>
      </div>
    `;
    // We append instead of replace to ensure we don't wipe out partial renders if not needed, 
    // but for critical errors, an overlay is best.
    const div = document.createElement('div');
    div.innerHTML = errorHtml;
    document.body.appendChild(div);
  }
  return false;
};

if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

try {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} catch (e) {
  console.error("Mount Error:", e);
  if (rootElement) {
      rootElement.innerHTML = `<div style="color:red; padding:20px;"><h1>Failed to mount App</h1><pre>${e}</pre></div>`;
  }
}
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function App() {
  return (
    <main className="shell">
      <p className="eyebrow">MINICART / CHECKOUT</p>
      <h1>Your cart, ready when you are.</h1>
      <p className="lede">A React client for the MiniCart API. Product browsing and checkout screens plug into the server-side cart and idempotent order flow.</p>
      <a className="action" href="/api/products">Browse products</a>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Algorithm = 'fixed-window' | 'sliding-window-log' | 'sliding-window-counter' | 'token-bucket' | 'leaky-bucket';
type Event = { allowed: boolean; remaining: number; retryAfterMs: number; timestamp: number };

const labels: Record<Algorithm, string> = {
  'fixed-window': 'Fixed window',
  'sliding-window-log': 'Sliding window log',
  'sliding-window-counter': 'Sliding window counter',
  'token-bucket': 'Token bucket',
  'leaky-bucket': 'Leaky bucket',
};

function App() {
  const [algorithm, setAlgorithm] = useState<Algorithm>('token-bucket');
  const [limit, setLimit] = useState(5);
  const [windowMs, setWindowMs] = useState(10_000);
  const [capacity, setCapacity] = useState(5);
  const [ratePerSecond, setRate] = useState(1);
  const [events, setEvents] = useState<Event[]>([]);
  const [sending, setSending] = useState(false);
  const clientId = useMemo(() => crypto.randomUUID(), []);

  const send = async (count = 1) => {
    setSending(true);
    const next: Event[] = [];
    for (let index = 0; index < count; index += 1) {
      const response = await fetch('/api/demo/consume', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm, limit, windowMs, capacity, ratePerSecond, clientId }),
      });
      next.push(await response.json());
    }
    setEvents((old) => [...old, ...next].slice(-40));
    setSending(false);
  };

  const allowed = events.filter((event) => event.allowed).length;
  const denied = events.length - allowed;
  const bucketAlgorithm = algorithm === 'token-bucket' || algorithm === 'leaky-bucket';
  const meterSize = bucketAlgorithm ? capacity : limit;

  return <main>
    <section className="hero"><p className="eyebrow">LIVE API LAB</p><h1>Rate limiter visualizer</h1><p>Send requests, tune the rule, and watch the backend decide.</p></section>
    <section className="layout">
      <aside className="controls"><label>Algorithm<select value={algorithm} onChange={(e) => { setAlgorithm(e.target.value as Algorithm); setEvents([]); }}>{Object.entries(labels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label>Request limit<input type="number" min="1" value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></label>
        <label>Window (ms)<input type="number" min="100" step="100" value={windowMs} onChange={(e) => setWindowMs(Number(e.target.value))} /></label>
        {bucketAlgorithm && <><label>Bucket capacity<input type="number" min="1" value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} /></label><label>{algorithm === 'token-bucket' ? 'Refill' : 'Leak'} / second<input type="number" min="0.1" step="0.1" value={ratePerSecond} onChange={(e) => setRate(Number(e.target.value))} /></label></>}
        <div className="buttons"><button disabled={sending} onClick={() => send()}>Send one</button><button className="secondary" disabled={sending} onClick={() => send(10)}>Burst ×10</button><button className="quiet" onClick={() => setEvents([])}>Clear</button></div>
      </aside>
      <section className="visual"><div className="stats"><article><span>Allowed</span><strong>{allowed}</strong></article><article><span>Rejected</span><strong>{denied}</strong></article><article><span>Remaining</span><strong>{events.at(-1)?.remaining ?? limit}</strong></article></div>
        <div className={`bucket ${algorithm}`}><div className="bucket-title">{labels[algorithm]}</div><div className="slots">{Array.from({ length: Math.min(meterSize, 20) }, (_, index) => <i key={index} className={index < (events.at(-1)?.remaining ?? meterSize) ? 'filled' : ''} />)}</div><p>{bucketAlgorithm ? 'Filled cells show currently available capacity.' : 'Each mark below is a real response from the API.'}</p></div>
        <div className="timeline">{events.length === 0 ? <p className="empty">No requests yet. Send one or trigger a burst.</p> : events.map((event, index) => <div className={event.allowed ? 'event allow' : 'event deny'} key={`${event.timestamp}-${index}`} title={event.allowed ? 'Allowed' : `Retry in ${event.retryAfterMs}ms`}>{event.allowed ? '✓' : '×'}</div>)}</div>
      </section>
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);

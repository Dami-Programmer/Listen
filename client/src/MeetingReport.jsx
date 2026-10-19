// The meeting report (host / co-host): who came and when, who spoke and for
// how long, hands raised and turns given — so a teacher can see who never got
// a word in, or a debate can check both sides had equal time. Talk time comes
// from each person's own "speaking" pings (their mic level), so it's real
// talking, not just time holding the floor.
//
//   <ReportDialog />  live, from the people list during the meeting
//   <ReportTable />   the table itself (also on the "You left" screen)
//   fetchReport()     (report.js) ask the server for it now

import { useEffect, useState } from 'react';
import { fetchReport } from './report.js';
import { Download, FileDoc, X } from './icons.jsx';

// While the dialog is open, refresh this often.
const REFRESH_MS = 5000;

const clockOf = (ts) =>
  ts ? new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
const talkOf = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// The report as a spreadsheet file (opens in Excel / Google Sheets).
function downloadCsv(report) {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [
    ['Name', 'Joined', 'Left', 'Talked (min:sec)', 'Hands raised', 'Turns given'],
    ...report.people.map((p) => [
      p.name,
      clockOf(p.firstJoined),
      p.present ? 'still here' : clockOf(p.lastLeft),
      talkOf(p.talkMs),
      p.hands,
      p.turns,
    ]),
  ];
  const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `${report.title || 'Turnly meeting'} report.csv`.replace(/[\\/:*?"<>|]/g, '_'),
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The table, plus a one-line summary and a download button. */
export function ReportTable({ report }) {
  const total = report.people.reduce((sum, p) => sum + p.talkMs, 0);
  const minutes = Math.max(1, Math.round((report.now - report.startedAt) / 60000));
  return (
    <div className="report">
      <p className="report-sum">
        {report.people.length} {report.people.length === 1 ? 'person' : 'people'} · {minutes} min ·{' '}
        {talkOf(total)} of talking
      </p>
      <div className="report-scroll">
        <table className="report-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Joined</th>
              <th>Left</th>
              <th>Talked</th>
              <th title="Hands raised">✋</th>
              <th title="Turns given">🎤</th>
            </tr>
          </thead>
          <tbody>
            {report.people.map((p) => (
              <tr key={p.name}>
                <td className="report-name">
                  <span className="report-bar-wrap">
                    {p.name}
                    {/* each person's share of the talking, as a thin bar */}
                    <span
                      className="report-bar"
                      style={{ width: `${total ? Math.round((p.talkMs / total) * 100) : 0}%` }}
                    />
                  </span>
                </td>
                <td>{clockOf(p.firstJoined)}</td>
                <td>{p.present ? 'here' : clockOf(p.lastLeft)}</td>
                <td>{talkOf(p.talkMs)}</td>
                <td>{p.hands}</td>
                <td>{p.turns}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="qa-act report-dl" onClick={() => downloadCsv(report)}>
        <Download /> Download (spreadsheet)
      </button>
    </div>
  );
}

/** The live report in a pop-up, refreshed while it's open. */
export function ReportDialog({ onClose }) {
  const [report, setReport] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      const r = await fetchReport();
      if (stop) return;
      if (r) setReport(r);
      else setFailed(true);
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      stop = true;
      clearInterval(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div
        className="confirm-card report-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* icon tile · title + one grey line · round ✕ */}
        <div className="report-head dlg-head">
          <span className="dlg-icon" aria-hidden="true">
            <FileDoc />
          </span>
          <div className="dlg-head-text">
            <h2 id="report-title" className="confirm-title">
              Meeting report
            </h2>
            <p className="dlg-sub">Who came, when they left, and how much each person talked.</p>
          </div>
          <button type="button" className="report-x" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        {report ? (
          <ReportTable report={report} />
        ) : (
          <p className="confirm-msg">{failed ? 'Couldn’t load the report.' : 'Loading…'}</p>
        )}
      </div>
    </div>
  );
}

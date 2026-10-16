// The error screen. If any part of a page crashes while drawing, React would
// otherwise remove the whole page and leave the visitor staring at a blank
// screen. This catches the crash instead, reports it (errorReport.js), and
// shows "Something went wrong" with a way back:
//   - in a meeting: Rejoin (reloads the page, which keeps the room in the
//     address, so you land back at that meeting's door)
//   - anywhere else: Reload
//   - plus "Go to the home page" (not on the landing page itself)
//
// Inside the landing page's live demo it also tells the landing page, which
// then shows its own "Couldn't start the demo · Try again" (LandingDemos.jsx).
//
// It has to be a class component: only those can catch errors (React has no
// hook for it). It catches crashes while DRAWING the page; errors in clicks or
// network callbacks don't blank the page, and errorReport.js reports those.

import { Component } from 'react';
import Logo from './Logo.jsx';
import { reportError } from './errorReport.js';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    // which component crashed: the first line of React's component trail
    const where = info?.componentStack
      ?.trim()
      .split('\n')[0]
      ?.trim()
      .replace(/^at\s+/, '')
      .slice(0, 120);
    reportError('crash', error, where ? { where } : undefined);
    if (this.props.page === 'demo' && window.parent !== window) {
      window.parent.postMessage({ type: 'turnly-demo-failed' }, window.location.origin);
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const { page } = this.props;
    return (
      <main className="left-screen crash-screen">
        <Logo />
        <div className="left-card" role="alert">
          <h1>Something went wrong</h1>
          <p>
            Sorry, Turnly hit a problem and couldn’t show this page. It’s been reported so it can be
            fixed.
          </p>
          <div className="left-actions">
            <button type="button" className="left-rejoin" onClick={() => window.location.reload()}>
              {page === 'meeting' ? 'Rejoin' : 'Reload'}
            </button>
            {page !== 'landing' && (
              <a className="left-home" href="/">
                Go to the home page
              </a>
            )}
          </div>
        </div>
      </main>
    );
  }
}

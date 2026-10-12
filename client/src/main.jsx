import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import RecordingPage from './RecordingPage.jsx';
import './index.css';

// A recording link (?rec=<id>) opens the recording page instead of the app.
const recordingId = new URLSearchParams(window.location.search).get('rec');

createRoot(document.getElementById('root')).render(
  <StrictMode>{recordingId ? <RecordingPage id={recordingId} /> : <App />}</StrictMode>,
);

// Calendar invites for scheduled meetings: an .ics file (Apple Calendar,
// Outlook, most phones) and an "Add to Google Calendar" link. Both carry the
// meeting link, and the .ics a reminder 10 minutes before — the phone's own
// calendar does the reminding, so nothing has to stay awake on our side.

const REMIND_MIN = 10;

// 20261019T150000Z
const stamp = (ms) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
// ICS text values: escape \ ; , and line breaks.
const icsText = (s) =>
  String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

/** "Sun 19 Oct, 4:00 PM" in the viewer's own time zone. */
export function whenText(startsAt) {
  return new Date(startsAt).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "in 2 days" / "in 3 h 10 min" / "in 5 min" / null once it's started. */
export function startsIn(startsAt, now = Date.now()) {
  const min = Math.round((startsAt - now) / 60000);
  if (min <= 0) return null;
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
  const d = Math.round(h / 24);
  return `in ${d} day${d === 1 ? '' : 's'}`;
}

/** The invite as text (for WhatsApp, a text message, email…). */
export function inviteText({ title, startsAt, durationMin, link }) {
  return `📅 ${title || 'Turnly meeting'}\n${whenText(startsAt)} (${durationMin} min)\nJoin on Turnly: ${link}`;
}

/** An "Add to Google Calendar" link. */
export function googleCalendarUrl({ title, startsAt, durationMin, link }) {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: title || 'Turnly meeting',
    dates: `${stamp(startsAt)}/${stamp(startsAt + durationMin * 60000)}`,
    details: `Join on Turnly: ${link}`,
    location: link,
  });
  return `https://calendar.google.com/calendar/render?${p}`;
}

/** Download the meeting as an .ics calendar file. */
export function downloadIcs({ title, startsAt, durationMin, link, room }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Turnly//Meeting//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${room}-${startsAt}@turnly`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(startsAt)}`,
    `DTEND:${stamp(startsAt + durationMin * 60000)}`,
    `SUMMARY:${icsText(title || 'Turnly meeting')}`,
    `DESCRIPTION:${icsText(`Join on Turnly: ${link}`)}`,
    `LOCATION:${icsText(link)}`,
    `URL:${link}`,
    'BEGIN:VALARM',
    `TRIGGER:-PT${REMIND_MIN}M`,
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(`${title || 'Turnly meeting'} starts in ${REMIND_MIN} minutes`)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar' }));
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `${(title || 'Turnly meeting').replace(/[\\/:*?"<>|]/g, '_')}.ics`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

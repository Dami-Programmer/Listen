// "Up next" — in a moderated room, who's first in line for the floor, shown
// on the stage for everyone so turns change without an awkward pause. The
// person who's next gets their own "You're next — get ready" instead (it
// pulses once when it first appears), so they can find their mic in time.

/**
 * @param {string[]} props.queue         raised hands, in order (socket ids)
 * @param {object[]} props.participants
 * @param {string}   props.selfId
 * @param {boolean}  props.moderated
 */
export default function NextUp({ queue, participants, selfId, moderated }) {
  if (!moderated || !queue?.length) return null;
  const nextId = queue[0];
  const next = participants.find((p) => p.id === nextId);
  if (!next) return null;
  const mine = nextId === selfId;
  return (
    <div
      // Keyed on the person, so the entrance animation replays for each new
      // "next" — the pulse that catches their eye.
      key={nextId}
      className={`next-up${mine ? ' mine' : ''}`}
      role="status"
      aria-live="polite"
    >
      {mine ? (
        <>
          <b>You&apos;re next.</b> Get ready to speak
        </>
      ) : (
        <>
          Up next: <b>{next.name}</b>
          {queue.length > 1 && <span className="next-up-more"> +{queue.length - 1} waiting</span>}
        </>
      )}
    </div>
  );
}

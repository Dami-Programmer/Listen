// The small "?" button that replays the step-by-step tour (Tour.jsx). Used in
// the phone's top bar and the desktop / tablet top bar. Its class
// (.tour-replay) is also the target of each tour's last step.
export default function TourButton({ onClick }) {
  return (
    <button
      type="button"
      className="tour-replay"
      onClick={onClick}
      aria-label="How Turnly works: show me around"
      title="How Turnly works"
    >
      ?
    </button>
  );
}

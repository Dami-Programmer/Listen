// The Turnly logo (the T-and-speech-bubble mark + the name). There's a version
// for each theme — the page shows the one that matches (see .logo-dark /
// .logo-light in index.css). Both are wide images with see-through
// backgrounds; .cs-logo sets their height and the width follows.
export default function Logo() {
  return (
    <>
      <img className="cs-logo logo-dark" src="/turnly-logo-dark.webp" alt="Turnly" />
      <img className="cs-logo logo-light" src="/turnly-logo-light.webp" alt="Turnly" />
    </>
  );
}

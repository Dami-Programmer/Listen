// The Listen logo. The original is drawn for a dark page (white halo, pale
// waves), so light mode swaps in logo-light.svg: a halo the color of the page
// and deeper blues. Both are in the page; CSS shows the one for the theme.
export default function Logo() {
  return (
    <>
      <img className="cs-logo logo-dark" src="/logo.svg" alt="Listen" />
      <img className="cs-logo logo-light" src="/logo-light.svg" alt="Listen" />
    </>
  );
}

// The creator's profile card: picture, name, role, what Listen is about, and
// two buttons — Portfolio and Contact — on a dark card over a blurred backdrop.
//
// Opens from the "Made by …" credit in the lobby, or straight away when
// someone visits a link with ?profile in it (e.g. https://your-site/?profile).
// The ✕ in the top-right corner closes it, and so does Esc — animating out the
// same way the image viewer and confirm dialog do.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from './icons.jsx';

// ---- edit your details here -------------------------------------------------
export const PROFILE = {
  name: 'Newtz',
  role: 'Creator of Listen',
  about: 'A platform designed for better conversation, where everyone gets a chance to speak.',
  photo: '/creator-newtz.jpg',
  status: 'Available for work', // set to '' to hide the green-dot line
  portfolio: 'https://davey-portfolio.netlify.app/', // left button
  contact: 'https://wa.me/2349114264109', // right button — opens a WhatsApp chat
};
// -----------------------------------------------------------------------------

const PortfolioIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);
// WhatsApp's mark (simple-icons), in WhatsApp green.
const ContactIcon = () => (
  <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" className="pcard-wa">
    <path
      fill="currentColor"
      d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"
    />
  </svg>
);

/** @param {{ onClose: Function }} props  called once the close animation ends */
export default function ProfileCard({ onClose }) {
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') setClosing(true);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // mailto: opens the mail app in place; anything else opens in a new tab.
  const external = (url) =>
    url.startsWith('mailto:') || url.startsWith('tel:')
      ? {}
      : { target: '_blank', rel: 'noopener noreferrer' };

  return createPortal(
    <div
      className={`profile-backdrop${closing ? ' closing' : ''}`}
      onAnimationEnd={(e) => {
        if (closing && e.target === e.currentTarget) onClose();
      }}
    >
      <article
        className="pcard"
        role="dialog"
        aria-modal="true"
        aria-label={PROFILE.name}
        tabIndex={-1}
        ref={(el) => el?.focus()}
      >
        <button
          type="button"
          className="profile-close pcard-close"
          onClick={() => setClosing(true)}
          aria-label="Close"
        >
          <X />
        </button>

        {PROFILE.status && (
          <p className="pcard-status">
            <i aria-hidden="true" />
            {PROFILE.status}
          </p>
        )}

        <div className="pcard-head">
          <img className="pcard-photo" src={PROFILE.photo} alt="" />
          <div>
            <h2 className="pcard-name">{PROFILE.name}</h2>
            <p className="pcard-role">{PROFILE.role}</p>
          </div>
        </div>

        <p className="pcard-about">{PROFILE.about}</p>

        <div className="pcard-actions">
          <a className="pcard-btn" href={PROFILE.portfolio} {...external(PROFILE.portfolio)}>
            <PortfolioIcon />
            Portfolio
          </a>
          <a className="pcard-btn" href={PROFILE.contact} {...external(PROFILE.contact)}>
            <ContactIcon />
            Contact
          </a>
        </div>
      </article>
    </div>,
    document.body,
  );
}

// A styled dropdown, used instead of the browser's native <select> for the
// mic / camera / speaker pickers (a native select's option list can't be
// styled). Rounded trigger + rounded floating list with a check on the current
// choice. Opens downward, or upward when there isn't room below.
//
// Keyboard: Enter / Space / ↓ open it; ↑ ↓ move, Enter picks, Esc / Tab close.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from './icons.jsx';

/**
 * @param {object}   props
 * @param {string}   props.value
 * @param {{ value: string, label: string }[]} props.options
 * @param {(value: string) => void} props.onChange
 * @param {string}   props.label        accessible name
 * @param {string}  [props.placeholder] shown when no option matches `value`
 * @param {boolean} [props.disabled]
 * @param {string}  [props.className]
 */
export default function Select({
  value,
  options,
  onChange,
  label,
  placeholder = 'Choose…',
  disabled = false,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0); // highlighted option while open
  const [up, setUp] = useState(false); // open upward
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const triggerRef = useRef(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const current = options[selectedIndex];

  function openList() {
    if (disabled || options.length === 0) return;
    setActive(Math.max(0, selectedIndex));
    setOpen(true);
  }
  function close(focusTrigger = true) {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }
  function choose(i) {
    const opt = options[i];
    if (opt && opt.value !== value) onChange(opt.value);
    close();
  }

  // Flip upward when the list would run off the bottom of the window.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const listHeight = listRef.current?.offsetHeight ?? 0;
    setUp(trigger.bottom + listHeight + 12 > window.innerHeight && trigger.top > listHeight + 12);
  }, [open]);

  // Keep the highlighted option in view.
  useEffect(() => {
    if (open) listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  // Click outside closes.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => !rootRef.current?.contains(e.target) && close(false);
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  function onKeyDown(e) {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // close just the list, not a menu it sits in
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Tab') {
      close(false);
    }
  }

  return (
    <div className={`sel${open ? ' open' : ''} ${className}`} ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={triggerRef}
        className="sel-trigger"
        onClick={() => (open ? close() : openList())}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={current?.label}
      >
        <span className="sel-value">{current?.label ?? placeholder}</span>
        <ChevronDown className="sel-chevron" />
      </button>
      {open && (
        <ul
          ref={listRef}
          className={`sel-list${up ? ' up' : ''}`}
          role="listbox"
          aria-label={label}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`sel-option${i === active ? ' active' : ''}${o.value === value ? ' selected' : ''}`}
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <span>{o.label}</span>
              {o.value === value && <Check className="sel-check" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

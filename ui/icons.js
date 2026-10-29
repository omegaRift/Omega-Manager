// Line icons (24x24, stroke). Any element with data-icon="name" gets the icon prepended.
window.ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  pointer: '<path d="M5 3l6.5 16 2.3-6.7L20.5 10z"/>',
  click: '<path d="M9 9l5 12 1.8-5.2L21 14z"/><path d="M7.2 2.2L8 5M2.2 7.2L5 8M5.6 12.4L4 14M12.4 5.6L14 4"/>',
  double: '<path d="M9 9l5 12 1.8-5.2L21 14z"/><path d="M3 4.5h4M3 8h4"/>',
  right: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M6 10h12"/><path d="M12 3a6 6 0 0 1 6 6v1h-6z" fill="currentColor"/>',
  type: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  scroll: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
  key: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  screen: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g>',
  group: '<rect x="3" y="4" width="18" height="16" rx="2" stroke-dasharray="3 2.5"/><path d="M7 9h10M7 13h7"/>',
  branch: '<path d="M6 3v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  chevright: '<path d="M9 6l6 6-6 6"/>',
  unwrap: '<path d="M8 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3M16 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3"/><path d="M12 8v8M9 13l3 3 3-3"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  hourglass: '<path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9"/>',
  snooze: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5M4 4l3-2M20 4l-3-2"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5h.01"/>',
};
window.icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${window.ICONS[name] || ''}</svg>`;
window.applyIcons = (root = document) => {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.dataset.iconDone) continue;
    el.dataset.iconDone = '1';
    el.insertAdjacentHTML('afterbegin', window.icon(el.dataset.icon));
  }
};

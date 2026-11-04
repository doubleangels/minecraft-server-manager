// Section jump bar for long settings pages: a scrolling chip row on a phone,
// a sticky list on desktop ([data-settings-jump] holding [data-jump] links).
// Highlights the section in view and scrolls smoothly to a picked one.
export function initJumpNav(root = document) {
  const jump = root.querySelector('[data-settings-jump]');
  const links = jump ? [...jump.querySelectorAll('[data-jump]')] : [];
  const sections = links.map((a) => document.getElementById(a.dataset.jump)).filter(Boolean);
  if (!links.length) return;
  const setActive = (id) => {
    for (const a of links) {
      const on = a.dataset.jump === id;
      a.classList.toggle('active', on);
      if (on) {
        a.setAttribute('aria-current', 'true');
        // Keep the active chip visible in the phone's scrolling row. Scroll
        // only the row itself: scrollIntoView would also scroll the PAGE back
        // up to the bar, yanking the reader to the top on every section change.
        if (jump.scrollWidth > jump.clientWidth) {
          const left = a.offsetLeft - jump.offsetLeft;
          const right = left + a.offsetWidth;
          if (left < jump.scrollLeft) jump.scrollLeft = left;
          else if (right > jump.scrollLeft + jump.clientWidth) jump.scrollLeft = right - jump.clientWidth;
        }
      } else a.removeAttribute('aria-current');
    }
  };
  if ('IntersectionObserver' in window) {
    const visible = new Map();
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) visible.set(en.target.id, en.isIntersecting);
        const first = sections.find((sec) => visible.get(sec.id));
        if (first) setActive(first.id);
      },
      { rootMargin: '-120px 0px -55% 0px' }
    );
    sections.forEach((sec) => io.observe(sec));
  }
  setActive(
    location.hash && sections.some((s) => `#${s.id}` === location.hash) ? location.hash.slice(1) : sections[0]?.id
  );
  jump.addEventListener('click', (e) => {
    const a = e.target.closest('[data-jump]');
    if (!a) return;
    const target = document.getElementById(a.dataset.jump);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', `#${a.dataset.jump}`);
    setActive(a.dataset.jump);
  });
}

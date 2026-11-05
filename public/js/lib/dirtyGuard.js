// Unsaved-changes warning for pages with their own Save buttons (Discord,
// Status Page, Chatbot, Panel Settings). Markup contract:
//   [data-dirty-group="what it is"]  a block of fields saved together
//   [data-dirty-save]                its Save button
// A group is unsaved while its values differ from the loaded ones (see
// dirtyState.js); a successful save request sent right after its Save button
// is pressed makes the current values the saved ones. Leaving the page with an
// unsaved group asks first (the browser's own prompt).
// (Server Configuration wires the same tracker itself, in server-settings.js.)
import { trackDirty } from './dirtyState.js';

const groups = document.querySelectorAll('[data-dirty-group]');
if (groups.length) init();

function init() {
  /** @type {Map<Element, ReturnType<typeof trackDirty>>} */
  const trackers = new Map();
  /** @type {{ group: Element, at: number } | null} */
  let saving = null;

  for (const g of groups) trackers.set(g, trackDirty(g));
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest('[data-dirty-save]');
      const group = btn && btn.closest('[data-dirty-group]');
      if (group) saving = { group, at: Date.now() };
    },
    true
  );

  // A write that succeeds shortly after a Save click is that save landing.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const method = String((init && init.method) || 'GET').toUpperCase();
    const pendingSave = method !== 'GET' && saving && Date.now() - saving.at < 60000 ? saving : null;
    const res = await nativeFetch(input, init);
    if (pendingSave && res.ok) {
      trackers.get(pendingSave.group)?.reset();
      if (saving === pendingSave) saving = null;
    }
    return res;
  };

  window.addEventListener('beforeunload', (e) => {
    for (const t of trackers.values()) {
      if (t.isDirty()) {
        e.preventDefault();
        return;
      }
    }
  });
}

// Unsaved-changes warning for pages with their own Save buttons (Discord,
// Status Page, Chatbot, Panel Settings). Markup contract:
//   [data-dirty-group="what it is"]  a block of fields saved together
//   [data-dirty-save]                its Save button
// Typing in a group marks it unsaved; a successful save request sent right
// after its Save button is pressed marks it saved again. Leaving the page with
// an unsaved group asks first (the browser's own prompt).
// (Server Configuration has its own, older version of this in server-settings.js.)

const groups = document.querySelectorAll('[data-dirty-group]');
if (groups.length) init();

function init() {
  /** @type {Set<Element>} */
  const dirty = new Set();
  /** @type {{ group: Element, at: number } | null} */
  let saving = null;

  for (const g of groups) {
    const mark = (e) => {
      // A Save click inside the group is not itself an edit.
      if (e.target.closest && e.target.closest('[data-dirty-save]')) return;
      dirty.add(g);
    };
    g.addEventListener('input', mark);
    g.addEventListener('change', mark);
  }
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
      dirty.delete(pendingSave.group);
      if (saving === pendingSave) saving = null;
    }
    return res;
  };

  window.addEventListener('beforeunload', (e) => {
    if (dirty.size) e.preventDefault();
  });
}

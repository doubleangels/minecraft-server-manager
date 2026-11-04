// The browser tab / installed-app title, built from two parts so the pieces
// that update it never overwrite each other:
//   "(2) " - running background tasks (taskTray.js)
//   base   - the page title, which on a server page carries its live status
//            ("🟢 Alpha Survival (Running) · MSM", see app.js)

let base = document.title;
let prefix = '';

function apply() {
  document.title = prefix + base;
}

/** @param {number} n running tasks */
export function setRunningTasks(n) {
  prefix = n ? `(${n}) ` : '';
  apply();
}

/** @param {string} title */
export function setBaseTitle(title) {
  base = title;
  apply();
}

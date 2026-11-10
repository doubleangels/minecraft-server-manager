// "Edit Backup": rename the archive and/or edit its note. Shared by the
// panel-wide Backups page and a server's Backups tab; both render rows with
// data-backup-id, data-file, data-note and a [data-backup-note] line.

import { openModal } from './modal.js';
import { toast } from './toast.js';
import { friendlyError } from './errors.js';

/** @param {HTMLElement} row a [data-backup-row] */
export function openBackupEditor(row) {
  const backupId = row.dataset.backupId;
  const file = row.dataset.file || '';
  const note = row.dataset.note || '';

  const content = document.createElement('div');
  content.className = 'space-y-3';
  content.innerHTML = `
    <div>
      <label class="label" for="bk-edit-name">Archive Name</label>
      <input class="input font-mono" id="bk-edit-name" maxlength="120">
      <p class="help">Changes the displayed name and the file you download. Restore and retention are unaffected.</p>
    </div>
    <div>
      <label class="label" for="bk-edit-note">Note <span class="font-normal text-ink-faint">(optional)</span></label>
      <input class="input" id="bk-edit-note" maxlength="200" placeholder="Before the 1.21 upgrade" autocomplete="off">
      <p class="help">Shown under the archive name, so you can tell backups apart at a glance.</p>
    </div>`;
  const nameEl = content.querySelector('#bk-edit-name');
  const noteEl = content.querySelector('#bk-edit-note');
  nameEl.value = file;
  noteEl.value = note;

  openModal({
    title: 'Edit Backup',
    content,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Save',
        kind: 'primary',
        busyLabel: 'Saving…',
        onClick: async () => {
          const name = nameEl.value.trim();
          const nextNote = noteEl.value.trim();
          if (!name) {
            toast('Enter a name first.', { kind: 'error' });
            return false;
          }
          const body = {};
          if (name !== file) body.filename = name;
          if (nextNote !== note) body.note = nextNote;
          if (!Object.keys(body).length) return; // nothing changed
          try {
            const res = await fetch(`/api/backups/${encodeURIComponent(backupId)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.ok === false) {
              throw new Error(data.error || friendlyError(res, { action: 'save that backup' }));
            }
            row.dataset.file = data.backup.filename;
            row.dataset.note = data.backup.note || '';
            const text = row.querySelector('.truncate.font-mono');
            if (text) {
              text.textContent = data.backup.filename;
              text.title = data.backup.filename;
            }
            const noteLine = row.querySelector('[data-backup-note]');
            if (noteLine) {
              noteLine.textContent = data.backup.note || '';
              noteLine.classList.toggle('hidden', !data.backup.note);
            }
            toast('Backup saved.');
          } catch (err) {
            toast(err.message, { kind: 'error', timeout: 8000 });
            return false;
          }
        },
      },
    ],
  });
  setTimeout(() => noteEl.focus(), 50);
}

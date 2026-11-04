// Server Backups tab: create (with real task progress), verify, restore,
// download (plain link in the partial), edit name/note, delete.
import { toast } from '../lib/toast.js';
import { friendlyError } from '../lib/errors.js';
import { confirmDialog } from '../lib/confirm.js';
import { runTask } from '../lib/progress.js';
import { setBusy } from '../lib/loading.js';
import { fmtBytes } from '../lib/format.js';
import { initRetentionForm } from '../lib/retention.js';
import { openBackupEditor } from '../lib/backupEdit.js';

const root = document.querySelector('[data-backups-server]');
if (root) init(root.dataset.backupsServer);

function init(serverId) {
  const reload = () => setTimeout(() => location.reload(), 700);

  // Admin-only: this server's own retention limits (the form only renders for admins).
  const retentionForm = document.querySelector('#bk-retention [data-retention-form]');
  if (retentionForm) {
    initRetentionForm(retentionForm, {
      previewUrl: `/api/servers/${serverId}/backups/retention/preview`,
      saveUrl: `/api/servers/${serverId}/backups/retention`,
      applyUrl: `/api/servers/${serverId}/backups/retention/apply`,
      currentUrl: `/api/servers/${serverId}/backups/retention`,
      scope: 'server',
      onSaved: reload,
    });
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false)
      throw new Error(data.error || friendlyError(res, { action: 'run that backup action' }));
    return data;
  }

  // ---- Back up now ----
  document.getElementById('bk-now')?.addEventListener('click', async () => {
    const shrink = document.getElementById('bk-shrink')?.checked || false;
    try {
      await runTask({
        title: shrink ? 'Backing up, then shrinking the world…' : 'Creating backup…',
        start: () => postJson(`/api/servers/${serverId}/backups`, shrink ? { shrink: true } : undefined),
      });
      toast(shrink ? 'Backup created. World shrink ran if the server was stopped.' : 'Backup created.');
      reload();
    } catch (err) {
      if (err.dismissed) return; // progress hidden - the task tray takes over
      toast(err.message || 'That backup could not be created. Please try again.', { kind: 'error', timeout: 9000 });
    }
  });

  // ---- Row actions ----
  document.getElementById('bk-table')?.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-backup-row]');
    if (!row) return;
    const backupId = row.dataset.backupId;
    const file = row.dataset.file;
    const size = Number(row.dataset.size) || 0;

    const verifyBtn = e.target.closest('[data-backup-verify]');
    if (verifyBtn) {
      const restore = setBusy(verifyBtn);
      try {
        const res = await postJson(`/api/backups/${encodeURIComponent(backupId)}/verify`);
        toast(`Backup verified: ${res.entries} files, ${fmtBytes(res.bytes)} read.`);
      } catch (err) {
        toast(err.message || 'That backup could not be verified. Please try again.', { kind: 'error', timeout: 9000 });
      } finally {
        restore();
      }
      return;
    }

    if (e.target.closest('[data-backup-restore]')) {
      const ok = await confirmDialog({
        title: `Restore ${file}?`,
        message:
          'The server is stopped and its current data is replaced with this archive. Start it again when the restore finishes.',
        detail:
          'A running server goes offline during the restore. The panel takes a safety backup of the current data first.',
        confirmLabel: 'Restore',
        danger: true,
      });
      if (!ok) return;
      try {
        await runTask({
          title: `Restoring ${file}…`,
          start: () => postJson(`/api/servers/${serverId}/backups/${encodeURIComponent(backupId)}/restore`),
        });
        toast('Backup restored.');
        reload();
      } catch (err) {
        if (err.dismissed) return; // progress hidden - the task tray takes over
        toast(err.message || 'That backup could not be restored. Please try again.', {
          kind: 'error',
          timeout: 9000,
        });
      }
    } else if (e.target.closest('[data-backup-rename]')) {
      openBackupEditor(row);
    } else if (e.target.closest('[data-backup-delete]')) {
      const btn = e.target.closest('[data-backup-delete]');
      const ok = await confirmDialog({
        title: `Delete ${file}?`,
        message: 'Removes the backup archive permanently.',
        detail: `${fmtBytes(size)} will be freed.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      const restore = setBusy(btn);
      try {
        const res = await fetch(`/api/backups/${encodeURIComponent(backupId)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false)
          throw new Error(data.error || friendlyError(res, { action: 'delete that backup' }));
        toast(`${file} deleted (${fmtBytes(size)} freed).`);
        const tbody = row.closest('tbody');
        row.remove();
        // Last one gone → re-render for the proper empty state instead of a
        // header-only table.
        if (tbody && !tbody.querySelector('[data-backup-row]')) reload();
      } catch (err) {
        toast(err.message || 'That backup could not be deleted. Please try again.', { kind: 'error' });
      } finally {
        restore();
      }
    }
  });
}

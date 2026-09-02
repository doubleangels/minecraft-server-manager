// Settings page: API key save/test + localization + users CRUD.
import { toast } from '../lib/toast.js';
import { friendlyError } from '../lib/errors.js';
import { openModal } from '../lib/modal.js';
import { confirmDialog } from '../lib/confirm.js';
import { withBusy } from '../lib/loading.js';
import { fillTimezoneSelect, fillCountrySelect } from '../lib/tzPicker.js';

const page = document.getElementById('settings-page');
if (page) init();

function init() {
  // ---- CurseForge key ----
  document.getElementById('set-cf-save')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; // capture before await - currentTarget is null afterwards
    const key = document.getElementById('set-cf-key').value.trim();
    if (!key) {
      toast('Paste a key first.', { kind: 'error' });
      return;
    }
    await withBusy(btn, 'Saving…', async () => {
      const res = await post('/api/keys/curseforge', { key });
      if (res) {
        toast('Key verified with CurseForge and saved (encrypted).');
        document.getElementById('set-cf-key').value = '';
      }
    });
  });
  // ---- Public domain ----
  document.getElementById('set-domain-save')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const publicHost = document.getElementById('set-domain').value.trim();
    await withBusy(btn, 'Saving…', async () => {
      const res = await post('/api/settings', { publicHost });
      if (res) {
        document.getElementById('set-domain').value = res.publicHost || '';
        toast(res.publicHost ? `Public domain set to ${res.publicHost}.` : 'Public domain cleared.');
        if (res.cookieSecureWarning) {
          toast(
            'This panel is reachable over plain HTTP, so the login cookie can be read in transit. Put it behind HTTPS ' +
              'and set the secure-cookie option, as described in the README.',
            { kind: 'error', timeout: 12000 }
          );
        }
      }
    });
  });

  // ---- Localization (timezone + country) ----
  const tzSel = document.getElementById('set-tz');
  const ccSel = document.getElementById('set-country');
  const locNote = document.getElementById('set-loc-note');
  if (tzSel && ccSel) {
    (async () => {
      let loc = {
        timezoneAuto: true,
        countryAuto: true,
        timezone: '',
        country: '',
        systemTimezone: '',
        systemCountry: '',
      };
      try {
        const res = await fetch('/api/settings/localization', { headers: { Accept: 'application/json' } });
        const data = await res.json();
        if (data.ok) loc = data.localization;
      } catch {
        /* fall back to auto */
      }
      fillTimezoneSelect(tzSel, loc.timezoneAuto ? 'auto' : loc.timezone, loc.systemTimezone);
      fillCountrySelect(ccSel, loc.countryAuto ? 'auto' : loc.country, loc.systemCountry);
      if (locNote) locNote.textContent = `Currently: ${loc.timezone} · ${loc.locale || ''}`;
    })();

    document.getElementById('set-loc-save')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      await withBusy(btn, 'Saving…', async () => {
        const res = await post('/api/settings/localization', { timezone: tzSel.value, country: ccSel.value });
        if (res) {
          if (locNote)
            locNote.textContent = `Currently: ${res.localization.timezone} · ${res.localization.locale || ''}`;
          toast(`Time zone set to ${res.localization.timezone}. Reload to apply everywhere.`);
        }
      });
    });
  }

  document.getElementById('set-cf-test')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    await withBusy(btn, 'Checking…', async () => {
      // post() returns null (and toasts) on any failure - success is the only branch left.
      const res = await post('/api/keys/curseforge/test', {});
      if (res) toast('Stored key is valid.');
    });
  });

  // ---- Public API (/api/v1) ----
  document.getElementById('public-api-enabled')?.addEventListener('change', async (e) => {
    const el = e.currentTarget;
    const enabled = el.checked;
    el.disabled = true;
    try {
      const res = await post('/api/settings/public-api', { enabled });
      if (res) {
        toast(
          res.enabled
            ? 'Outside apps can now read your servers’ status.'
            : 'Outside apps can no longer read your servers’ status.'
        );
      } else {
        el.checked = !enabled; // revert - post() already toasted why
      }
    } finally {
      el.disabled = false;
    }
  });

  document.getElementById('api-token-add')?.addEventListener('click', () => {
    let servers = [];
    try {
      servers = JSON.parse(document.getElementById('api-token-servers')?.textContent || '[]');
    } catch {
      /* no server picker */
    }
    const content = document.createElement('div');
    content.className = 'space-y-3';
    content.innerHTML = `
      <div><label class="label" for="at-label">Name</label>
        <input class="input" id="at-label" autocomplete="off" placeholder="e.g. Status page">
        <p class="help">Just so you can recognise this key in the list later.</p></div>
      <div><span class="label">What it can see</span>
        <label class="flex items-center gap-2 text-sm"><input type="radio" name="at-scope" value="all" checked> Every server</label>
        <label class="flex items-center gap-2 text-sm"><input type="radio" name="at-scope" value="some"> Only the ones I pick</label>
      </div>
      <div><label class="label" for="at-servers">Servers</label>
        <select class="input" id="at-servers" multiple size="6" disabled>
          ${servers.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <div><label class="label" for="at-expires">Stop working on (optional)</label>
        <input class="input" id="at-expires" type="datetime-local">
        <p class="help">Leave blank and the key works until you cancel it.</p></div>`;
    const scopeRadios = content.querySelectorAll('input[name="at-scope"]');
    const serverSel = content.querySelector('#at-servers');
    scopeRadios.forEach((r) =>
      r.addEventListener('change', () => {
        serverSel.disabled = content.querySelector('input[name="at-scope"]:checked').value !== 'some';
      })
    );
    openModal({
      title: 'New Access Key',
      content,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Create',
          kind: 'primary',
          busyLabel: 'Creating…',
          onClick: async () => {
            const scopeAll = content.querySelector('input[name="at-scope"]:checked').value === 'all';
            const serverIds = scopeAll ? [] : [...serverSel.selectedOptions].map((o) => o.value);
            const expiresRaw = content.querySelector('#at-expires').value;
            const body = {
              label: content.querySelector('#at-label').value.trim(),
              scopeAll,
              serverIds,
              expiresAt: expiresRaw ? new Date(expiresRaw).toISOString() : undefined,
            };
            const res = await post('/api/api-tokens', body);
            if (!res) return false;
            revealTokenModal(res.token.token);
          },
        },
      ],
    });
  });

  function revealTokenModal(token) {
    const content = document.createElement('div');
    content.className = 'space-y-3';

    const row = document.createElement('div');
    row.className = 'flex flex-wrap gap-2';
    const field = document.createElement('input');
    field.className = 'input min-w-0 flex-1 font-mono';
    field.readOnly = true;
    field.value = token;
    field.addEventListener('focus', () => field.select());
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(token);
        copyBtn.textContent = 'Copied';
        toast('Key copied to the clipboard.');
        setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
      } catch {
        field.focus();
        toast('Press Ctrl+C to copy.', { kind: 'error' });
      }
    });
    row.append(field, copyBtn);
    content.appendChild(row);

    content.insertAdjacentHTML(
      'beforeend',
      '<p class="notice notice-danger">You’ll only see this key once — copy it somewhere safe now. For security, the panel doesn’t store a copy it can show you later.</p>'
    );
    openModal({
      title: 'Copy Your Access Key Now',
      size: 'sm',
      content,
      actions: [{ label: 'Done', kind: 'primary', onClick: () => setTimeout(() => location.reload(), 300) }],
    });
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  // ---- Users ----
  document.getElementById('users-table')?.addEventListener('change', async (e) => {
    const select = e.target.closest('[data-user-role]');
    if (!select || select.dataset.reverting) return;
    const row = select.closest('[data-user-id]');
    select.disabled = true; // locks the enhanced trigger too (select.js mirrors it)
    try {
      const res = await post(`/api/users/${row.dataset.userId}/role`, { role: select.value });
      if (res) {
        select.dataset.prevRole = select.value;
        toast(`${row.dataset.username} is now ${select.value}.`);
      } else {
        // Revert in place - the old reload wiped the error toast before it
        // could be read. The change dispatch only resyncs the trigger label.
        select.dataset.reverting = '1';
        select.value = select.dataset.prevRole || select.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        delete select.dataset.reverting;
      }
    } finally {
      select.disabled = false;
    }
  });

  // Row menu items (Set Password / Reset 2FA / Delete) live in the per-row
  // overflow menu, which dropdown.js portals to <body> - so they're
  // document-delegated and carry their own data-user-id/data-username rather
  // than relying on closest('[data-user-id]') finding the row. The menu itself
  // is gone (dropdown.js removes it) by the time an async action here
  // resolves, so busy-state goes on the row's still-present kebab trigger.
  function menuTriggerFor(userId) {
    return document.querySelector(`[data-user-id="${CSS.escape(userId)}"] [data-menu]`);
  }

  document.addEventListener('click', async (e) => {
    const passBtn = e.target.closest('[data-user-password]');
    const totpResetBtn = e.target.closest('[data-user-totp-reset]');
    const delBtn = e.target.closest('[data-user-delete]');
    const tokenRevokeBtn = e.target.closest('[data-token-revoke]');
    if (tokenRevokeBtn) {
      const { tokenId, label } = tokenRevokeBtn.dataset;
      const ok = await confirmDialog({
        title: `Cancel the key "${label}"?`,
        message:
          'Any app still using this key stops working right away. You can’t bring the same key back — you’d need to make a new one.',
        confirmLabel: 'Cancel Key',
        danger: true,
      });
      if (!ok) return;
      await withBusy(tokenRevokeBtn, async () => {
        const res = await fetch(`/api/api-tokens/${tokenId}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (data.ok) {
          toast('Key cancelled.');
          document.querySelector(`#api-tokens-table tr[data-token-id="${CSS.escape(tokenId)}"]`)?.remove();
        } else {
          toast(data.error || friendlyError(res, { action: 'cancel that key' }), { kind: 'error' });
        }
      });
      return;
    }
    if (passBtn) {
      passwordModal(passBtn.dataset.userId, passBtn.dataset.username);
    } else if (totpResetBtn) {
      const { userId, username } = totpResetBtn.dataset;
      const ok = await confirmDialog({
        title: `Reset two-factor auth for ${username}?`,
        message:
          'Any in-progress sign-in is cancelled, and they must set up a new authenticator app the next time they sign in.',
        confirmLabel: 'Reset',
        danger: true,
      });
      if (!ok) return;
      await withBusy(menuTriggerFor(userId), async () => {
        const res = await post(`/api/users/${userId}/totp/disable`, {});
        if (res) {
          toast('Two-factor authentication reset.');
          setTimeout(() => location.reload(), 600);
        }
      });
    } else if (delBtn) {
      const { userId, username } = delBtn.dataset;
      const ok = await confirmDialog({
        title: `Delete user ${username}?`,
        message: 'They will be signed out and lose all access.',
        confirmLabel: 'Delete User',
        danger: true,
      });
      if (!ok) return;
      await withBusy(menuTriggerFor(userId), async () => {
        const res = await fetch(`/api/users/${userId}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (data.ok) {
          toast('User deleted.');
          document.querySelector(`[data-user-id="${CSS.escape(userId)}"]`)?.remove();
        } else {
          toast(data.error || friendlyError(res, { action: 'delete that user' }), { kind: 'error' });
        }
      });
    }
  });

  document.getElementById('user-add')?.addEventListener('click', () => {
    const content = document.createElement('div');
    content.className = 'space-y-3';
    content.innerHTML = `
      <div><label class="label">Username</label><input class="input" id="nu-name" autocomplete="off"></div>
      <div><label class="label">Password</label><input class="input" id="nu-pass" type="password" autocomplete="new-password"><p class="help">At least 8 characters.</p></div>
      <div><label class="label">Role</label>
        <select class="input" id="nu-role" data-label="Role">
          <option value="viewer">Viewer (read-only)</option>
          <option value="operator">Operator (manage servers)</option>
          <option value="admin">Admin (full access)</option>
        </select>
      </div>`;
    openModal({
      title: 'Add User',
      content,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Create User',
          kind: 'primary',
          busyLabel: 'Creating…',
          onClick: async () => {
            const body = {
              username: content.querySelector('#nu-name').value.trim(),
              password: content.querySelector('#nu-pass').value,
              role: content.querySelector('#nu-role').value,
            };
            const res = await post('/api/users', body);
            if (!res) return false;
            toast(`User ${body.username} created.`);
            setTimeout(() => location.reload(), 600);
          },
        },
      ],
    });
  });

  function passwordModal(userId, username) {
    const content = document.createElement('div');
    // Build with textContent for the (user-controlled) username so it can't inject markup.
    const label = document.createElement('label');
    label.className = 'label';
    label.textContent = `New password for ${username}`;
    content.appendChild(label);
    content.insertAdjacentHTML(
      'beforeend',
      '<input class="input" id="pw-new" type="password" autocomplete="new-password"><p class="help">At least 8 characters.</p>'
    );
    openModal({
      title: 'Set Password',
      size: 'sm',
      content,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Set Password',
          kind: 'primary',
          busyLabel: 'Saving…',
          onClick: async () => {
            const res = await post(`/api/users/${userId}/password`, {
              password: content.querySelector('#pw-new').value,
            });
            if (!res) return false;
            toast('Password updated.');
          },
        },
      ],
    });
  }

  async function post(url, body) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        toast(data.error || friendlyError(res, { action: 'save that change' }), { kind: 'error', timeout: 8000 });
        return null;
      }
      return data;
    } catch {
      toast(friendlyError(null, { action: 'save that change' }), { kind: 'error' });
      return null;
    }
  }

  // ---- Sign-in lockouts ----
  const lockBody = document.getElementById('lockouts-body');
  const clearAllBtn = document.getElementById('lockouts-clear-all');
  if (lockBody) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const renderLockouts = (list) => {
      if (!list.length) {
        lockBody.textContent = 'No accounts are locked out right now.';
        clearAllBtn.classList.add('hidden');
        return;
      }
      clearAllBtn.classList.remove('hidden');
      lockBody.innerHTML = `
        <div class="overflow-x-auto"><table class="table-base"><thead><tr>
          <th>Account</th><th>Scope</th><th>Address</th><th>Fails</th><th>Clears in</th><th class="text-right"></th>
        </tr></thead><tbody>${list
          .map(
            (l) => `<tr>
              <td class="font-medium">${esc(l.username)}</td>
              <td>${l.scope === 'account' ? 'Whole account' : 'This address'}</td>
              <td class="font-mono text-xs">${esc(l.ip || '—')}</td>
              <td class="tabular-nums">${l.count}</td>
              <td class="tabular-nums">${l.minutesLeft} min</td>
              <td class="text-right"><button class="btn btn-ghost btn-sm" data-unlock data-username="${esc(l.username)}" ${l.ip ? `data-ip="${esc(l.ip)}"` : ''}>Unlock</button></td>
            </tr>`
          )
          .join('')}</tbody></table></div>`;
    };
    const load = async () => {
      try {
        const res = await fetch('/api/auth/lockouts', { headers: { Accept: 'application/json' } });
        const data = await res.json();
        if (res.ok && data.ok) renderLockouts(data.lockouts);
        else lockBody.textContent = 'Could not load the lockout list.';
      } catch {
        lockBody.textContent = 'Could not load the lockout list.';
      }
    };
    lockBody.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-unlock]');
      if (!btn) return;
      await withBusy(btn, 'Unlocking…', async () => {
        const res = await post('/api/auth/lockouts/clear', { username: btn.dataset.username, ip: btn.dataset.ip });
        if (res) {
          toast(`Unlocked "${btn.dataset.username}".`);
          renderLockouts(res.lockouts);
        }
      });
    });
    clearAllBtn?.addEventListener('click', async (e) => {
      const ok = await confirmDialog({
        title: 'Clear all sign-in locks?',
        message: 'Every locked account and address will be able to try signing in again immediately.',
        confirmLabel: 'Clear all',
      });
      if (!ok) return;
      await withBusy(e.currentTarget, 'Clearing…', async () => {
        const res = await post('/api/auth/lockouts/clear', { all: true });
        if (res) {
          toast(`Cleared ${res.removed} lock${res.removed === 1 ? '' : 's'}.`);
          renderLockouts(res.lockouts);
        }
      });
    });
    load();
  }
}

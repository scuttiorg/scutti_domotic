const API = '/api/heating';
const DAYS = ['', 'L', 'M', 'M', 'J', 'V', 'S', 'D'];

// ---------- API ----------
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.status === 204 ? null : res.json();
}

// ---------- État ----------
let sites = [];
let rooms = [];

async function load() {
  [sites, rooms] = await Promise.all([api('GET', '/sites'), api('GET', '/rooms')]);
  render();
}

// ---------- Rendu ----------
const $rooms = document.getElementById('rooms');
const $sites = document.getElementById('sites');
const tplSite = document.getElementById('tpl-site');
const tplRoom = document.getElementById('tpl-room');
const tplRule = document.getElementById('tpl-rule');

const fmtDays = (days) => days.map((d) => DAYS[d]).join(' ');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '');

function renderRoom(room) {
  const el = tplRoom.content.firstElementChild.cloneNode(true);
  el.dataset.room = room.id;
  el.classList.toggle('room--off', !room.enabled);

  el.querySelector('.room__name').textContent = room.name;
  el.querySelector('.room__site').textContent = sites.find((s) => s.id === room.site_id)?.name ?? '';

  const last = room.last;
  const badge = el.querySelector('[data-heating]');
  badge.textContent = last?.heating ? 'chauffe' : 'repos';
  badge.classList.toggle('badge--on', !!last?.heating);
  el.querySelector('[data-temp]').textContent = last?.temperature ?? '—';
  el.querySelector('[data-hum]').textContent = last?.humidity ?? '—';
  el.querySelector('[data-setpoint]').textContent = last?.setpoint ?? '—';
  el.querySelector('[data-updated]').textContent = last ? `relevé ${fmtDate(last.measured_at)}` : 'aucun relevé';

  el.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === room.mode));
  const manual = el.querySelector('[data-manual-form]');
  manual.elements.setpoint.value = room.manual_setpoint ?? room.default_setpoint;
  manual.querySelector('button').setAttribute('aria-pressed', room.mode === 'manual');

  const tbody = el.querySelector('[data-rules]');
  room.rules.forEach((rule) => tbody.append(renderRule(rule)));
  return el;
}

function renderRule(rule) {
  const tr = tplRule.content.firstElementChild.cloneNode(true);
  tr.dataset.rule = rule.id;
  tr.classList.toggle('rule--disabled', !rule.enabled);
  tr.querySelector('[data-name]').textContent = rule.name;
  tr.querySelector('[data-days]').textContent = fmtDays(rule.days);
  tr.querySelector('[data-range]').textContent = `${rule.time_from} – ${rule.time_to}`;
  tr.querySelector('[data-setpoint]').textContent = `${rule.setpoint} °C`;
  tr.querySelector('[data-action="toggle-rule"]').textContent = rule.enabled ? 'Désactiver' : 'Activer';
  return tr;
}

function renderSite(site) {
  const el = tplSite.content.firstElementChild.cloneNode(true);
  el.dataset.site = site.id;
  el.querySelector('[data-name]').textContent = site.name;
  el.querySelector('[data-seen]').textContent = site.last_seen ? `vu ${fmtDate(site.last_seen)}` : 'jamais connecté';
  return el;
}

function render() {
  $sites.replaceChildren(...sites.map(renderSite));
  $rooms.replaceChildren(...rooms.map(renderRoom));
}

function showToken(token) {
  document.querySelector('#dlg-token [data-token]').textContent = token;
  return openDialog('dlg-token');
}

// ---------- Dialogues ----------
function openDialog(id, values = {}) {
  const dlg = document.getElementById(id);
  const form = dlg.querySelector('form');
  form.reset();
  for (const [key, value] of Object.entries(values)) {
    const field = form.elements[key];
    if (!field) continue;
    if (key === 'days') form.querySelectorAll('[name=days]').forEach((cb) => (cb.checked = value.includes(+cb.value)));
    else if (field.type === 'checkbox') field.checked = !!value;
    else field.value = value;
  }
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? formData(form) : null);
    dlg.showModal();
  });
}

function formData(form) {
  const data = {};
  for (const field of form.elements) {
    if (!field.name) continue;
    if (field.name === 'days') (data.days ??= []), field.checked && data.days.push(+field.value);
    else if (field.type === 'checkbox') data[field.name] = field.checked;
    else if (field.type === 'number' || field.name.endsWith('_id')) data[field.name] = +field.value;
    else data[field.name] = field.value;
  }
  return data;
}

function fillSites() {
  const select = document.querySelector('#dlg-room [name=site_id]');
  select.replaceChildren(...sites.map((s) => new Option(s.name, s.id)));
}

// ---------- Actions ----------
const actions = {
  async 'new-site'() {
    const data = await openDialog('dlg-site');
    if (data) await showToken((await api('POST', '/sites', data)).token);
  },
  async 'rotate-token'(_, __, site) {
    if (confirm(`Régénérer le token de « ${site.name} » ? L'ancien cessera de fonctionner.`))
      await showToken((await api('POST', `/sites/${site.id}/rotate-token`)).token);
  },
  async 'delete-site'(_, __, site) {
    if (confirm(`Supprimer le site « ${site.name} » et toutes ses pièces ?`)) await api('DELETE', `/sites/${site.id}`);
  },
  async 'new-room'() {
    fillSites();
    const data = await openDialog('dlg-room');
    if (data) await api('POST', '/rooms', data);
  },
  async 'edit-room'(room) {
    fillSites();
    const data = await openDialog('dlg-room', room);
    if (data) await api('PUT', `/rooms/${room.id}`, data);
  },
  async 'delete-room'(room) {
    if (confirm(`Supprimer la pièce « ${room.name} » et ses règles ?`)) await api('DELETE', `/rooms/${room.id}`);
  },
  async 'new-rule'(room) {
    const data = await openDialog('dlg-rule', { days: [1, 2, 3, 4, 5, 6, 7] });
    if (data) await api('POST', '/rules', { ...data, room_id: room.id });
  },
  async 'edit-rule'(room, rule) {
    const data = await openDialog('dlg-rule', rule);
    if (data) await api('PUT', `/rules/${rule.id}`, { ...data, room_id: room.id });
  },
  async 'toggle-rule'(room, rule) {
    await api('PUT', `/rules/${rule.id}`, { ...rule, enabled: !rule.enabled });
  },
  async 'delete-rule'(room, rule) {
    if (confirm(`Supprimer la règle « ${rule.name} » ?`)) await api('DELETE', `/rules/${rule.id}`);
  },
};

function context(target) {
  const roomEl = target.closest('[data-room]');
  const room = roomEl && rooms.find((r) => r.id === +roomEl.dataset.room);
  const ruleEl = target.closest('[data-rule]');
  const rule = ruleEl && room?.rules.find((r) => r.id === +ruleEl.dataset.rule);
  const siteEl = target.closest('[data-site]');
  const site = siteEl && sites.find((s) => s.id === +siteEl.dataset.site);
  return { room, rule, site };
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action], [data-mode]');
  if (!btn) return;
  const { room, rule, site } = context(btn);
  try {
    if (btn.dataset.mode) await api('PUT', `/rooms/${room.id}/mode`, { mode: btn.dataset.mode });
    else await actions[btn.dataset.action](room, rule, site);
    await load();
  } catch (err) {
    alert(err.message);
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-manual-form]');
  if (!form) return;
  e.preventDefault();
  const { room } = context(form);
  const hours = +form.elements.duration.value;
  const manual_until = hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : null;
  try {
    await api('PUT', `/rooms/${room.id}/mode`, { mode: 'manual', manual_setpoint: +form.elements.setpoint.value, manual_until });
    await load();
  } catch (err) {
    alert(err.message);
  }
});

// Fermeture des dialogues par « Annuler »
document.querySelectorAll('dialog [value=cancel]').forEach((b) =>
  b.addEventListener('click', () => b.closest('dialog').close('cancel')));

load();
setInterval(load, 60_000);

const DEFAULT_SERVER =
  'https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexmeta-public';

const pairView = document.getElementById('pairView');
const pairedView = document.getElementById('pairedView');
const pairCode = document.getElementById('pairCode');
const deviceName = document.getElementById('deviceName');
const serverUrl = document.getElementById('serverUrl');
const pairBtn = document.getElementById('pairBtn');
const refreshBtn = document.getElementById('refreshBtn');
const unpairBtn = document.getElementById('unpairBtn');
const deviceMeta = document.getElementById('deviceMeta');
const message = document.getElementById('message');

serverUrl.value = DEFAULT_SERVER;

function showMessage(text, error = false) {
  message.textContent = String(text || '');
  message.classList.toggle('hidden', !text);
  message.classList.toggle('error', Boolean(error));
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.style.opacity = busy ? '.6' : '1';
}

function render(status) {
  const paired = Boolean(status?.paired);
  pairView.classList.toggle('hidden', paired);
  pairedView.classList.toggle('hidden', !paired);

  if (!paired) {
    if (status?.server) serverUrl.value = status.server;
    deviceMeta.textContent = '';
    return;
  }

  const device = status.device || {};
  const bits = [
    device.name || status.deviceName || 'Facebook browser',
    device.deviceId ? 'ID ' + device.deviceId.slice(0, 8) : '',
    device.lastSeenAt ? 'vu ' + new Date(device.lastSeenAt).toLocaleString() : '',
    status.offline ? 'serveur temporairement indisponible' : ''
  ].filter(Boolean);

  deviceMeta.textContent = bits.join(' · ');
}

async function send(messageBody) {
  return chrome.runtime.sendMessage(messageBody);
}

async function refresh() {
  showMessage('');
  const response = await send({ type: 'NEXMETA_STATUS' });

  if (!response?.ok) {
    showMessage(response?.error || 'Impossible de lire le statut.', true);
    return;
  }

  render(response.result);
}

pairBtn.addEventListener('click', async () => {
  const code = pairCode.value.trim().toUpperCase();
  const name = deviceName.value.trim() || 'Facebook browser';
  const server = serverUrl.value.trim().replace(/\/+$/, '');

  if (code.length < 8) {
    showMessage('Entre le code de pairing généré par NexMeta.', true);
    return;
  }

  setBusy(pairBtn, true);
  showMessage('Connexion à NexMeta…');

  try {
    const response = await send({
      type: 'NEXMETA_PAIR',
      pairCode: code,
      deviceName: name,
      server
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Pairing refusé.');
    }

    pairCode.value = '';
    showMessage('Companion connecté.');
    await refresh();
  } catch (error) {
    showMessage(String(error?.message || error), true);
  } finally {
    setBusy(pairBtn, false);
  }
});

refreshBtn.addEventListener('click', () => {
  refresh().catch(error => {
    showMessage(String(error?.message || error), true);
  });
});

unpairBtn.addEventListener('click', async () => {
  setBusy(unpairBtn, true);

  try {
    const response = await send({ type: 'NEXMETA_UNPAIR' });
    if (!response?.ok) throw new Error(response?.error || 'Échec.');
    render({ paired: false, server: serverUrl.value || DEFAULT_SERVER });
    showMessage('Ce navigateur est déconnecté localement.');
  } catch (error) {
    showMessage(String(error?.message || error), true);
  } finally {
    setBusy(unpairBtn, false);
  }
});

refresh().catch(error => {
  showMessage(String(error?.message || error), true);
});

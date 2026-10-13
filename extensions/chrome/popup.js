const status = document.getElementById('status'), connect = document.getElementById('connect'), disconnect = document.getElementById('disconnect');
async function action(action) {
  connect.disabled = disconnect.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ action });
    if (result?.error) throw new Error(result.error);
    const state = await chrome.runtime.sendMessage({ action: 'STATUS' });
    status.textContent = state.connectionId ? state.detail || 'Aba conectada. Verifique a conta no painel local.' : 'Sem aba conectada.';
  } catch (error) { status.textContent = error.message; }
  finally { connect.disabled = disconnect.disabled = false; }
}
connect.addEventListener('click', () => void action('CONNECT'));
disconnect.addEventListener('click', () => void action('DISCONNECT'));
void action('STATUS');

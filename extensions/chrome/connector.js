(() => {
  if (globalThis.__viralFactoryConnectorInstalled) return;
  globalThis.__viralFactoryConnectorInstalled = true;
  let running = false;
  const clicked = new Set();
  const normalized = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = element => !!element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
  const isStudio = () => location.origin === 'https://www.tiktok.com' && location.pathname.startsWith('/tiktokstudio');
  const postButtons = () => [...document.querySelectorAll('button,[role=button]')].filter(element => visible(element) && /^(Post|Publish|Publicar|Postar)$/i.test(normalized(element.innerText || element.getAttribute('aria-label'))));
  function reviewConfirmationButton() {
    const buttons = [...document.querySelectorAll('button,[role=button]')].filter(element => visible(element) && /^Publicar agora$/i.test(normalized(element.innerText || element.getAttribute('aria-label'))));
    if (buttons.length !== 1 || !enabled(buttons[0])) return null;
    let container = buttons[0].parentElement;
    while (container && container !== document.body) {
      const message = normalized(container.innerText);
      if (message.length < 700 && /Continuar publicando\?/i.test(message) && /Ainda estamos verificando se h[aá] possíveis problemas com seu v[ií]deo/i.test(message) && /Cancelar/i.test(message)) return buttons[0];
      container = container.parentElement;
    }
    return null;
  }
  const enabled = element => !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  function fields() {
    const editable = [...document.querySelectorAll('textarea,input[type=text],[contenteditable=true]')].filter(visible);
    const named = editable.filter(element => /caption|legenda|descri[cç][aã]o|description/i.test(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('placeholder') || ''} ${element.id && document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.innerText || ''}`));
    if (named.length === 1) return named;
    return editable.filter(element => element.isContentEditable);
  }
  function snapshot(account, caption, verifyPost = false, skipCaption = false) {
    const handles = new Set();
    const profileLinks = new Set(), visibleHandles = new Set();
    const avatarImages = [];
    for (const container of document.querySelectorAll('header,nav,aside,[role=banner],[role=navigation],[role=menu],[role=menuitem]')) {
      if (!visible(container)) continue;
      for (const match of (container.innerText || '').matchAll(/(?:^|[^\w.])@([A-Za-z0-9_.]{1,24})(?![\w.])/g)) handles.add(match[1]);
      for (const link of container.querySelectorAll('a[href]')) {
        if (!visible(link)) continue;
        try { const url = new URL(link.href); if (url.origin === location.origin && /^\/@[A-Za-z0-9_.]{1,24}\/?$/.test(url.pathname)) handles.add(url.pathname.replace(/^\/@|\/$/g, '')); } catch {}
      }
    }
    // Diagnostic handles only. They do not authorize publication; a profile link
    // or a handle appearing in page content alone cannot prove the signed-in account.
    if (isStudio()) {
      for (const link of document.querySelectorAll('a[href]')) {
        if (!visible(link)) continue;
        try {
          const url = new URL(link.href);
          if (url.origin === location.origin && /^\/@[A-Za-z0-9_.]{1,24}\/?$/.test(url.pathname)) profileLinks.add(url.pathname.replace(/^\/@|\/$/g, ''));
        } catch {}
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && visibleHandles.size < 12) {
        const parent = node.parentElement;
        if (!parent || !visible(parent) || parent.closest('input,textarea,[contenteditable=true]') || node.textContent.length > 120) continue;
        for (const match of node.textContent.matchAll(/(?:^|[^\w.])@([A-Za-z0-9_.]{1,24})(?![\w.])/g)) visibleHandles.add(match[1]);
      }
      // TikTok Studio renders its avatar menu outside semantic header/menu nodes.
      // Its single visible profile link identifies the active account on upload.
      // Multiple distinct profile links are ambiguous and must not authorize work.
      if (location.pathname.startsWith('/tiktokstudio/upload') && profileLinks.size === 1) handles.add([...profileLinks][0]);
      for (const image of document.querySelectorAll('img')) {
        if (avatarImages.length >= 16) break;
        const box = image.getBoundingClientRect();
        if (!visible(image) || box.width < 16 || box.width > 100 || box.height < 16 || box.height > 100 || (box.top > 250 && box.left > 150)) continue;
        const parent = image.closest('button,[role=button],a,[tabindex]') || image.parentElement;
        if (!parent) continue;
        avatarImages.push({ alt: (image.alt || '').slice(0, 80), parentTag: parent.tagName.toLowerCase(),
          parentRole: (parent.getAttribute('role') || '').slice(0, 40), parentAria: (parent.getAttribute('aria-label') || '').slice(0, 80),
          parentTitle: (parent.getAttribute('title') || '').slice(0, 80), parentTestId: (parent.getAttribute('data-testid') || '').slice(0, 80),
          x: Math.round(box.x), y: Math.round(box.y) });
      }
    }
    const links = [...document.querySelectorAll('a[href]')].map(element => element.href).filter(value => /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+/.test(value)).slice(0, 29);
    if (/^\/@[^/]+\/video\/\d+$/.test(location.pathname)) links.push(location.href);
    const captionFields = fields();
    const expected = normalized(caption);
    const captionMatches = skipCaption || (!!expected && (verifyPost ? normalized(document.body.innerText).includes(normalized(caption).slice(0, 70)) : captionFields.length === 1 && normalized(captionFields[0].isContentEditable ? captionFields[0].innerText : captionFields[0].value) === expected));
    const buttons = postButtons();
    return { connectorVersion: 5, url: location.href, title: document.title.slice(0, 200), accountHandles: [...handles].slice(0, 12), profileLinks: [...profileLinks].slice(0, 12), visibleHandles: [...visibleHandles], avatarImages, fileInputs: document.querySelectorAll('input[type=file]').length,
      postLinks: links, hasVideo: !!document.querySelector('video'), captionMatches, postEnabled: buttons.length === 1 && enabled(buttons[0]),
      alerts: [...document.querySelectorAll('[role=alert]')].filter(visible).map(element => normalized(element.innerText).slice(0, 300)).slice(0, 5) };
  }
  const identified = (account, current) => current.accountHandles.length === 1 && current.accountHandles[0].toLowerCase() === account.toLowerCase();
  async function requireAccount(account, deadline) {
    if (!isStudio() || !location.pathname.startsWith('/tiktokstudio/upload') || !account) throw new Error('A aba precisa estar na tela de envio do TikTok Studio.');
    let current = snapshot(account);
    if (identified(account, current)) return current;
    if (current.accountHandles.length || current.profileLinks.length) throw new Error('Perfil diferente ou ambíguo na tela de envio.');
    const buttons = new Set();
    for (const image of document.querySelectorAll('button img')) {
      const box = image.getBoundingClientRect();
      if (visible(image) && box.width >= 16 && box.width <= 100 && box.height >= 16 && box.height <= 100 && box.top >= 0 && box.top < 100 && box.right >= innerWidth - 160) buttons.add(image.closest('button'));
    }
    if (buttons.size !== 1) throw new Error('Botão do avatar não identificado de forma única.');
    const button = [...buttons][0];
    if (!visible(button) || !enabled(button)) throw new Error('Botão do avatar indisponível.');
    button.click();
    current = await waitFor(() => {
      const opened = snapshot(account);
      if (opened.accountHandles.length || opened.profileLinks.length) {
        if (!identified(account, opened)) throw new Error('O menu do avatar mostra outra conta ou contas ambíguas.');
        return opened;
      }
      return null;
    }, deadline);
    return current;
  }
  async function waitFor(get, deadline) {
    while (Date.now() < deadline) { const result = get(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 500)); }
    throw new Error('A página não liberou o controle esperado. Confira login, verificações e upload.');
  }
  async function execute(message) {
    if (location.origin !== 'https://www.tiktok.com') throw new Error('Página não autorizada.');
    const deadline = Math.min(message.expiresAt || Date.now()+60000, Date.now()+70000);
    if (message.expiresAt && message.expiresAt <= Date.now()) throw new Error('Comando expirado.');
    const account = String(message.account || '');
    if (message.action === 'INSPECT') return snapshot(account, message.caption);
    if (message.action === 'REVEAL_ACCOUNT') return requireAccount(account, deadline);
    if (message.action === 'NAVIGATE') {
      await waitFor(() => document.querySelector('input[type=file]'), deadline);
      return snapshot(account);
    }
    if (message.action === 'VERIFY_POST') {
      await waitFor(() => document.querySelector('video') && snapshot(account, message.caption, true).captionMatches, deadline);
      return snapshot(account, message.caption, true);
    }
    await requireAccount(account, deadline);
    if (message.action === 'UPLOAD') {
      const inputs = [...document.querySelectorAll('input[type=file]')];
      const accepted = inputs.filter(input => /video|\.mp4|\.webm/i.test(input.accept));
      const candidates = accepted.length === 1 ? accepted : accepted.length > 1 ? accepted : inputs.filter(input => !input.accept.trim());
      if (candidates.length !== 1 || typeof message.fileBase64 !== 'string') throw new Error('Campo de vídeo ou arquivo não identificado.');
      const binary = atob(message.fileBase64);
      if (!binary.length || binary.length > 40*1024*1024) throw new Error('Vídeo inválido ou maior que 40 MB.');
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const prefix = account.toLowerCase().replace(/[^a-z0-9-]/g, '-') + '-';
      const filename = typeof message.filename === 'string' && message.filename.startsWith(prefix) && /^[a-z0-9-]{1,110}\.mp4$/.test(message.filename) ? message.filename : `${prefix}video.mp4`;
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], filename, { type: 'video/mp4' }));
      candidates[0].files = transfer.files;
      candidates[0].dispatchEvent(new Event('input', { bubbles: true })); candidates[0].dispatchEvent(new Event('change', { bubbles: true }));
      return snapshot(account);
    }
    if (message.action === 'CAPTION') {
      if (typeof message.caption !== 'string' || message.caption.length > 2200) throw new Error('Legenda inválida.');
      await waitFor(() => fields().length === 1, deadline);
      const field = fields()[0]; field.focus();
      if (field.isContentEditable) {
        const range = document.createRange(); range.selectNodeContents(field); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        if (!document.execCommand('insertText', false, message.caption)) throw new Error('O editor não aceitou a legenda.');
        field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message.caption }));
      } else {
        const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, message.caption);
        field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true }));
      }
      field.blur();
      await new Promise(resolve => setTimeout(resolve, 2000));
      await waitFor(() => snapshot(account, message.caption).captionMatches, deadline);
      return snapshot(account, message.caption);
    }
    if (message.action === 'READY') {
      await waitFor(() => snapshot(account, message.caption, false, message.skipCaption).hasVideo && snapshot(account, message.caption, false, message.skipCaption).postEnabled && snapshot(account, message.caption, false, message.skipCaption).captionMatches, deadline);
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (!snapshot(account, message.caption, false, message.skipCaption).hasVideo || !snapshot(account, message.caption, false, message.skipCaption).postEnabled || !snapshot(account, message.caption, false, message.skipCaption).captionMatches) throw new Error('O vídeo ou o botão mudou antes de publicar.');
      await requireAccount(account, deadline); return snapshot(account, message.caption, false, message.skipCaption);
    }
    if (message.action === 'SUBMIT') {
      if (!message.commandId || clicked.has(message.commandId)) throw new Error('Este envio já foi executado.');
      const current = snapshot(account, message.caption, false, message.skipCaption), buttons = postButtons();
      if (!current.captionMatches || !current.hasVideo || !current.postEnabled || Date.now() >= deadline) throw new Error('Vídeo ou botão mudou antes de publicar.');
      await requireAccount(account, deadline);
      clicked.add(message.commandId); // Mark before click; never retry a failed or uncertain click.
      buttons[0].click();
      // TikTok sometimes asks whether to publish while its video check is still
      // running. This is part of the same submission, guarded by exact dialog text.
      const confirmationDeadline = Math.min(deadline, Date.now()+12000);
      while (Date.now() < confirmationDeadline && location.pathname.startsWith('/tiktokstudio/upload')) {
        const confirmation = reviewConfirmationButton();
        if (confirmation) { confirmation.click(); break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return snapshot(account, message.caption);
    }
    throw new Error('Ação não autorizada.');
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== 'viralfactory-local') return;
    if (running) { sendResponse({ error: 'A aba está executando outro comando.' }); return; }
    running = true;
    execute(message).then(result => sendResponse({ snapshot: result })).catch(error => sendResponse({ error: String(error.message || error).slice(0, 600) })).finally(() => { running = false; });
    return true;
  });
})();

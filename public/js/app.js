document.querySelectorAll('[data-copy]').forEach((button) => {
  const originalLabel = button.textContent;
  button.addEventListener('click', async () => {
    const text = button.getAttribute('data-copy') || '';
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = '已复制';
      setTimeout(() => {
        button.textContent = originalLabel;
      }, 1200);
    } catch (error) {
      alert('复制失败，请手动复制。');
    }
  });
});

document.querySelectorAll('[data-file-note-toggle]').forEach((button) => {
  button.addEventListener('click', () => {
    const panel = document.querySelector('[data-file-note-panel]');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    button.textContent = panel.hidden ? '查看文件详情' : '收起文件详情';
  });
});

const statusBox = document.querySelector('[data-order-status]');
if (statusBox) {
  const orderNo = statusBox.getAttribute('data-order-no');
  const statusText = statusBox.querySelector('[data-status-text]');

  const poll = async () => {
    try {
      const response = await fetch(`/orders/${orderNo}/status`);
      const data = await response.json();
      if (!data.ok) return;
      if (statusText) statusText.textContent = data.status;
      if (data.paid && data.deliveryUrl) {
        window.location.href = data.deliveryUrl;
      }
    } catch (error) {
      // ignore polling errors
    }
  };

  setInterval(poll, 5000);
}

const modalBackdrop = document.querySelector('[data-modal-backdrop]');
const modalCloseButton = document.querySelector('[data-modal-close]');
if (modalBackdrop && modalCloseButton) {
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  modalCloseButton.focus();

  const keepModalOpen = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      modalCloseButton.focus();
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      modalCloseButton.focus();
    }
  };

  document.addEventListener('keydown', keepModalOpen);
  modalCloseButton.addEventListener('click', () => {
    document.removeEventListener('keydown', keepModalOpen);
    document.body.style.overflow = previousOverflow;
    modalBackdrop.remove();
  });
}


document.querySelectorAll('[data-confirm]').forEach((element) => {
  element.addEventListener('click', (event) => {
    const message = element.getAttribute('data-confirm') || '确定继续吗？';
    if (!window.confirm(message)) {
      event.preventDefault();
    }
  });
});

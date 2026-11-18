(() => {
  'use strict';

  const statuses = { queued: '排队中', running: '处理中', done: '已完成', failed: '失败', cancelled: '已取消' };
  const kinds = { import: '导入', 'ae-package': 'AE 打包', 'ae-preview': 'AE 合成预览', transcode: '视频转码', 'model-preview': '模型旋转预览' };
  const active = task => task.status === 'queued' || task.status === 'running';
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function create({ panel, openButton, api, onOpen, onError, openTranscode }) {
    let tasks = [];
    let expanded = false;
    let revision = 0;
    const toggle = make('button', 'task-center-toggle');
    toggle.type = 'button';
    toggle.id = 'taskCenterToggle';
    toggle.setAttribute('aria-controls', 'taskCenterBody');
    const title = make('strong', '', '后台任务');
    const summary = make('span', 'task-center-summary');
    summary.setAttribute('role', 'status');
    const chevron = make('span', 'task-center-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    toggle.append(title, summary, chevron);
    const body = make('div', 'task-center-body');
    body.id = 'taskCenterBody';
    const list = make('ul', 'task-center-list');
    list.id = 'taskCenterList';
    const empty = make('div', 'task-center-empty', '暂无后台任务');
    const footer = make('div', 'task-center-footer');
    const clearButton = make('button', 'task-center-action', '清除已结束任务');
    clearButton.type = 'button';
    footer.append(clearButton);
    body.append(list, empty, footer);
    panel.removeAttribute('role');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', '后台任务');
    panel.classList.add('task-center-panel');
    panel.replaceChildren(toggle, body);

    function receive(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.tasks)) return;
      tasks = snapshot.tasks;
      render();
    }

    async function request(call) {
      const current = revision;
      try {
        const state = await call();
        if (current === revision) receive(state);
      } catch (error) { onError?.(error); }
    }

    function row(task) {
      const item = make('li', 'task-center-row');
      item.dataset.taskId = task.id;
      item.dataset.taskStatus = task.status;
      const head = make('div', 'task-center-row-head');
      const name = make('strong', 'task-center-row-title', task.title);
      name.title = task.title;
      head.append(name, make('span', 'task-center-row-status', statuses[task.status]));
      const type = make('div', 'task-center-row-kind', kinds[task.kind] || '后台任务');
      item.append(head, type);
      if (task.note) item.append(make('div', 'task-center-row-note', task.note));
      if (active(task)) {
        const progress = make('progress', 'task-center-row-progress');
        progress.max = 1;
        if (Number.isFinite(task.progress)) progress.value = task.progress;
        progress.setAttribute('aria-label', task.title + '的进度');
        item.append(progress);
      }
      const actions = make('div', 'task-center-row-actions');
      if (task.retryable) {
        const retryButton = make('button', 'task-center-action', task.retrying ? '正在重试…' : '重试');
        retryButton.type = 'button';
        retryButton.dataset.taskAction = 'retry';
        retryButton.disabled = task.retrying;
        retryButton.addEventListener('click', () => {
          retryButton.disabled = true;
          void request(() => api.retryTask(task.id)).finally(() => { retryButton.disabled = false; });
        });
        actions.append(retryButton);
      }
      if (task.relatedId && openTranscode?.canOpen(task.relatedId)) {
        const details = make('button', 'task-center-action', '转码详情');
        details.type = 'button';
        details.dataset.taskAction = 'details';
        details.addEventListener('click', () => openTranscode.open());
        actions.append(details);
      }
      if (actions.childElementCount) item.append(actions);
      return item;
    }

    function render() {
      const running = tasks.filter(active).length;
      const failures = tasks.filter(task => task.status === 'failed').length;
      const status = [running ? `${running} 项进行中` : '', failures ? '有失败项' : ''].filter(Boolean).join(' · ');
      const summaryText = status || (tasks.length ? `${tasks.length} 条记录` : '');
      if (summary.textContent !== summaryText) summary.textContent = summaryText;
      panel.classList.toggle('hidden', !expanded && !running && !failures);
      toggle.setAttribute('aria-expanded', String(expanded));
      openButton?.setAttribute('aria-expanded', String(expanded));
      body.hidden = !expanded;
      if (!expanded) return;
      const focus = document.activeElement;
      const focusedTask = focus?.closest('.task-center-row');
      const action = focus?.dataset.taskAction;
      const scroll = list.scrollTop;
      const rows = tasks.map(row);
      list.replaceChildren(...rows);
      list.scrollTop = scroll;
      empty.hidden = Boolean(tasks.length);
      footer.hidden = !tasks.some(task => !active(task) && !task.retrying);
      if (focusedTask && action) {
        const replacement = rows.find(item => item.dataset.taskId === focusedTask.dataset.taskId);
        const button = replacement?.querySelector(`[data-task-action="${action}"]`);
        (button && !button.disabled ? button : toggle).focus({ preventScroll: true });
      }
    }

    function open() {
      if (!expanded) onOpen?.();
      expanded = true;
      render();
      toggle.focus({ preventScroll: true });
    }

    function collapse() {
      expanded = false;
      list.replaceChildren();
      render();
    }

    toggle.addEventListener('click', () => { if (expanded) collapse(); else open(); });
    openButton?.addEventListener('click', open);
    panel.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !expanded) return;
      event.preventDefault();
      event.stopPropagation();
      collapse();
      if (!panel.classList.contains('hidden')) toggle.focus({ preventScroll: true });
    });
    clearButton.addEventListener('click', () => void request(() => api.clearTasks()));
    api.onTaskCenter(snapshot => { revision++; receive(snapshot); });
    void request(() => api.taskCenterState());
    render();
    return Object.freeze({ open, collapse });
  }

  window.ShituTaskCenter = Object.freeze({ create });
})();

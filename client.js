/** @ts-check */
/**
 * Browser half of dsh-working-note.
 *
 * Renders the session's pinned working context and keeps every device on the
 * Host's durable state:
 *  - `conversation.input.dock` — one compact pin strip above the composer:
 *    worktree + line delta · port chips · Kill all (two presses) · steps,
 *  - `sidebar.right.pane.tab` under tab type `working-note` — the full panel
 *    (git facts, port table, step editor); it floats with the docking kit,
 *  - highlighted chat text pins a step through the `contextmenu` interaction
 *    and `Alt+Shift+P` (the merged selection toolbar is a separate core slot).
 *
 * State arrives as whole `SessionView` frames (CONTRACTS §2) over an
 * EventSource; mutations post to the same Host service. All colours come from
 * `--dsw-alias-*` tokens and every user-visible string from the `workingNote`
 * locale namespace, so light/dark and language follow the host with no
 * extra wiring.
 */
window.__ModuleLoader__.load({
  id: 'dsh-working-note',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'workingNote'
    const BASE = '/api/working-note'

    /* ── copy ─────────────────────────────────────────────────────────────── */
    function enDict() {
      return {
        'strip.label': 'Working note',
        'strip.uncommitted': 'uncommitted',
        'strip.branch': 'branch',
        'strip.steps': 'steps',
        'strip.killAll': 'Kill all',
        'strip.killAllArmed': 'Confirm kill?',
        'strip.killAllTitle': 'Stop every port attributed to this session',
        'strip.expand': 'Show details',
        'strip.collapse': 'Hide details',
        'strip.openTab': 'Open in the right sidebar',
        'ports.title': 'Open ports',
        'ports.live': '{count} live',
        'ports.stopped': '{count} stopped',
        'ports.refresh': 'Refresh',
        'ports.clearStopped': 'Clear stopped',
        'ports.open': 'Open http://127.0.0.1:{port}',
        'ports.copy': 'Copy URL',
        'ports.kill': 'Kill this port',
        'ports.pid': 'pid {pid}',
        'ports.unsupported': 'Port discovery is not available on this Host. Background jobs still appear in the jobs list.',
        'ports.empty': 'No ports discovered yet. Start a dev server with the agent or this session’s terminal.',
        'steps.title': 'Steps',
        'steps.add': 'Add',
        'steps.addPlaceholder': 'Add a step… (paste a multi-line checklist to add them all)',
        'steps.remaining': '{count} to do',
        'steps.clearDone': 'Clear done',
        'steps.empty': 'No steps yet. Ask the agent to record the hands-on steps, or highlight text in the chat and pin it.',
        'steps.moveUp': 'Move up',
        'steps.moveDown': 'Move down',
        'steps.remove': 'Remove step',
        'steps.toggle': 'Mark done',
        'steps.sourceUser': 'you',
        'steps.sourceAi': 'ai',
        'steps.edit': 'Edit step text',
        'git.title': 'Worktree & git',
        'git.checkout': 'Checkout',
        'git.branch': 'Branch',
        'git.kind': 'Kind',
        'git.kindWorktree': 'Linked worktree',
        'git.kindRepo': 'Repository checkout',
        'git.base': 'Base',
        'git.uncommitted': 'Uncommitted',
        'git.branchDelta': 'Branch vs base',
        'git.files': '{count} files',
        'git.copyPath': 'Copy path',
        'git.notRepo': 'Not a git repository',
        'git.refresh': 'Rescan git',
        'tab.title': 'Working note',
        'tab.guide': 'Working note',
        'tab.guideDescription': 'Worktree, ports, and hands-on steps',
        'tab.session': 'Session “{title}”',
        'tab.archived': 'Archived — this note is kept for the undo window, then removed.',
        'tab.purged': 'This note was removed with its session.',
        'tab.error': 'The working note could not be loaded: {message}',
        'tab.retry': 'Retry',
        'selection.pin': 'Pin note',
        'selection.split': 'Split into steps',
        'selection.splitHint': 'One step per line',
        'notice.killAllDone': 'Stopped {count} port(s)',
        'notice.killFailed': '{count} port(s) could not be stopped',
        'notice.archived': 'This session is archived; the working note is read-only.',
        'notice.added': 'Pinned to the working note',
        'notice.duplicate': 'Already pinned',
      }
    }

    function viDict() {
      return {
        'strip.label': 'Ghi chú làm việc',
        'strip.uncommitted': 'chưa commit',
        'strip.branch': 'nhánh',
        'strip.steps': 'bước',
        'strip.killAll': 'Kill all',
        'strip.killAllArmed': 'Xác nhận kill?',
        'strip.killAllTitle': 'Dừng mọi cổng thuộc phiên này',
        'strip.expand': 'Xem chi tiết',
        'strip.collapse': 'Thu gọn',
        'strip.openTab': 'Mở ở sidebar phải',
        'ports.title': 'Cổng đang mở',
        'ports.live': '{count} đang chạy',
        'ports.stopped': '{count} đã dừng',
        'ports.refresh': 'Quét lại',
        'ports.clearStopped': 'Xoá cổng đã dừng',
        'ports.open': 'Mở http://127.0.0.1:{port}',
        'ports.copy': 'Sao chép URL',
        'ports.kill': 'Dừng cổng này',
        'ports.pid': 'pid {pid}',
        'ports.unsupported': 'Host này không hỗ trợ dò cổng. Job của agent vẫn xem được ở danh sách job nền.',
        'ports.empty': 'Chưa phát hiện cổng nào. Hãy start dev server bằng agent hoặc terminal của phiên này.',
        'steps.title': 'Các bước',
        'steps.add': 'Thêm',
        'steps.addPlaceholder': 'Thêm một bước… (dán danh sách nhiều dòng để thêm hàng loạt)',
        'steps.remaining': 'còn {count} bước',
        'steps.clearDone': 'Xoá bước đã xong',
        'steps.empty': 'Chưa có bước nào. Nhờ agent ghi các bước làm tay, hoặc bôi đen văn bản trong chat để ghim.',
        'steps.moveUp': 'Lên',
        'steps.moveDown': 'Xuống',
        'steps.remove': 'Xoá bước',
        'steps.toggle': 'Đánh dấu xong',
        'steps.sourceUser': 'bạn',
        'steps.sourceAi': 'ai',
        'steps.edit': 'Sửa nội dung bước',
        'git.title': 'Worktree & git',
        'git.checkout': 'Thư mục',
        'git.branch': 'Nhánh',
        'git.kind': 'Loại',
        'git.kindWorktree': 'Worktree liên kết',
        'git.kindRepo': 'Bản checkout của repo',
        'git.base': 'Base',
        'git.uncommitted': 'Chưa commit',
        'git.branchDelta': 'Nhánh so với base',
        'git.files': '{count} tệp',
        'git.copyPath': 'Sao chép đường dẫn',
        'git.notRepo': 'Không phải git repository',
        'git.refresh': 'Quét lại git',
        'tab.title': 'Ghi chú làm việc',
        'tab.guide': 'Ghi chú làm việc',
        'tab.guideDescription': 'Worktree, cổng đang mở và các bước làm tay',
        'tab.session': 'Phiên “{title}”',
        'tab.archived': 'Đã lưu trữ — ghi chú được giữ trong thời gian có thể hoàn tác rồi bị xoá.',
        'tab.purged': 'Ghi chú đã bị xoá cùng phiên.',
        'tab.error': 'Không tải được ghi chú làm việc: {message}',
        'tab.retry': 'Thử lại',
        'selection.pin': 'Pin note',
        'selection.split': 'Tách thành nhiều bước',
        'selection.splitHint': 'Mỗi dòng thành một bước',
        'notice.killAllDone': 'Đã dừng {count} cổng',
        'notice.killFailed': '{count} cổng không dừng được',
        'notice.archived': 'Phiên đã được lưu trữ; ghi chú chỉ còn đọc.',
        'notice.added': 'Đã ghim vào ghi chú làm việc',
        'notice.duplicate': 'Đã được ghim trước đó',
      }
    }

    function zhDict() {
      return {
        'strip.label': '工作笔记',
        'strip.uncommitted': '未提交',
        'strip.branch': '分支',
        'strip.steps': '步骤',
        'strip.killAll': 'Kill all',
        'strip.killAllArmed': '再次点击确认',
        'strip.killAllTitle': '停止本会话关联的所有端口',
        'strip.expand': '展开详情',
        'strip.collapse': '收起',
        'strip.openTab': '在右侧栏打开',
        'ports.title': '正在监听的端口',
        'ports.live': '{count} 个运行中',
        'ports.stopped': '{count} 个已停止',
        'ports.refresh': '重新扫描',
        'ports.clearStopped': '清除已停止',
        'ports.open': '打开 http://127.0.0.1:{port}',
        'ports.copy': '复制地址',
        'ports.kill': '停止该端口',
        'ports.pid': 'pid {pid}',
        'ports.unsupported': '此 Host 不支持端口发现。后台任务仍可在任务列表中查看。',
        'ports.empty': '尚未发现端口。请用助手或本会话的终端启动开发服务器。',
        'steps.title': '步骤',
        'steps.add': '添加',
        'steps.addPlaceholder': '添加一个步骤…（粘贴多行清单可批量添加）',
        'steps.remaining': '还剩 {count} 步',
        'steps.clearDone': '清除已完成',
        'steps.empty': '还没有步骤。可以让助手记录手动步骤，或在聊天中选中文本后固定。',
        'steps.moveUp': '上移',
        'steps.moveDown': '下移',
        'steps.remove': '删除步骤',
        'steps.toggle': '标记完成',
        'steps.sourceUser': '你',
        'steps.sourceAi': '助手',
        'steps.edit': '编辑步骤内容',
        'git.title': 'Worktree 与 Git',
        'git.checkout': '检出目录',
        'git.branch': '分支',
        'git.kind': '类型',
        'git.kindWorktree': '链接 worktree',
        'git.kindRepo': '仓库检出',
        'git.base': '基线',
        'git.uncommitted': '未提交',
        'git.branchDelta': '分支相对基线',
        'git.files': '{count} 个文件',
        'git.copyPath': '复制路径',
        'git.notRepo': '不是 Git 仓库',
        'git.refresh': '重新扫描 Git',
        'tab.title': '工作笔记',
        'tab.guide': '工作笔记',
        'tab.guideDescription': 'Worktree、端口与手动步骤',
        'tab.session': '会话“{title}”',
        'tab.archived': '已归档 — 笔记会在撤销期内保留，之后删除。',
        'tab.purged': '笔记已随会话删除。',
        'tab.error': '无法加载工作笔记：{message}',
        'tab.retry': '重试',
        'selection.pin': '固定为步骤',
        'selection.split': '拆分为多个步骤',
        'selection.splitHint': '每行一个步骤',
        'notice.killAllDone': '已停止 {count} 个端口',
        'notice.killFailed': '{count} 个端口未能停止',
        'notice.archived': '该会话已归档，工作笔记为只读。',
        'notice.added': '已固定到工作笔记',
        'notice.duplicate': '该内容已固定',
      }
    }

    const DICT = { en: enDict(), vi: viDict(), zh: zhDict() }

    /* ── transport ────────────────────────────────────────────────────────── */

    /**
     * Fetch + EventSource wrapper for one Session.
     * @param {string} sessionId
     * @returns the client face used by components.
     */
    function createApi(sessionId) {
      const post = async (path, body, method = 'POST') => {
        const response = await fetch(`${BASE}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify({ sessionId, ...body }),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) {
          const error = new Error(payload.message ?? response.statusText)
          error.code = payload.code
          throw error
        }
        return payload
      }
      let source = null
      return {
        sessionId,
        open(onView, onError) {
          const url = `${BASE}/stream?sessionId=${encodeURIComponent(sessionId)}`
          source = new EventSource(url)
          source.onmessage = (event) => {
            try {
              onView(JSON.parse(event.data))
            } catch (error) {
              onError?.(error)
            }
          }
          source.onerror = () => { onError?.(new Error('stream interrupted')) }
          return () => {
            source?.close()
            source = null
          }
        },
        refresh: () => post('/refresh'),
        addSteps: (steps) => post('/steps', { steps, source: 'user' }),
        updateStep: (stepId, patch) => post(`/steps/${encodeURIComponent(stepId)}`, patch, 'PATCH'),
        removeStep: (stepId) => post(`/steps/${encodeURIComponent(stepId)}`, undefined, 'DELETE'),
        clearDone: () => post('/steps', undefined, 'DELETE'),
        killPort: (port) => post('/ports/kill', { port }),
        killAll: () => post('/ports/kill-all'),
        clearStopped: () => post('/ports/stopped', undefined, 'DELETE'),
        setUi: (patch) => post('/ui', patch, 'PATCH'),
      }
    }

    /* ── pure helpers ─────────────────────────────────────────────────────── */

    /** Split a pasted block the same way the Host does (bullets stripped). */
    function splitPasted(text) {
      return String(text ?? '').split(/\r?\n/)
        .map(line => line.replace(/^\s*(?:[-*+•]|\d+[.)]|\[\s?[ xX]?\s?\])\s+/, '').trim())
        .filter(Boolean)
    }

    function formatCounts(counts) {
      if (counts === undefined || counts === null) return null
      if (typeof counts.added !== 'number' || typeof counts.deleted !== 'number') return null
      return { added: `+${counts.added}`, deleted: `−${counts.deleted}` }
    }

    /**
     * One git counter block. A frame from another Host release may carry no
     * counter (or one without `files`), so the row degrades to a dash instead of
     * reading through null.
     */
    function statRow(label, counts, t) {
      const formatted = formatCounts(counts)
      const files = typeof counts?.files === 'number' ? counts.files : null
      return h('div', { className: 'wn-stat' },
        h('div', { className: 'wn-stat-label' }, label),
        formatted === null || files === null
          ? h('div', { className: 'wn-stat-value wn-muted' }, '—')
          : h('div', { className: 'wn-stat-value' }, h(Counts, { counts }), ' ',
              h('small', { className: 'wn-muted' }, t('workingNote.git.files', { count: files }))))
    }

    /* ── styles (theme tokens only, injected once per document) ───────────── */

    const STYLE_ID = 'dsh-working-note-style'
    const CSS = `
.wn-strip{box-sizing:border-box;display:flex;flex-direction:column;width:calc(100% - 2*var(--dsh-composer-side-clearance) - 6*var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - 4*var(--dsh-composer-dock-inset));margin:0 auto;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);overflow:hidden;font-size:12px;color:var(--dsw-alias-label-primary)}
.wn-row{display:flex;align-items:center;gap:6px;min-height:34px;padding:4px 6px 4px 10px;overflow:hidden}
.wn-grow{flex:1 1 auto;min-width:0}
.wn-pill{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;font-size:12px;line-height:22px}
.wn-pill:hover{border-color:var(--dsw-alias-border-l2)}
.wn-muted{color:var(--dsw-alias-label-secondary)}
.wn-add{color:var(--dsw-alias-state-success-primary)}
.wn-del{color:var(--dsw-alias-state-error-primary)}
.wn-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 7px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.wn-dot{width:6px;height:6px;border-radius:999px;flex:none}
.wn-live{background:var(--dsw-alias-state-success-primary)}
.wn-dead{background:var(--dsw-alias-state-idle-primary)}
.wn-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:24px;padding:0 8px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;white-space:nowrap}
.wn-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wn-btn:disabled{cursor:not-allowed;opacity:.45}
.wn-btn-armed{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.wn-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.wn-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);padding:0 10px}
.wn-icon{width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1}
.wn-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wn-body{border-top:1px solid var(--dsw-alias-border-l1);padding:8px 10px 10px;max-height:44vh;overflow:auto;overscroll-behavior:contain}
.wn-head{display:flex;align-items:center;gap:8px;margin:6px 0 4px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.wn-link{border:0;background:transparent;padding:0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px}
.wn-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
.wn-item{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:var(--dsw-radius-sm);min-height:26px}
.wn-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wn-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wn-tag{font-size:10px;padding:0 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);flex:none;text-transform:uppercase;letter-spacing:.03em}
.wn-tag-user{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.wn-tag-ai{color:var(--dsw-alias-link);border-color:var(--dsw-alias-link)}
.wn-check{width:14px;height:14px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:transparent;cursor:pointer;flex:none;font-size:10px;line-height:12px;padding:0}
.wn-check-on{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary-foreground)}
.wn-step-text{flex:1 1 auto;min-width:0;outline:none;border-radius:var(--dsw-radius-xs);padding:1px 3px;overflow-wrap:anywhere}
.wn-step-text:focus{background:var(--dsw-alias-bg-base);box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}
.wn-step-done .wn-step-text{text-decoration:line-through;color:var(--dsw-alias-label-secondary)}
.wn-tools{display:inline-flex;gap:2px;flex:none}
.wn-form{display:flex;gap:6px;margin-top:6px}
.wn-input{flex:1 1 auto;min-height:28px;max-height:96px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:5px 8px;font:inherit;resize:vertical}
.wn-input:focus{outline:none;border-color:var(--dsw-alias-border-l2)}
.wn-empty{padding:4px 6px;color:var(--dsw-alias-label-secondary)}
.wn-note{display:flex;gap:8px;align-items:center;padding:6px 8px;border-radius:var(--dsw-radius-sm);border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.wn-panel{padding:14px;display:flex;flex-direction:column;gap:12px;font-size:12px;color:var(--dsw-alias-label-primary)}
.wn-card{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:12px}
.wn-card-title{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--dsw-alias-label-secondary);font-weight:600}
.wn-kv{display:grid;grid-template-columns:88px minmax(0,1fr);gap:5px 10px}
.wn-kv dt{color:var(--dsw-alias-label-secondary)}
.wn-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.wn-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.wn-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.wn-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:8px 10px;background:var(--dsw-alias-bg-base)}
.wn-stat-label{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--dsw-alias-label-secondary)}
.wn-stat-value{font-size:15px;font-weight:600;margin-top:2px}
.wn-table{width:100%;border-collapse:collapse}
.wn-table th{text-align:left;font-weight:500;padding:0 6px 6px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--dsw-alias-label-secondary)}
.wn-table td{padding:6px;border-top:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.wn-table tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}
.wn-cmd{color:var(--dsw-alias-label-secondary);font-size:11px;overflow-wrap:anywhere}
.wn-title{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px}
.wn-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.wn-toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483000;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:7px 12px;box-shadow:0 8px 24px var(--dsw-alias-bg-mask-1);font-size:12px}
@media (max-width:640px){.wn-strip{width:calc(100% - 16px)}.wn-row{flex-wrap:wrap}}
`

    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function removeStyles() {
      document.getElementById(STYLE_ID)?.remove()
    }

    /* ── small components ─────────────────────────────────────────────────── */

    /** Non-blocking confirmation line, portal-free and token-styled. */
    function Toasts({ messages }) {
      if (messages.length === 0) return null
      return h(React.Fragment, null, messages.map((message) =>
        h('div', { key: message.id, className: 'wn-toast', role: 'status' }, message.text)))
    }

    function useToasts() {
      const [messages, setMessages] = useState([])
      const push = useCallback((text) => {
        const id = Math.random().toString(36).slice(2)
        setMessages(current => [...current.slice(-2), { id, text }])
        setTimeout(() => setMessages(current => current.filter(item => item.id !== id)), 2600)
      }, [])
      const node = h(Toasts, { messages })
      return [push, node]
    }

    /** Checkbox as a real button so keyboard and screen readers keep working. */
    function Check({ done, label, onToggle }) {
      return h('button', {
        type: 'button', 'className': `wn-check${done ? ' wn-check-on' : ''}`, 'aria-pressed': done,
        'aria-label': label, onClick: onToggle,
      }, '✓')
    }

    function Counts({ counts }) {
      const formatted = formatCounts(counts)
      if (formatted === null) return null
      return h(React.Fragment, null,
        h('span', { className: 'wn-add' }, formatted.added),
        h('span', { className: 'wn-del' }, formatted.deleted))
    }

    /* ── port list (shared by the drawer and the panel) ───────────────────── */

    function portUrl(port) {
      const host = port.host === '::1' ? '[::1]' : port.host === '::' || port.host === '0.0.0.0' ? '127.0.0.1' : port.host
      return `http://${host}:${port.port}`
    }

    function PortRows({ view, t, api, onDone }) {
      const ports = view.ports ?? []
      if (ports.length === 0) {
        return h('div', { className: 'wn-empty' },
          (view.capabilities?.portDiscovery ?? 'linux') === 'unsupported' ? t('workingNote.ports.unsupported') : t('workingNote.ports.empty'))
      }
      return h('div', null, ports.map((port) => h('div', { key: `${port.port}-${port.pid}`, className: 'wn-item' },
        h('span', { className: `wn-dot ${port.state === 'listening' ? 'wn-live' : 'wn-dead'}`, 'aria-hidden': true }),
        h('span', { className: 'wn-mono', style: { width: 52 } }, `:${port.port}`),
        h('span', { className: 'wn-grow wn-ellipsis' },
          h('span', null, port.processName),
          ' ',
          h('span', { className: 'wn-muted wn-mono', style: { fontSize: 11 } }, t('workingNote.ports.pid', { pid: port.pid }))),
        h('span', { className: 'wn-tag' }, port.origin),
        h('a', {
          className: 'wn-icon', href: portUrl(port), target: '_blank', rel: 'noreferrer',
          title: t('workingNote.ports.open', { port: port.port }), 'aria-label': t('workingNote.ports.open', { port: port.port }),
        }, '↗'),
        h('button', {
          type: 'button', 'className': 'wn-icon', 'title': t('workingNote.ports.copy'), 'aria-label': t('workingNote.ports.copy'),
          onClick: () => { void navigator.clipboard?.writeText(portUrl(port)).catch(() => {}) },
        }, '⧉'),
        port.state === 'listening'
          ? h('button', {
              type: 'button', 'className': 'wn-icon', 'title': t('workingNote.ports.kill'), 'aria-label': t('workingNote.ports.kill'),
              disabled: !view.capabilities?.kill,
              onClick: async () => {
                try {
                  await api.killPort(port.port)
                  onDone?.()
                } catch (error) {
                  onDone?.(error)
                }
              },
            }, '✕')
          : null)))
    }

    /** Kill all with the two-press confirmation the approved mockup uses. */
    function KillAllButton({ count, disabled, t, onKill }) {
      const [armed, setArmed] = useState(false)
      const timer = useRef(null)
      useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
      useEffect(() => { if (count === 0 && armed) setArmed(false) }, [count, armed])
      const press = () => {
        if (!armed) {
          setArmed(true)
          timer.current = setTimeout(() => setArmed(false), 3000)
          return
        }
        if (timer.current !== null) clearTimeout(timer.current)
        setArmed(false)
        void onKill()
      }
      return h('button', {
        type: 'button',
        className: `wn-btn wn-btn-danger${armed ? ' wn-btn-armed' : ''}`,
        disabled,
        title: t('workingNote.strip.killAllTitle'),
        onClick: press,
      }, armed ? `⚠ ${t('workingNote.strip.killAllArmed')}` : `⏻ ${t('workingNote.strip.killAll')} (${count})`)
    }

    /* ── step editor (shared) ─────────────────────────────────────────────── */

    function StepForm({ t, onSubmit, compact = false }) {
      const [draft, setDraft] = useState('')
      const submit = (event) => {
        event?.preventDefault?.()
        const lines = splitPasted(draft)
        if (lines.length === 0) return
        void onSubmit(lines)
        setDraft('')
      }
      return h('form', { className: 'wn-form', onSubmit: submit },
        h('textarea', {
          className: 'wn-input', rows: compact ? 1 : 2, value: draft,
          placeholder: t('workingNote.steps.addPlaceholder'), 'aria-label': t('workingNote.steps.addPlaceholder'),
          onChange: event => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit(event)
            }
          },
        }),
        h('button', { type: 'submit', className: 'wn-btn wn-btn-primary' }, t('workingNote.steps.add')))
    }

    function StepRow({ step, index, last, t, actions, readOnly }) {
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(step.text)
      useEffect(() => { setDraft(step.text) }, [step.text])
      const save = () => {
        setEditing(false)
        const text = draft.trim()
        if (text !== '' && text !== step.text) void actions.update(step.id, { text })
      }
      return h('div', { className: `wn-item wn-step${step.done ? ' wn-step-done' : ''}` },
        h(Check, { done: step.done, label: t('workingNote.steps.toggle'), onToggle: () => { if (!readOnly) void actions.update(step.id, { done: !step.done }) } }),
        editing && !readOnly
          ? h('textarea', {
              className: 'wn-input wn-step-text', rows: 2, autoFocus: true, value: draft,
              'aria-label': t('workingNote.steps.edit'),
              onChange: event => setDraft(event.target.value),
              onBlur: save,
              onKeyDown: (event) => {
                if (event.key === 'Escape') { setDraft(step.text); setEditing(false) }
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save() }
              },
            })
          : h('span', {
              className: 'wn-step-text', title: t('workingNote.steps.edit'), tabIndex: readOnly ? undefined : 0,
              role: readOnly ? undefined : 'button',
              onClick: () => { if (!readOnly) setEditing(true) },
              onKeyDown: (event) => { if (!readOnly && (event.key === 'Enter' || event.key === ' ')) setEditing(true) },
            }, step.text),
        h('span', { className: `wn-tag ${step.source === 'user' ? 'wn-tag-user' : 'wn-tag-ai'}`, title: step.source === 'user' ? 'you' : 'ai' },
          step.source === 'user' ? t('workingNote.steps.sourceUser') : t('workingNote.steps.sourceAi')),
        readOnly
          ? null
          : h('span', { className: 'wn-tools' },
              h('button', {
                type: 'button', 'className': 'wn-icon', 'title': t('workingNote.steps.moveUp'), 'aria-label': t('workingNote.steps.moveUp'),
                disabled: index === 0, onClick: () => void actions.update(step.id, { move: -1 }),
              }, '↑'),
              h('button', {
                type: 'button', 'className': 'wn-icon', 'title': t('workingNote.steps.moveDown'), 'aria-label': t('workingNote.steps.moveDown'),
                disabled: last, onClick: () => void actions.update(step.id, { move: 1 }),
              }, '↓'),
              h('button', {
                type: 'button', 'className': 'wn-icon', 'title': t('workingNote.steps.remove'), 'aria-label': t('workingNote.steps.remove'),
                onClick: () => void actions.remove(step.id),
              }, '✕')))
    }

    /* ── the pin strip (conversation.input.dock) ──────────────────────────── */

    function PinStrip(props) {
      const { view, t, api, actions, toast, openTab, pending } = props
      const [expanded, setExpanded] = useState(Boolean(view?.ui?.expanded))
      const [busy, setBusy] = useState(false)
      useEffect(() => { setExpanded(Boolean(view?.ui?.expanded)) }, [view?.ui?.expanded])

      // Nothing to pin yet: while the first SSE frame is pending the strip renders
      // nothing; after a failed load it says so instead of vanishing.
      if (view === null || view === undefined) {
        return pending === true ? null : h('div', { className: 'wn-strip' },
          h('div', { className: 'wn-row' }, h('span', { className: 'wn-muted' }, t('workingNote.tab.error', { message: '—' }))))
      }

      const git = view.git ?? null
      const live = (view.ports ?? []).filter(port => port.state === 'listening')
      const steps = view.steps ?? []
      const doneCount = steps.filter(step => step.done).length
      // A frame from another Host release may lack fields this build expects: read
      // capabilities defensively so a partial snapshot renders, never a crash.
      const capabilities = view.capabilities ?? { mutate: false, kill: false, portDiscovery: 'linux' }
      const readOnly = !capabilities.mutate
      // Each device keeps its own scope preference; a record without one falls
      // back to uncommitted, and a snapshot with neither counter renders none.
      const scope = git !== null && git.branchDelta !== undefined && git.branchDelta !== null && view.ui?.gitScope === 'branch' ? 'branch' : 'uncommitted'
      const counts = scope === 'branch' ? git.branchDelta : git.uncommitted ?? null

      const toggleExpanded = () => {
        const next = !expanded
        setExpanded(next)
        if (view !== null) void api.setUi({ expanded: next }).catch(() => {})
      }

      const killAll = async () => {
        if (busy) return
        setBusy(true)
        try {
          const result = await api.killAll()
          toast(t('workingNote.notice.killAllDone', { count: result.killed.length + result.alreadyStopped.length }))
          if (result.failed.length > 0) toast(t('workingNote.notice.killFailed', { count: result.failed.length }))
        } catch (error) {
          toast(error.message)
        } finally {
          setBusy(false)
        }
      }

      if (view === null) {
        // A failed load renders the empty state; a pending one renders nothing.
        return pending === true ? null : h('div', { className: 'wn-note' }, t('workingNote.tab.error', { message: '—' }))
      }
      const nothingToShow = (git === null || !git.isGitRepo) && steps.length === 0 && (view.ports?.length ?? 0) === 0
      if (nothingToShow && !expanded) return null

      return h('section', { className: 'wn-strip', 'aria-label': t('workingNote.strip.label'), 'data-working-note': '' },
        h('div', { className: 'wn-row' },
          git !== null && git.isGitRepo
            ? h('button', {
                type: 'button', 'className': 'wn-pill', 'title': t('workingNote.git.title'),
                onClick: () => openTab(),
              },
                h('span', { 'aria-hidden': true }, '⑂'),
                h('span', { className: 'wn-mono' }, branchLabel(git)),
                h('span', { className: 'wn-muted' }, scope === 'branch' ? t('workingNote.strip.branch') : t('workingNote.strip.uncommitted')),
                h(Counts, { counts }))
            : null,
          live.length > 0 ? h('span', { style: { display: 'inline-flex', gap: 4, minWidth: 0, overflow: 'hidden' } },
            live.slice(0, 2).map(port => h('button', {
              key: port.port, type: 'button', className: 'wn-chip', title: `${port.processName} · ${port.command}`,
              onClick: () => { window.open(portUrl(port), '_blank', 'noreferrer') },
            }, h('span', { className: 'wn-dot wn-live', 'aria-hidden': true }), `:${port.port}`)),
            live.length > 2 ? h('span', { className: 'wn-chip', title: live.slice(2).map(port => `:${port.port}`).join(', ') }, `+${live.length - 2}`) : null) : null,
          h(KillAllButton, { count: live.length, disabled: !capabilities.kill || busy, t, onKill: killAll }),
          h('span', { className: 'wn-grow' }),
          h('button', {
            type: 'button', 'className': 'wn-pill', 'title': t('workingNote.steps.title'), onClick: toggleExpanded,
            'aria-expanded': expanded,
          },
            '📌 ', h('span', null, `${doneCount}/${steps.length}`), h('span', { className: 'wn-muted' }, ` ${t('workingNote.strip.steps')}`)),
          h('button', {
            type: 'button', 'className': 'wn-icon', 'title': expanded ? t('workingNote.strip.collapse') : t('workingNote.strip.expand'),
            'aria-label': expanded ? t('workingNote.strip.collapse') : t('workingNote.strip.expand'),
            'aria-expanded': expanded, onClick: toggleExpanded,
          }, expanded ? '▴' : '▾'),
          h('button', {
            type: 'button', 'className': 'wn-icon', 'title': t('workingNote.strip.openTab'), 'aria-label': t('workingNote.strip.openTab'),
            onClick: () => openTab(),
          }, '▥')),
        view.archived !== false ? h('div', { className: 'wn-note', style: { margin: '0 10px 8px' } }, t('workingNote.tab.archived')) : null,
        expanded
          ? h('div', { className: 'wn-body' },
              h('div', { className: 'wn-head' },
                h('span', null, t('workingNote.ports.title')),
                h('span', { className: 'wn-muted' },
                  `· ${t('workingNote.ports.live', { count: live.length })}${
                    (view.ports?.length ?? 0) - live.length > 0 ? `, ${t('workingNote.ports.stopped', { count: (view.ports?.length ?? 0) - live.length })}` : ''
                  }`),
                h('span', { className: 'wn-grow' }),
                h('button', { type: 'button', className: 'wn-link', onClick: () => void api.refresh().catch(() => {}) }, t('workingNote.ports.refresh')),
                (view.ports ?? []).some(port => port.state === 'stopped')
                  ? h('button', { type: 'button', className: 'wn-link', onClick: () => void api.clearStopped() }, t('workingNote.ports.clearStopped'))
                  : null),
              h(PortRows, { view, t, api, onDone: () => {} }),
              h('div', { className: 'wn-head' },
                h('span', null, t('workingNote.steps.title')),
                h('span', { className: 'wn-grow' }),
                doneCount > 0 ? h('button', {
                  type: 'button', className: 'wn-link', disabled: readOnly,
                  onClick: () => void api.clearDone(),
                }, t('workingNote.steps.clearDone')) : null),
              steps.length === 0
                ? h('div', { className: 'wn-empty' }, t('workingNote.steps.empty'))
                : h('div', null, steps.map((step, index) => h(StepRow, {
                    key: step.id, step, index, last: index === steps.length - 1, t, actions, readOnly,
                  }))),
              readOnly ? null : h(StepForm, { t, compact: true, onSubmit: (lines) => actions.add(lines) }),
              h('div', { className: 'wn-head', style: { marginTop: 8, textTransform: 'none', letterSpacing: 0 } },
                h('span', null, t('workingNote.steps.remaining', { count: steps.length - doneCount }))))
          : null)
    }

    function branchLabel(git) {
      if (typeof git.branch !== 'string' || git.branch === '') return '—'
      return git.isWorktree ? `wt:${git.branch}` : git.branch
    }

    /* ── the right-sidebar panel ──────────────────────────────────────────── */

    function WorkingNotePanel(props) {
      const { view, t, api, actions, title } = props
      // A frame from another Host release may lack fields this build expects:
      // read capabilities defensively so a partial snapshot renders, never crashes.
      if (view === null) return h('div', { className: 'wn-panel' }, h('div', { className: 'wn-empty' }, '…'))
      const capabilities = view.capabilities ?? { mutate: false, kill: false, portDiscovery: 'linux' }
      const readOnly = !capabilities.mutate
      const git = view.git ?? null
      const ports = view.ports ?? []
      const steps = view.steps ?? []
      const live = ports.filter(port => port.state === 'listening')
      const doneCount = steps.filter(step => step.done).length
      return h('div', { className: 'wn-panel' },
        h('div', null,
          h('div', { className: 'wn-title' }, '📌 ', t('workingNote.tab.title')),
          title === undefined ? null : h('div', { className: 'wn-sub' }, t('workingNote.tab.session', { title }))),
        view.archived !== false
          ? h('div', { className: 'wn-note' }, t('workingNote.tab.archived'))
          : null,
        h('div', { className: 'wn-card' },
          h('h3', { className: 'wn-card-title' }, t('workingNote.git.title'),
            h('span', { className: 'wn-grow' }),
            h('button', { type: 'button', className: 'wn-link', onClick: () => void api.refresh().catch(() => {}) }, t('workingNote.git.refresh'))),
          git === null || !git.isGitRepo
            ? h('div', { className: 'wn-empty' }, git === null ? t('workingNote.git.notRepo') : `${t('workingNote.git.notRepo')} · ${git.cwd}`)
            : h(React.Fragment, null,
                h('dl', { className: 'wn-kv' },
                  h('dt', null, t('workingNote.git.checkout')),
                  h('dd', null, h('span', { className: 'wn-mono' }, git.cwd)),
                  h('dt', null, t('workingNote.git.branch')),
                  h('dd', { className: 'wn-mono' }, git.branch ?? '—'),
                  h('dt', null, t('workingNote.git.kind')),
                  h('dd', null, git.isWorktree ? t('workingNote.git.kindWorktree') : t('workingNote.git.kindRepo')),
                  git.baseRef === undefined ? null : h('dt', null, t('workingNote.git.base')),
                  git.baseRef === undefined ? null : h('dd', { className: 'wn-mono' }, git.baseRef)),
                h('div', { className: 'wn-stats' },
                  statRow(t('workingNote.git.uncommitted'), git.uncommitted, t),
                  statRow(t('workingNote.git.branchDelta'), git.branchDelta, t)))),
        h('div', { className: 'wn-card' },
          h('h3', { className: 'wn-card-title' }, t('workingNote.ports.title'),
            h('span', { className: 'wn-muted' }, `(${t('workingNote.ports.live', { count: live.length })})`),
            h('span', { className: 'wn-grow' }),
            h(KillAllButton, {
              count: live.length, disabled: !capabilities.kill || readOnly, t,
              onKill: () => void api.killAll().catch(() => {}),
            })),
          h('table', { className: 'wn-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('workingNote.ports.title')),
              h('th', null, t('workingNote.steps.sourceAi')),
              h('th', null, t('workingNote.git.kind')))),
            h('tbody', null, ports.length === 0
              ? h('tr', null, h('td', { colSpan: 3, className: 'wn-empty' },
                  (view.capabilities?.portDiscovery ?? 'linux') === 'unsupported' ? t('workingNote.ports.unsupported') : t('workingNote.ports.empty')))
              : ports.map(port => h('tr', { key: `${port.port}-${port.pid}` },
                  h('td', null,
                    h('span', { className: `wn-dot ${port.state === 'listening' ? 'wn-live' : 'wn-dead'}`, style: { display: 'inline-block', marginRight: 6 } }),
                    h('span', { className: 'wn-mono' }, `:${port.port}`)),
                  h('td', null,
                    h('span', { className: 'wn-mono' }, port.processName),
                    ' ', h('span', { className: 'wn-muted', style: { fontSize: 11 } }, t('workingNote.ports.pid', { pid: port.pid })),
                    h('div', { className: 'wn-cmd' }, port.command)),
                  h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                    h('span', { className: 'wn-tag' }, port.origin),
                    port.state === 'listening'
                      ? h('button', {
                          type: 'button', className: 'wn-icon', title: t('workingNote.ports.kill'), disabled: !capabilities.kill,
                          onClick: () => void api.killPort(port.port).catch(() => {}),
                        }, '✕')
                      : null)))))),
        h('div', { className: 'wn-card' },
          h('h3', { className: 'wn-card-title' }, t('workingNote.steps.title'),
            h('span', { className: 'wn-muted' }, `(${doneCount}/${steps.length})`),
            h('span', { className: 'wn-grow' }),
            h('button', {
              type: 'button', className: 'wn-link', disabled: readOnly || doneCount === 0,
              onClick: () => void api.clearDone().catch(() => {}),
            }, t('workingNote.steps.clearDone'))),
          steps.length === 0
            ? h('div', { className: 'wn-empty' }, t('workingNote.steps.empty'))
            : h('div', null, steps.map((step, index) => h(StepRow, {
                key: step.id, step, index, last: index === steps.length - 1, t, actions, readOnly,
              }))),
          readOnly ? null : h(StepForm, { t, onSubmit: (lines) => actions.add(lines) })))
    }

    /* ── the client plugin ────────────────────────────────────────────────── */

  // The module system reads `apply`/`inject` from this bundle's exports, so the
  // plugin face is a module-level object: a `return { … }` inside the factory
  // would export no entry point and the Loader entry would stay inactive.
  const face = {
    // Every service this apply touches must be injected: Cordis throws on a
    // property that is not declared ("cannot get property … without inject").
    inject: ['slots', 'locale', 'sessions', 'sidebarRightTabs', 'sidebarRight', 'uiConversation'],
    apply(ctx) {
      // A throwing apply must leave a trace in the console: the module system
      // reports activation failures, but the reason is only here.
      try {
        install(ctx)
      } catch (error) {
        console.error('[working-note] activation failed', error)
        throw error
      }
    },
  }

  /** One registration pass; every resource rides ctx effects. */
  function install(ctx) {
      ensureStyles()
      const loc = ctx.locale
      // The locale service refuses a locale a namespace already has. During an HMR
      // replacement the previous instance can still hold ours for a few ticks, so a
      // collision means "already registered", not a reason to fail the entry.
      try {
        ctx.effect(() => loc.register(NS, DICT), 'working-note: copy')
      } catch (error) {
        if (!/already has locale/.test(String(error?.message ?? error))) throw error
        console.warn('[working-note] copy already registered by a previous instance; reusing it')
      }
      // The bound translate reads the active locale at call time, so a language
      // switch needs no re-registration. `ns.key` paths keep every key unique.
      const t = loc.bind(NS)

      ctx.effect(() => () => removeStyles(), 'working-note: styles')

      /** One API + frame store per Session, shared by every surface of it. */
      const stores = new Map()

      const storeFor = (sessionId) => {
        const existing = stores.get(sessionId)
        if (existing !== undefined) return existing
        const api = createApi(sessionId)
        const store = { sessionId, api, view: null, error: null, listeners: new Set(), close: null, attached: 0 }
        // useSyncExternalStore requires getSnapshot to return the SAME reference
        // until the data changes; a fresh object per call loops (React error 185).
        store.current = { view: null, error: null }
        const publish = () => {
          store.current = { view: store.view, error: store.error }
          for (const listener of [...store.listeners]) listener()
        }
        store.subscribe = (listener) => {
          store.listeners.add(listener)
          return () => store.listeners.delete(listener)
        }
        store.snapshot = () => store.current
        store.attach = () => {
          store.attached += 1
          if (store.attached === 1) {
            store.close = store.api.open(
              (view) => { store.view = view; store.error = null; publish() },
              (error) => { store.error = error; publish() },
            )
          }
          return () => {
            store.attached -= 1
            if (store.attached > 0) return
            store.close?.()
            store.close = null
            // Keep the store cached: deleting it here would hand the next render a
            // new store (new subscribe/attach identities) and churn the effects.
          }
        }
        stores.set(sessionId, store)
        return store
      }

      const useStore = (sessionId) => {
        const store = storeFor(sessionId)
        const snapshot = React.useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
        useEffect(() => store.attach(), [store])
        return { ...snapshot, store }
      }

      const actionsFor = (store) => ({
        add: (steps) => store.api.addSteps(steps).catch((error) => { store.error = error; throw error }),
        update: (stepId, patch) => store.api.updateStep(stepId, patch).catch((error) => { store.error = error; throw error }),
        remove: (stepId) => store.api.removeStep(stepId).catch((error) => { store.error = error; throw error }),
      })

      const openTab = () => {
        // The tab type is registered above, so the controller is a hard dependency
        // like the registries; an embedded surface without it keeps the strip usable.
        try {
          ctx.sidebarRight.openTab('working-note')
        } catch (error) {
          console.warn('[working-note] cannot open the sidebar tab here', error)
        }
      }

      /* Pin strip */
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'working-note', order: 2, locale: NS,
      }, (props) => {
        const sessionId = props.sessionId
        const { view, error, store } = useStore(sessionId)
        const [toast, toasts] = useToasts()
        useEffect(() => { if (error !== null && error !== undefined) toast(error.message) }, [error, toast])
        return h(React.Fragment, null,
          h(PinStrip, { view, pending: view === null && error === null, t, api: store.api, actions: actionsFor(store), toast, openTab }),
          toasts)
      }))

      /* Sidebar tab type + body + title */
      const tabId = 'dsh-working-note'
      if (ctx.sidebarRightTabs?.register !== undefined) {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: tabId,
          kind: 'working-note',
          keepMounted: true,
          priority: 'extension',
          title: () => t('workingNote.tab.title'),
          guide: [{
            id: 'working-note',
            order: 30,
            title: () => t('workingNote.tab.guide'),
            description: () => t('workingNote.tab.guideDescription'),
          }],
        }), 'working-note: tab type')
      }
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: tabId, locale: NS,
      }, (props) => {
        const sessionId = props.sessionId
        const { view, store } = useStore(sessionId)
        const [toast, toasts] = useToasts()
        const title = props.useSession?.(session => session?.title) ?? undefined
        return h(React.Fragment, null,
          h(WorkingNotePanel, { view, t, api: store.api, actions: actionsFor(store), title }),
          toasts)
      }))
      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title', key: tabId, locale: NS,
      }, () => h('span', null, '📌 ', t('workingNote.tab.title'))))

      /* Context-menu fallback: pin the selection without the merged toolbar. */
      const interactions = ctx.uiConversation.interactions
      {
        ctx.effect(() => interactions.register({
          id: 'working-note-pin',
          onInteraction(request) {
            if (request.trigger !== 'contextmenu') return
            const text = request.readText()
            if (text === null || text.trim() === '') return
            request.preventDefault()
            const store = storeFor(request.sessionId)
            const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
            void store.api.addSteps(lines.length > 1 ? lines : [text.trim()])
              .then(result => notify(result.added > 0 ? t('workingNote.notice.added') : t('workingNote.notice.duplicate')))
              .catch(error => notify(error.message))
          },
        }), 'working-note: context menu pin')
      }

      /* Alt+Shift+P pins the current chat selection. */
      ctx.effect(() => {
        const onKey = (event) => {
          if (!(event.altKey && event.shiftKey) || event.key.toLowerCase() !== 'p') return
          const selection = window.getSelection()
          const text = selection !== null && !selection.isCollapsed ? selection.toString().trim() : ''
          if (text === '') return
          const anchored = selection.anchorNode !== null
            && (selection.anchorNode.parentElement?.closest('[data-chat-flow]') !== null)
          if (!anchored) return
          event.preventDefault()
          const sessionId = currentSessionId()
          if (sessionId === undefined) return
          const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
          void storeFor(sessionId).api.addSteps(lines.length > 1 ? lines : [text])
            .then(result => notify(result.added > 0 ? t('workingNote.notice.added') : t('workingNote.notice.duplicate')))
            .catch(error => notify(error.message))
          selection.removeAllRanges()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, 'working-note: pin shortcut')

      /** The Session currently on screen, for gesture-only entry points. */
      function currentSessionId() {
        try {
          return ctx.sidebarRight?.mounted?.getSnapshot?.() ?? undefined
        } catch {
          return undefined
        }
      }

      /** One-line confirmation outside React (gesture handlers have no render). */
      function notify(text) {
        const node = document.createElement('div')
        node.className = 'wn-toast'
        node.setAttribute('role', 'status')
        node.textContent = text
        document.body.appendChild(node)
        setTimeout(() => node.remove(), 2400)
      }
  }

  return face
},
})

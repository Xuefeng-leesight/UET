// Test-only viewer. Excluded from all production entry points and packages.
const element = (id) => document.getElementById(id);
let socket;
let count = 0;
let lastFrameAt = 0;

function clearImage(message) {
  element('image').removeAttribute('src');
  element('image').style.display = 'none';
  element('empty').style.display = '';
  element('empty').textContent = message;
}

function connect() {
  if (location.protocol === 'file:') {
    element('status').textContent = '请通过本地服务打开';
    clearImage('不能直接打开 HTML 文件。先启动 Pupil 联调服务，再访问 http://127.0.0.1:9101 。启动步骤见同目录 README.md。');
    return;
  }
  if (socket) socket.close();
  clearImage('等待 world BGR 帧。');
  element('status').textContent = '正在连接';
  element('source').textContent = '来源待确认';
  count = 0;
  lastFrameAt = 0;
  element('count').textContent = '0';
  for (const id of ['size', 'time', 'generation']) element(id).textContent = '—';
  const current = new WebSocket(`ws://${location.host}/image`);
  socket = current;
  current.onopen = () => { if (socket === current) element('status').textContent = '已连接 · 等待画面'; };
  current.onmessage = (event) => {
    if (socket !== current) return;
    const message = JSON.parse(event.data);
    if (message.type === 'pupil_diagnostic') {
      element('source').textContent = message.simulatedSource === true
        ? 'SIMULATED / 模拟数据 · 不可用于分析'
        : `Capture: ${message.captureVersion} · 未做真机验收`;
      return;
    }
    if (message.type !== 'image_frame' || message.kind !== 'scene' || message.mime !== 'image/jpeg') return;
    element('image').src = `data:image/jpeg;base64,${message.data}`;
    element('image').style.display = 'block';
    element('empty').style.display = 'none';
    element('status').textContent = 'LIVE / 预览接收中';
    element('size').textContent = `${message.width} × ${message.height}`;
    element('count').textContent = String(++count);
    element('time').textContent = Number(message.source_timestamp_s).toFixed(3);
    element('generation').textContent = String(message.connection_generation);
    lastFrameAt = performance.now();
  };
  current.onclose = () => {
    if (socket !== current) return;
    element('status').textContent = '已断开';
    clearImage('数据源或联调服务已断开。此处不保留旧画面。');
  };
  current.onerror = () => { if (socket === current) element('status').textContent = '连接失败'; };
}

setInterval(() => {
  if (lastFrameAt && performance.now() - lastFrameAt > 3000 && socket?.readyState === WebSocket.OPEN) {
    element('status').textContent = '画面超时';
    clearImage('超过 3 秒未收到场景帧。');
  }
}, 500);
element('reconnect').addEventListener('click', connect);
connect();

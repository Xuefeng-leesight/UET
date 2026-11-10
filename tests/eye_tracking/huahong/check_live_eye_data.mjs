// Feed actual Python mapper output into the production live-data consumer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile('recordingWsModule.ts',
  fs.readFileSync('src/features/recording/domain/recordingWsModule.ts', 'utf8'),
  ts.ScriptTarget.Latest, true);
const connection = source.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'connectEyeWebSocket');
assert.ok(connection, 'Production live eye-data consumer must be present');
let now = 1000;
let snapshot = {};
const frames = new Map();
let nextFrame = 0;
class Socket {
  constructor(url) { this.url = url; }
  close() { this.onclose?.(); }
}
const context = vm.createContext({
  exports: {}, WebSocket: Socket, console,
  performance: { now: () => now },
  window: {
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
  },
});
vm.runInContext(ts.transpileModule(connection.getText(source), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, context);
const wsEyeRef = { current: null };
context.exports.connectEyeWebSocket({
  wsIp: '127.0.0.1', wsEyePort: '9002', wsEyeRef,
  setEyeData(updater) { snapshot = typeof updater === 'function' ? updater(snapshot) : updater; },
});
assert.ok(wsEyeRef.current);
for (const { message, left, right } of JSON.parse(fs.readFileSync(0, 'utf8'))) {
  now += 60;
  wsEyeRef.current.onmessage({ data: JSON.stringify(message) });
  assert.equal(snapshot.sourceModel, message.source);
  for (const [eye, point] of [['left', left], ['right', right]]) {
    assert.equal(snapshot[`${eye}PupilCenterX`], point === null ? '' : String(point[0]));
    assert.equal(snapshot[`${eye}PupilCenterY`], point === null ? '' : String(point[1]));
    assert.equal(snapshot[`${eye}PupilDiameter`], '');
    assert.equal(snapshot[`${eye}PupilDiameterMm`], '');
  }
  assert.equal(snapshot.recomGazeX, String(message.eye_data.re_gaze.gaze?.x ?? ''));
  assert.equal(snapshot.recomGazeY, String(message.eye_data.re_gaze.gaze?.y ?? ''));
}
wsEyeRef.current.close();
assert.equal(wsEyeRef.current, null);
assert.equal(frames.size, 0);
console.log('Huahong live pupil centers display raw valid values and clear invalid or missing values.');

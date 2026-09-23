import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorHistory } from '../custom_components/ha3d_lab/frontend/ha3d-editor-history.js';
test('failed undo retains command; success roundtrips; new edit clears redo', async () => {
  const history = new EditorHistory(); let position = 2;
  history.record({before:{x:1},after:{x:2}});
  await assert.rejects(history.travel('undo', async()=>{throw Error('500')}));
  assert.equal(history.undoStack.length,1);assert.equal(history.redoStack.length,0);assert.equal(history.busy,false);
  await history.travel('undo',async state=>{position=state.x});assert.equal(position,1);
  await history.travel('redo',async state=>{position=state.x});assert.equal(position,2);
  await history.travel('undo',async state=>{position=state.x});history.record({before:{x:1},after:{x:3}});
  assert.equal(history.redoStack.length,0);
});
test('slow operation excludes concurrent undo and history is bounded',async()=>{
  const history=new EditorHistory(2);for(let x=0;x<3;x++)history.record({before:{x},after:{x:x+1}});
  assert.equal(history.undoStack.length,2);let release;
  const pending=history.travel('undo',()=>new Promise(resolve=>{release=resolve}));
  assert.equal(await history.travel('undo',async()=>{}),false);release();await pending;
  assert.equal(history.undoStack.length,1);assert.equal(history.redoStack.length,1);
});

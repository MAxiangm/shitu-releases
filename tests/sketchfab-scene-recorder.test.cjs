'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installSketchfabSceneRecorder, createBlueprint, normalizeChannel, multiply, inverse } = require('../extension/sketchfab-scene-recorder.js');
const I = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const id = '0123456789abcdef0123456789abcdef';
function rawScene() {
  return { Generator: 'OpenSceneGraph 3.3.8', Version: 9, 'osg.Node': { UniqueID: 1, UpdateCallbacks: [{ 'osgAnimation.BasicAnimationManager': { Animations: [{}] } }], Children: [{ 'osgAnimation.Skeleton': { UniqueID: 2, Children: [
    { 'osgAnimation.Bone': { UniqueID: 3, Name: 'joint', InvBindMatrixInSkeletonSpace: I, UpdateCallbacks: [{ 'osgAnimation.UpdateBone': { Name: 'target', StackedTransforms: [
      { 'osgAnimation.StackedTranslate': { Name: 'translate', Translate: [0,0,0] } }, { 'osgAnimation.StackedQuaternion': { Name: 'rotate', Quaternion: [0,0,0,1] } }, { 'osgAnimation.StackedScale': { Name: 'scale', Scale: [1,1,1] } }
    ] } }] } },
    { 'osgAnimation.RigGeometry': { UniqueID: 5, BoneMap: { joint: 0 }, SourceGeometry: { 'osg.Geometry': { UniqueID: 6 } } } }
  ] } }] } };
}
async function fixture() {
  const positions = {}, indices = {};
  const attribute = (values, buffer) => ({ _buffer: buffer, getElements: () => new Float32Array(values), getItemSize: () => 4 });
  const rig = { _uniqueID: 5, getAttributes: () => ({ Vertex: { _buffer: positions }, Bones: attribute([0,0,0,0,0,0,0,0,0,0,0,0]), Weights: attribute([2,0,0,0,0.5,0.5,0,0,1,0,0,0]) }), getPrimitives: () => [{ getMode: () => 4, getIndices: () => ({ _buffer: indices }) }], getMatrixFromSkeletonToGeometry: () => I };
  class Input { constructor(type, value) { this.type = type; this.value = value; } getJSON() { return { [this.type]: {} }; } readObject() { return Promise.resolve(this.value); } }
  function factory() { return 'x.globalify=function window.osgAnimation= window.osgDB='; }
  const framework = { osgDB: { Input }, osgAnimation: { Channel: { ChannelType: { Vec3: 0, Quat: 1, QuatSlerp: 5 } } } };
  const req = () => ({ Z: framework }); req.m = { fixture: factory };
  const chunks = []; chunks.push = function (item) { item[2](req); return Array.prototype.push.call(this, item); };
  const scope = { location: { href: `https://sketchfab.com/models/${id}/embed` }, JSON: { parse: JSON.parse }, webpackChunksketchfab: chunks };
  const originalParse = scope.JSON.parse, originalRead = Input.prototype.readObject;
  const recorder = installSketchfabSceneRecorder(scope);
  scope.JSON.parse(JSON.stringify(rawScene()));
  await new Input('osgAnimation.RigGeometry', rig).readObject();
  await new Input('osgAnimation.Animation', { name: 'walk', channels: [{ type: 0, name: 'translate', target: 'target', times: new Float32Array([0,1]), keys: new Float32Array([0,0,0,1,0,0]) }] }).readObject();
  await Promise.resolve();
  return { recorder, scope, positions, indices, originalParse, originalRead, Input };
}
test('raw hierarchy captures initial TRS and callback target names separately from bone names', () => {
  const source = rawScene(), b = createBlueprint(source);
  assert.equal(b.nodes.length, 4); assert.equal(b.expectedAnimations, 1);
  assert.deepEqual(b.targets.get('target.rotate'), { node: 2, path: 'rotation' });
  source['osg.Node'].Children[0]['osgAnimation.Skeleton'].Children[0]['osgAnimation.Bone'].UpdateCallbacks[0]['osgAnimation.UpdateBone'].StackedTransforms[0]['osgAnimation.StackedTranslate'].Translate[0] = 9;
  assert.deepEqual(b.nodes[2].output.translation, [0,0,0]);
});
test('buffer identity matches a rig; skin influences, hierarchy and real keys become scene payload', async () => {
  const f = await fixture();
  try {
    assert.equal(f.recorder.match({}, f.indices), null);
    const binding = f.recorder.match(f.positions, f.indices); assert.ok(binding);
    const result = f.recorder.buildScene([{ binding, meshIndex: 0, vertexIndices: [2,0,1], worldMatrix: I }]);
    assert.equal(result.scene.skins.length, 1); assert.equal(result.scene.animations[0].channels[0].node, 2);
    assert.deepEqual(result.skinData[0].weights, [1,0,0,0,1,0,0,0,0.5,0.5,0,0]);
    assert.deepEqual(result.scene.skins[0].inverseBindMatrices, I);
    assert.equal(result.scene.nodes[3].mesh, 0); assert.equal(result.scene.nodes[3].skin, 0);
  } finally { f.recorder.dispose(); }
  assert.equal(f.scope.JSON.parse, f.originalParse); assert.equal(f.Input.prototype.readObject, f.originalRead);
});
test('source navigation invalidates bindings and prevents cross-model skeleton mixing', async () => {
  const f = await fixture(); const binding = f.recorder.match(f.positions, f.indices);
  f.scope.location.href = 'https://sketchfab.com/models/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/embed';
  assert.equal(f.recorder.match(f.positions, f.indices), null);
  assert.throws(() => f.recorder.buildScene([{ binding, meshIndex: 0, vertexIndices: [0] }]), /UNSUPPORTED/);
  f.recorder.dispose();
});
test('duplicate float32 key times collapse only when values are equivalent', () => {
  const target = { node: 0, path: 'translation' };
  assert.deepEqual(normalizeChannel({ type:0,times:[0,0,1],keys:[0,0,0,0,0,0,1,0,0] }, target).times, [0,1]);
  assert.throws(() => normalizeChannel({ type:0,times:[0,0,1],keys:[0,0,0,9,0,0,1,0,0] }, target), /UNSUPPORTED/);
});
test('nlerp quaternion keys receive real intermediate samples for glTF slerp', () => {
  const a = [0,0,0,1], b = [0,0,Math.sin(Math.PI/3),Math.cos(Math.PI/3)];
  const result = normalizeChannel({type:1,times:[0,1],keys:[...a,...b]}, {node:0,path:'rotation'});
  assert.ok(result.times.length > 2);
  for (let i = 0; i < result.times.length; i++) {
    const t=result.times[i], expected=a.map((v,j)=>v*(1-t)+b[j]*t), length=Math.hypot(...expected);
    assert.ok(Math.hypot(...expected.map((v,j)=>v/length-result.values[i*4+j])) < 1e-7);
  }
});
test('converted quaternion curve agrees with source nlerp between every exported key', () => {
  const a=[0,0,0,1], b=[0,Math.sin(1.45),0,Math.cos(1.45)];
  const result=normalizeChannel({type:1,times:[0,1],keys:[...a,...b]},{node:0,path:'rotation'});
  const unit=v=>{const d=Math.hypot(...v);return v.map(x=>x/d);};
  for(let i=0;i<result.times.length-1;i++)for(let step=1;step<16;step++){
    const fraction=step/16,t=result.times[i]*(1-fraction)+result.times[i+1]*fraction;
    const expected=unit(a.map((x,j)=>x*(1-t)+b[j]*t)),from=result.values.slice(i*4,i*4+4),to=result.values.slice((i+1)*4,(i+2)*4);
    const angle=Math.acos(Math.min(1,from.reduce((s,x,j)=>s+x*to[j],0)));
    const actual=angle<1e-8?from:from.map((x,j)=>(Math.sin((1-fraction)*angle)*x+Math.sin(fraction*angle)*to[j])/Math.sin(angle));
    assert.ok(2*Math.hypot(...actual.map((x,j)=>x-expected[j]))<1e-5);
  }
});
test('one source rig may contribute multiple preserved primitives', async () => {
  const f=await fixture();try{
    const binding=f.recorder.match(f.positions,f.indices);assert.equal(binding.isRig,true);assert.equal(f.recorder.requiresScene(),true);
    const out=f.recorder.buildScene([{binding,meshIndex:0,vertexIndices:[0],worldMatrix:I},{binding,meshIndex:1,vertexIndices:[1],worldMatrix:I}]);
    assert.deepEqual(out.scene.nodes.filter(n=>n.mesh!==undefined).map(n=>n.mesh),[0,1]);assert.equal(out.skinData.length,2);
  }finally{f.recorder.dispose();}
});
test('matrix inverse preserves nonidentity geometry-to-skeleton correction', () => {
  const m=[1,0,0,0,0,0,-1,0,0,1,0,0,2,3,4,1];
  assert.deepEqual(multiply(m,inverse(m)),I);
});
test('non-TRS stacked transforms are explicitly unsupported', () => {
  const raw=rawScene(); raw['osg.Node'].Children[0]['osgAnimation.Skeleton'].Children[0]['osgAnimation.Bone'].UpdateCallbacks[0]['osgAnimation.UpdateBone'].StackedTransforms.push({'osgAnimation.StackedRotateAxis':{Name:'axis'}});
  assert.equal(createBlueprint(raw).unsupported,true);
});
test('missing or changed private runtime fails closed without affecting JSON parsing', () => {
  const scope = { location:{href:`https://sketchfab.com/models/${id}/embed`}, JSON:{parse:JSON.parse}, webpackChunksketchfab:[] };
  const before=scope.JSON.parse, recorder=installSketchfabSceneRecorder(scope);
  assert.deepEqual(scope.JSON.parse('{"a":1}'),{a:1});
  assert.doesNotThrow(()=>scope.JSON.parse(JSON.stringify(rawScene())));
  assert.equal(recorder.match({},{}),null);
  assert.throws(()=>recorder.buildScene([]),/UNSUPPORTED/);
  recorder.dispose();assert.equal(scope.JSON.parse,before);
});

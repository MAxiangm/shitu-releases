(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MosaicSketchfabSceneRecorder = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const NODE_TYPES = new Set(['osg.Node', 'osg.MatrixTransform', 'osg.Geometry', 'osgAnimation.RigGeometry', 'osgAnimation.Skeleton', 'osgAnimation.Bone']);
  const MAX_NODES = 4096, MAX_KEYS = 500000, MAX_CLIPS = 64;
  function fail(code = 'SKETCHFAB_VIEWER_UNSUPPORTED') { throw Object.assign(new Error(code), { code }); }
  function modelId(url) {
    try { const u = new URL(url); if (u.protocol !== 'https:' || !['sketchfab.com', 'www.sketchfab.com'].includes(u.hostname) || u.port || u.username || u.password) return null;
      return /^\/models\/([a-f0-9]{32})\/embed\/?$/.exec(u.pathname)?.[1] || /(?:^|-)([a-f0-9]{32})$/.exec(/^\/3d-models\/([^/]+)\/?$/.exec(u.pathname)?.[1] || '')?.[1] || null;
    } catch { return null; }
  }
  function nums(values, size) {
    if (!(Array.isArray(values) || ArrayBuffer.isView(values)) || values.length !== size) fail();
    const result = Array.from(values); if (!result.every(x => typeof x === 'number' && Number.isFinite(x))) fail(); return result;
  }
  function quat(values) { const v = nums(values, 4), length = Math.hypot(...v); if (length < 1e-12) fail(); return v.map(x => x / length); }
  function name(value) { if (typeof value !== 'string' || value.length > 240 || /[\x00-\x1f]/.test(value)) fail(); return value; }
  function multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return out;
  }
  function inverse(m) {
    const a = Array.from({ length: 4 }, (_, r) => [...Array.from({ length: 4 }, (_, c) => m[c * 4 + r]), ...Array.from({ length: 4 }, (_, c) => r === c ? 1 : 0)]);
    for (let c = 0; c < 4; c++) {
      let pivot = c; for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
      if (Math.abs(a[pivot][c]) < 1e-12) fail(); [a[c], a[pivot]] = [a[pivot], a[c]];
      const divisor = a[c][c]; for (let k = 0; k < 8; k++) a[c][k] /= divisor;
      for (let r = 0; r < 4; r++) if (r !== c) { const f = a[r][c]; for (let k = 0; k < 8; k++) a[r][k] -= f * a[c][k]; }
    }
    return Array.from({ length: 16 }, (_, i) => a[i % 4][4 + Math.floor(i / 4)]);
  }
  function transform(node) {
    if (node.matrix) return node.matrix;
    const [x, y, z, w] = node.rotation || [0, 0, 0, 1], [sx, sy, sz] = node.scale || [1, 1, 1], [tx, ty, tz] = node.translation || [0, 0, 0];
    return [(1 - 2 * (y*y+z*z))*sx, 2*(x*y+z*w)*sx, 2*(x*z-y*w)*sx, 0,
      2*(x*y-z*w)*sy, (1-2*(x*x+z*z))*sy, 2*(y*z+x*w)*sy, 0,
      2*(x*z+y*w)*sz, 2*(y*z-x*w)*sz, (1-2*(x*x+y*y))*sz, 0, tx, ty, tz, 1];
  }
  function createBlueprint(document) {
    const nodes = [], byId = new Map(), targets = new Map(); let expectedAnimations = 0, unsupported = false;
    function visit(wrapper, parent = null, depth = 0) {
      if (depth > 80 || !wrapper || typeof wrapper !== 'object') fail();
      const type = Object.keys(wrapper).find(key => NODE_TYPES.has(key)); if (!type) fail();
      const raw = wrapper[type], id = raw.UniqueID;
      if (id !== undefined && (!Number.isSafeInteger(id) || id < 0)) fail();
      if (id !== undefined && byId.has(id)) fail(); // Source DAGs need distinct glTF nodes, never silently reparent them.
      if (nodes.length >= MAX_NODES) fail('SKETCHFAB_VIEWER_TOO_LARGE');
      const node = { index: nodes.length, id, type, parent, children: [], output: {}, bindings: [], boneMap: null };
      nodes.push(node); if (id !== undefined) byId.set(id, node);
      if (raw.Name !== undefined) node.output.name = name(raw.Name);
      if (raw.InvBindMatrixInSkeletonSpace) node.inverseBind = nums(raw.InvBindMatrixInSkeletonSpace, 16);
      let hasStack = false;
      for (const callback of raw.UpdateCallbacks || []) {
        const callbackType = Object.keys(callback)[0], cb = callback[callbackType];
        if (callbackType === 'osgAnimation.BasicAnimationManager') { expectedAnimations += cb.Animations?.length || 0; continue; }
        if (!cb.StackedTransforms) continue;
        if (hasStack || !['osgAnimation.UpdateBone', 'osgAnimation.UpdateMatrixTransform'].includes(callbackType)) { unsupported = true; continue; }
        hasStack = true; const order = [];
        for (const item of cb.StackedTransforms) {
          const kind = Object.keys(item)[0], value = item[kind]; let path;
          if (kind === 'osgAnimation.StackedTranslate') { path = 'translation'; node.output.translation = nums(value.Translate, 3); }
          else if (kind === 'osgAnimation.StackedQuaternion') { path = 'rotation'; node.output.rotation = quat(value.Quaternion); }
          else if (kind === 'osgAnimation.StackedScale') { path = 'scale'; node.output.scale = nums(value.Scale, 3); }
          else { unsupported = true; continue; }
          const key = name(cb.Name) + '.' + name(value.Name); if (targets.has(key) || order.includes(path)) fail();
          targets.set(key, { node: node.index, path }); node.bindings.push(key); order.push(path);
        }
        if (order.join(',') !== ['translation', 'rotation', 'scale'].filter(p => order.includes(p)).join(',')) unsupported = true;
      }
      if (!hasStack && raw.Matrix) node.output.matrix = nums(raw.Matrix, 16);
      if (raw.BoneMap) {
        node.boneMap = new Map();
        for (const [key, value] of Object.entries(raw.BoneMap)) { name(key); if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_NODES || node.boneMap.has(value)) fail(); node.boneMap.set(value, key); }
      }
      if (JSON.stringify(raw.SourceGeometry || {}).includes('osgAnimation.MorphGeometry')) unsupported = true;
      for (const child of raw.Children || []) node.children.push(visit(child, node.index, depth + 1));
      return node.index;
    }
    // Establish world transforms in preorder (children are visited recursively).
    function worlds(index, parent) { const n = nodes[index]; n.world = multiply(parent, transform(n.output)); for (const child of n.children) worlds(child, n.world); }
    const rootKey = Object.keys(document).find(key => NODE_TYPES.has(key)); if (!rootKey) fail();
    const root = visit({ [rootKey]: document[rootKey] }); worlds(root, IDENTITY);
    return { nodes, byId, targets, root, expectedAnimations, unsupported };
  }
  function copyAnimation(value) {
    if (!value || !Array.isArray(value.channels) || value.channels.length > MAX_NODES) fail();
    let count = 0;
    const channels = value.channels.map(channel => {
      if (!channel || ![0, 1, 5].includes(channel.type)) fail();
      const size = channel.type === 0 ? 3 : 4, length = channel.times?.length;
      if (!Number.isSafeInteger(length) || length < 1 || (count += length) > MAX_KEYS) fail('SKETCHFAB_VIEWER_TOO_LARGE');
      return { type: channel.type, name: name(channel.name), target: name(channel.target), times: nums(channel.times, length), keys: nums(channel.keys, length * size) };
    });
    return { name: name(value.name), channels };
  }
  function near(a, b, epsilon = 1e-5) { return a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= epsilon * Math.max(1, Math.abs(x), Math.abs(b[i]))); }
  function normalizeChannel(channel, target) {
    const size = target.path === 'rotation' ? 4 : 3;
    if ((size === 3) !== (channel.type === 0)) fail();
    const times = [], values = [];
    for (let i = 0; i < channel.times.length; i++) {
      const t = Math.fround(channel.times[i]), v = size === 4 ? quat(channel.keys.slice(i*size, (i+1)*size)) : channel.keys.slice(i*size, (i+1)*size);
      if (t < 0 || (times.length && t < times.at(-1))) fail();
      if (times.length && t === times.at(-1)) {
        const last = values.slice(-size); if (size === 4 && last.reduce((s, x, j) => s + x * v[j], 0) < 0) for (let j = 0; j < size; j++) v[j] = -v[j];
        if (!near(last, v)) fail(); values.splice(values.length - size, size, ...v); continue;
      }
      if (size === 4 && values.length && values.slice(-size).reduce((s, x, j) => s + x * v[j], 0) < 0) for (let j = 0; j < size; j++) v[j] = -v[j];
      times.push(t); values.push(...v);
    }
    // glTF LINEAR quaternion tracks use slerp. Subdivide source nlerp curves until
    // each interval differs by <= 1e-5 radians from that standard interpolation.
    if (channel.type === 1 && times.length > 1) {
      const outTimes = [times[0]], outValues = values.slice(0, 4);
      function insert(a, b, ta, tb, sourceA, sourceB, sourceStart, sourceEnd, depth = 0) {
        let dot = Math.max(-1, Math.min(1, a.reduce((s, x, i) => s + x*b[i], 0))), angle = Math.acos(dot);
        const error = Math.max(...[.25, .5, .75].map(fraction => {
          const sourceU = (ta + (tb-ta)*fraction-sourceStart)/(sourceEnd-sourceStart);
          const nlerp = quat(sourceA.map((x, i) => x*(1-sourceU)+sourceB[i]*sourceU));
          const slerp = angle < 1e-8 ? a : a.map((x, i) => (Math.sin((1-fraction)*angle)*x+Math.sin(fraction*angle)*b[i])/Math.sin(angle));
          return Math.hypot(...nlerp.map((x, i) => x-slerp[i])) * 2;
        }));
        if (error > 5e-6) {
          if (depth >= 12 || outTimes.length >= MAX_KEYS) fail('SKETCHFAB_VIEWER_TOO_LARGE');
          const tm = Math.fround((ta+tb)/2); if (tm === ta || tm === tb) fail(); const u = (tm-sourceStart)/(sourceEnd-sourceStart), middle = quat(sourceA.map((x, i) => x*(1-u)+sourceB[i]*u));
          insert(a, middle, ta, tm, sourceA, sourceB, sourceStart, sourceEnd, depth+1); insert(middle, b, tm, tb, sourceA, sourceB, sourceStart, sourceEnd, depth+1);
        } else { outTimes.push(tb); outValues.push(...b); }
      }
      for (let i = 1; i < times.length; i++) { const a = values.slice((i-1)*4,i*4), b = values.slice(i*4,(i+1)*4); insert(a, b, times[i-1], times[i], a, b, times[i-1], times[i]); }
      return { node: target.node, path: target.path, times: outTimes, values: outValues, interpolation: 'LINEAR' };
    }
    return { node: target.node, path: target.path, times, values, interpolation: 'LINEAR' };
  }
  function glBuffer(attribute) { return (attribute?.getBufferArray?.() || attribute)?._buffer; }
  function installSketchfabSceneRecorder(scope) {
    if (!modelId(scope?.location?.href)) return null;
    let currentId = modelId(scope.location.href), epoch = 0, blueprint, broken = false, disposed = false, inputRestore, parseRestore, installed = false;
    const runtimes = new Map(), animations = new Map(); let channelTypes, generation = 0, matchesByPosition = new WeakMap();
    function sync() { const id = modelId(scope.location?.href); if (id !== currentId) { currentId = id; epoch++; blueprint = null; broken = false; runtimes.clear(); animations.clear(); matchesByPosition = new WeakMap(); generation++; inputRestore?.(); inputRestore = null; installed = false; } return id && !disposed; }
    function observe(value, type) {
      if (!sync()) return;
      try {
        if (type === 'osgAnimation.Animation') { const copy = copyAnimation(value); if (animations.size >= MAX_CLIPS && !animations.has(copy.name)) fail('SKETCHFAB_VIEWER_TOO_LARGE'); animations.set(copy.name, copy); if ([...animations.values()].reduce((n,a)=>n+a.channels.reduce((s,c)=>s+c.times.length,0),0)>MAX_KEYS) fail('SKETCHFAB_VIEWER_TOO_LARGE'); }
        else if (NODE_TYPES.has(type) && Number.isSafeInteger(value?._uniqueID)) { if (runtimes.size >= MAX_NODES && !runtimes.has(value._uniqueID)) fail('SKETCHFAB_VIEWER_TOO_LARGE'); runtimes.set(value._uniqueID, value); generation++; }
      } catch { broken = true; }
    }
    function installInputObserver() {
      if (installed) return;
      const chunks = scope.webpackChunksketchfab; if (!Array.isArray(chunks)) return;
      let requireModule; const marker = ['mosaic_scene_observer_' + Math.random().toString(36).slice(2)];
      chunks.push([marker, {}, function (require) { requireModule = require; }]);
      if (!requireModule?.m) return;
      const candidates = Object.keys(requireModule.m).filter(key => {
        const source = Function.prototype.toString.call(requireModule.m[key]);
        return /\.globalify\s*=\s*function/.test(source) && source.includes('window.osgAnimation=') && source.includes('window.osgDB=');
      });
      if (candidates.length !== 1) return;
      const osg = requireModule(candidates[0])?.Z, proto = osg?.osgDB?.Input?.prototype;
      if (typeof proto?.readObject !== 'function') return;
      channelTypes = osg.osgAnimation?.Channel?.ChannelType;
      if (channelTypes?.Vec3 !== 0 || channelTypes?.Quat !== 1 || channelTypes?.QuatSlerp !== 5) return;
      const original = proto.readObject;
      function wrapped(...args) {
        const active = sync(), id = currentId, stamp = epoch, type = Object.keys(this.getJSON?.() || {})[0], result = original.apply(this, args);
        if (active && (NODE_TYPES.has(type) || type === 'osgAnimation.Animation') && result?.then) result.then(value => { if (sync() && id === currentId && stamp === epoch) observe(value, type); }, () => {});
        return result;
      }
      proto.readObject = wrapped; inputRestore = () => { if (proto.readObject === wrapped) proto.readObject = original; }; installed = true;
    }
    const JSONScope = scope.JSON || JSON, parse = JSONScope.parse;
    function wrappedParse(...args) {
      const result = parse.apply(this, args);
      if (sync() && !blueprint && args[1] === undefined && typeof args[0] === 'string' && args[0].length <= 16*1024*1024 && result && typeof result === 'object' && typeof result.Generator === 'string' && Object.keys(result).some(k => NODE_TYPES.has(k))) {
        try { blueprint = createBlueprint(result); installInputObserver(); } catch { broken = true; }
      }
      return result;
    }
    JSONScope.parse = wrappedParse; parseRestore = () => { if (JSONScope.parse === wrappedParse) JSONScope.parse = parse; };
    function match(position, element) {
      if (!sync() || broken || !blueprint || blueprint.unsupported) return null;
      if (!position || typeof position !== 'object') return null;
      let bucket = matchesByPosition.get(position);
      if (!bucket) { bucket = new Map(); matchesByPosition.set(position, bucket); }
      const cached = bucket.get(element || null); if (cached?.generation === generation) return cached.binding;
      const matches = [];
      for (const node of blueprint.nodes) {
        if (!['osgAnimation.RigGeometry', 'osg.Geometry'].includes(node.type)) continue;
        const runtime = runtimes.get(node.id), attributes = runtime?.getAttributes?.() || runtime?.getVertexAttributeList?.();
        if (!runtime || glBuffer(attributes?.Vertex) !== position) continue;
        const primitives = runtime.getPrimitives?.() || [];
        if (!primitives.some(p => [4,5,6].includes(p.getMode?.()) && (element ? glBuffer(p.getIndices?.()) === element : !p.getIndices?.()))) continue;
        matches.push({ node, runtime, attributes, isRig: node.type === 'osgAnimation.RigGeometry', modelId: currentId });
      }
      const binding = matches.length === 1 ? matches[0] : null; bucket.set(element || null, { generation, binding }); return binding;
    }
    function buildScene(entries) {
      if (!sync() || broken || !blueprint || blueprint.unsupported || !installed) fail();
      if (!entries.length || entries.length > 512 || animations.size < blueprint.expectedAnimations) fail('SKETCHFAB_VIEWER_UNAVAILABLE');
      const nodes = blueprint.nodes.map(n => ({ ...n.output, ...(n.children.length ? { children: n.children.slice() } : {}) })), skins = [], skinData = [], extraMeshNodes = [];
      let correction, hasNlerp = false;
      const needed = new Set();
      function retain(index) { while (index !== null && !needed.has(index)) { needed.add(index); index = blueprint.nodes[index].parent; } }
      function currentWorld(index) {
        const node = blueprint.nodes[index], runtime = runtimes.get(node.id), matrix = runtime?.getMatrix?.();
        const local = matrix ? nums(matrix,16) : transform(node.output);
        return node.parent === null ? local : multiply(currentWorld(node.parent),local);
      }
      function attach(nodeIndex, mesh, skin) {
        const value = { mesh, ...(skin === undefined ? {} : { skin }) };
        if (nodes[nodeIndex].mesh === undefined) Object.assign(nodes[nodeIndex],value);
        else extraMeshNodes.push({ parent: nodeIndex, value });
      }
      for (const entry of entries) {
        const { binding, meshIndex, vertexIndices } = entry;
        if (!binding || binding.modelId !== currentId || !Number.isInteger(meshIndex) || !Array.isArray(vertexIndices)) fail();
        const { node, runtime, attributes } = binding; if (blueprint.nodes[node.index] !== node) fail();
        // Some render passes optimize uModelMatrix out. OSG's own world matrix
        // supplies the same transform without trying to invert the camera.
        // Read both source hierarchy and its world transform synchronously;
        // a cached draw matrix can belong to an earlier animation frame.
        const worldMatrix = runtime.getWorldMatrices?.()?.[0] || entry.worldMatrix;
        if (!binding.isRig) {
          attach(node.index,meshIndex); retain(node.index);
          if (worldMatrix) {
            const candidate = multiply(nums(worldMatrix,16),inverse(currentWorld(node.index)));
            if(correction && !near(correction,candidate,1e-4)) fail(); correction = candidate;
          }
          continue;
        }
        if (!node.boneMap) fail();
        let skeleton = node;
        while (skeleton && skeleton.type !== 'osgAnimation.Skeleton') skeleton = skeleton.parent === null ? null : blueprint.nodes[skeleton.parent];
        if (!skeleton) fail();
        const byName = new Map();
        for (const bone of blueprint.nodes) if (bone.type === 'osgAnimation.Bone') { let ancestor = bone; while (ancestor && ancestor !== skeleton) ancestor = ancestor.parent === null ? null : blueprint.nodes[ancestor.parent]; if (ancestor) { if (byName.has(bone.output.name)) fail(); byName.set(bone.output.name, bone); } }
        const matrixFromSkeleton = nums(runtime.getMatrixFromSkeletonToGeometry?.(), 16), joints = [], inverseBindMatrices = [];
        for (let i = 0; i < node.boneMap.size; i++) { const bone = byName.get(node.boneMap.get(i)); if (!bone?.inverseBind) fail(); joints.push(bone.index); inverseBindMatrices.push(...multiply(bone.inverseBind, matrixFromSkeleton)); retain(bone.index); }
        if (worldMatrix) {
          const candidate = multiply(multiply(nums(worldMatrix, 16), inverse(matrixFromSkeleton)), inverse(currentWorld(skeleton.index)));
          if (correction && !near(correction, candidate, 1e-4)) fail(); correction = candidate;
        }
        const bones = attributes.Bones?.getElements?.(), weights = attributes.Weights?.getElements?.();
        if (attributes.Bones?.getItemSize?.() !== 4 || attributes.Weights?.getItemSize?.() !== 4 || !bones || !weights || bones.length !== weights.length) fail();
        const meshJoints = [], meshWeights = [];
        for (const vertex of vertexIndices) {
          if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex * 4 + 4 > bones.length) fail();
          const w = nums(weights.subarray ? weights.subarray(vertex*4,vertex*4+4) : weights.slice(vertex*4,vertex*4+4), 4), sum = w.reduce((a,b)=>a+b,0);
          if (sum <= 0 || w.some(x => x < 0)) fail();
          for (let c = 0; c < 4; c++) { const index = bones[vertex*4+c]; if (!Number.isInteger(index) || index < 0 || index >= joints.length) fail(); meshJoints.push(index); meshWeights.push(w[c]/sum); }
        }
        const skin = skins.push({ joints, inverseBindMatrices, skeleton: skeleton.index }) - 1;
        attach(node.index,meshIndex,skin);
        skinData.push({ meshIndex, joints: meshJoints, weights: meshWeights }); retain(node.index);
      }
      const clips = []; let outputKeyCount = 0;
      for (const animation of animations.values()) {
        const channels = [], used = new Set();
        for (const channel of animation.channels) {
          const target = blueprint.targets.get(channel.target+'.'+channel.name); if (!target) fail();
          if (!needed.has(target.node)) continue;
          const key = target.node+':'+target.path; if (used.has(key)) fail(); used.add(key);
          const normalized = normalizeChannel(channel, target);
          outputKeyCount += normalized.times.length; if (outputKeyCount > MAX_KEYS) fail('SKETCHFAB_VIEWER_TOO_LARGE');
          channels.push(normalized); if (channel.type === 1) hasNlerp = true;
        }
        if (channels.length) clips.push({ name: animation.name, channels });
      }
      const remap = new Map([...needed].sort((a,b)=>a-b).map((old, i) => [old, i]));
      const keptNodes = [...remap.keys()].map(index => { const n = { ...nodes[index] }; if (n.children) { n.children = n.children.filter(c=>needed.has(c)).map(c=>remap.get(c)); if (!n.children.length) delete n.children; } return n; });
      for (const extra of extraMeshNodes) { const parent = keptNodes[remap.get(extra.parent)]; (parent.children ||= []).push(keptNodes.length); keptNodes.push(extra.value); }
      for (const skin of skins) { skin.joints = skin.joints.map(j=>remap.get(j)); skin.skeleton = remap.get(skin.skeleton); }
      for (const clip of clips) for (const channel of clip.channels) channel.node = remap.get(channel.node);
      if (correction && !near(correction, IDENTITY, 1e-7)) keptNodes.push({ matrix: correction, children: [remap.get(blueprint.root)] });
      return { scene: { nodes: keptNodes, ...(skins.length ? { skins } : {}), ...(clips.length ? { animations: clips } : {}) }, skinData, warnings: hasNlerp ? ['四元数动画已按原始插值细分为 glTF 标准关键帧。'] : [] };
    }
    return Object.freeze({ match, buildScene, requiresScene() { return Boolean(sync() && (blueprint?.expectedAnimations || animations.size)); }, dispose() { disposed = true; inputRestore?.(); parseRestore?.(); runtimes.clear(); animations.clear(); blueprint = null; } });
  }
  return { installSketchfabSceneRecorder, createBlueprint, normalizeChannel, multiply, inverse };
});

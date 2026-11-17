import * as THREE from './vendor/three/three.module.js';
import { OrbitControls } from './vendor/three/addons/controls/OrbitControls.js';
import { GLTFLoader } from './vendor/three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from './vendor/three/addons/loaders/OBJLoader.js';
import { MTLLoader } from './vendor/three/addons/loaders/MTLLoader.js';
import { FBXLoader } from './vendor/three/addons/loaders/FBXLoader.js';
import { STLLoader } from './vendor/three/addons/loaders/STLLoader.js';
import { PLYLoader } from './vendor/three/addons/loaders/PLYLoader.js';
import { TGALoader } from './vendor/three/addons/loaders/TGALoader.js';
import { DDSLoader } from './vendor/three/addons/loaders/DDSLoader.js';
import { DRACOLoader } from './vendor/three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from './vendor/three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from './vendor/three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from './vendor/three/addons/environments/RoomEnvironment.js';

const VIRTUAL_BASE = 'shitu-bundle://local/';
const EMPTY_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPYsmXLfwAHWAMcZtFgAgAAAABJRU5ErkJggg==';
const FORMATS = new Set(['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply']);
const DECODER_FILES = new Set(['basis_transcoder.js', 'basis_transcoder.wasm'].map(name =>
  new URL('./vendor/three/addons/libs/basis/' + name, import.meta.url).href));

// Basis' Emscripten wrapper uses dynamic function construction. Keep it in a
// fixed, local worker so the application page never needs unsafe-eval.
class OfflineKTX2Loader extends KTX2Loader {
  init() {
    if (!this.transcoderPending) {
      const wasm = new URL('./vendor/three/addons/libs/basis/basis_transcoder.wasm', import.meta.url).href;
      this.transcoderPending = fetch(wasm).then(response => {
        if (!response.ok) throw new Error('KTX2 解码组件无法读取');
        return response.arrayBuffer();
      }).then(binary => {
        this.transcoderBinary = binary;
        this.workerPool.setWorkerCreator(() => {
          const worker = new Worker(new URL('./vendor/three/addons/libs/basis/shitu_basis_worker.js', import.meta.url));
          worker.addEventListener('error', event => worker.dispatchEvent(new MessageEvent('message', {
            data: { type: 'error', error: 'KTX2 解码组件运行失败：' + event.message }
          })));
          const copy = binary.slice(0);
          worker.postMessage({ type: 'init', config: this.workerConfig, transcoderBinary: copy }, [copy]);
          return worker;
        });
      });
    }
    return this.transcoderPending;
  }
  _createTextureFrom(result, container) {
    if (result.type === 'error') throw new Error('KTX2 解码失败：' + result.error);
    return super._createTextureFrom(result, container);
  }
  dispose() { this.workerPool.dispose(); }
}

function cancelled() { return Object.assign(new Error('模型预览已切换'), { name: 'AbortError' }); }
function abortable(work, signal, disposeLate = () => {}) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const abort = () => { if (!finished) { finished = true; reject(cancelled()); } };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(value => {
      if (finished) { disposeLate(value); return; }
      finished = true; signal.removeEventListener('abort', abort); resolve(value);
    }, error => {
      if (finished) return;
      finished = true; signal.removeEventListener('abort', abort); reject(error);
    });
  });
}
function cleanPath(value) {
  let input = String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
  try { input = decodeURIComponent(input); } catch {}
  if (input.includes('\0') || /[\x00-\x1f]/.test(input)) throw new Error('模型资源路径无效');
  const parts = [];
  for (const part of input.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw new Error('模型资源超出打包范围'); parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}
function directory(value) { const split = value.lastIndexOf('/'); return split < 0 ? '' : value.slice(0, split + 1); }
function virtualUrl(value) { return VIRTUAL_BASE + value.split('/').map(encodeURIComponent).join('/'); }
function disposeObject(object) {
  const geometries = new Set(), materials = new Set(), textures = new Set(), skeletons = new Set();
  object?.traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    if (node.skeleton) skeletons.add(node.skeleton);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const texture of textures) {
    texture.dispose();
    // GLTFLoader uses ImageBitmapLoader, whose backing bitmaps need explicit release.
    if (typeof texture.image?.close === 'function') texture.image.close();
  }
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}
function modelResources(options, warn) {
  const entry = cleanPath(options.entry || 'model.' + options.format);
  const top = new URL(options.url);
  const isAuthorized = parsed => {
    if (parsed.protocol !== 'shitu:' || parsed.hostname !== top.hostname || parsed.username || parsed.password) return false;
    if (top.hostname === 'asset') return parsed.pathname === top.pathname && parsed.searchParams.get('kind') === 'model';
    if (top.hostname === 'model') return Boolean(top.pathname.split('/')[1]) && parsed.pathname.split('/')[1] === top.pathname.split('/')[1];
    return false;
  };
  if (!isAuthorized(top)) throw new Error('模型预览地址无效');
  const files = Array.isArray(options.files) ? options.files : Object.entries(options.resources || {}).map(([path, url]) => ({ path, url }));
  const byPath = new Map(), byLowerPath = new Map(), byName = new Map(), authorized = new Set();
  for (const file of [...files, { path: entry, url: options.url }]) {
    if (!file || typeof file.url !== 'string') continue;
    const relative = cleanPath(file.path || file.relative);
    if (!relative) continue;
    const parsed = new URL(file.url);
    if (!isAuthorized(parsed)) throw new Error('模型资源地址无效');
    byPath.set(relative, parsed.href); byLowerPath.set(relative.toLowerCase(), parsed.href); authorized.add(parsed.href);
    const name = relative.split('/').pop().toLowerCase();
    const alternatives = byName.get(name) || new Set(); alternatives.add(parsed.href); byName.set(name, alternatives);
  }
  const resolve = input => {
    const value = String(input || '');
    if (/^(?:data:|blob:)/i.test(value)) return value;
    if (authorized.has(value)) return value;
    let relative;
    try {
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
        const parsed = new URL(value);
        if (parsed.protocol !== 'shitu-bundle:' || parsed.hostname !== 'local') throw new Error('外部引用');
        relative = cleanPath(parsed.pathname);
      } else relative = cleanPath(directory(entry) + value);
    } catch { warn('已跳过未打包的外部模型资源'); return EMPTY_IMAGE; }
    const exact = byPath.get(relative) || byLowerPath.get(relative.toLowerCase());
    if (exact) return exact;
    // FBX commonly stores an absolute authoring path but its loader requests only
    // the filename. Accept a basename only when it uniquely identifies a bundle file.
    const name = relative.split('/').pop().toLowerCase();
    const alternatives = byName.get(name);
    if (alternatives?.size === 1) return alternatives.values().next().value;
    warn('缺少模型资源：' + relative.slice(0, 240));
    return EMPTY_IMAGE;
  };
  return { entry, byPath, resolve, base: virtualUrl(directory(entry)), url: top.href };
}
function textureManager(resources, warn, render) {
  const manager = new THREE.LoadingManager();
  const blobs = new Set();
  const start = manager.itemStart.bind(manager), end = manager.itemEnd.bind(manager);
  let pending = 0;
  const waiters = new Set();
  manager.itemStart = url => { pending++; start(url); };
  manager.itemEnd = url => {
    end(url); pending = Math.max(0, pending - 1); render();
    if (!pending) for (const resolve of [...waiters]) { waiters.delete(resolve); resolve(); }
  };
  manager.onError = () => warn('部分贴图无法读取，已保留模型几何体');
  manager.setURLModifier(url => {
    if (DECODER_FILES.has(url)) return url;
    if (String(url).startsWith('blob:')) blobs.add(url);
    return resources.resolve(url);
  });
  manager.addHandler(/\.tga(?:[?#]|$)/i, new TGALoader(manager));
  manager.addHandler(/\.dds(?:[?#]|$)/i, new DDSLoader(manager));
  const settle = () => pending === 0 ? Promise.resolve() : new Promise(resolve => {
    const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
    const timer = setTimeout(() => { warn('部分贴图仍未完成加载'); done(); }, 30000);
    waiters.add(done);
  });
  return { manager, settle, blobs };
}
async function readResource(url, signal, type = 'arrayBuffer') {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('模型文件无法读取（' + response.status + '）');
  return response[type]();
}
function friendlyError(error, warnings) {
  if (error?.name === 'AbortError') return error;
  const detail = String(error?.message || error || '未知错误');
  if (/WebGL|context|GPU/i.test(detail)) return new Error('无法启动 3D 预览，请确认显卡驱动可用后重启拾图');
  if (/draco|meshopt|ktx2|basis/i.test(detail)) return new Error('压缩模型解码失败，请检查模型数据或导出普通 GLB 后重试');
  if (warnings.some(item => item.startsWith('缺少模型资源'))) return new Error('模型引用的文件不完整，请把模型、材质和贴图放在一起重新导入');
  return new Error('模型暂时无法预览：' + detail.slice(0, 500));
}

/** Create one local, independently disposable 3D viewport. */
export function create(container, options = {}) {
  if (!(container instanceof HTMLElement)) throw new Error('请提供模型预览容器');
  if (!document.querySelector('link[data-shitu-model-viewer]')) {
    const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./model-viewer.css', import.meta.url).href;
    stylesheet.dataset.shituModelViewer = 'true'; document.head.append(stylesheet);
  }
  let disposed = false, serial = 0, scope = null, model = null, wrapper = null, mixer = null;
  let playing = false, animationFrame = 0, lastFrame = 0, currentMetadata = null;
  const root = document.createElement('div'); root.className = 'shitu-model-viewer';
  const canvas = document.createElement('canvas'); canvas.className = 'shitu-model-canvas'; canvas.setAttribute('aria-label', '3D 模型预览：左键旋转，滚轮缩放，右键平移');
  canvas.tabIndex = 0;
  const toolbar = document.createElement('div'); toolbar.className = 'shitu-model-toolbar';
  const makeButton = (title, handler) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = title;
    button.addEventListener('click', event => { event.stopPropagation(); handler(); }); toolbar.append(button); return button;
  };
  const notice = document.createElement('div'); notice.className = 'shitu-model-notice'; notice.setAttribute('role', 'status');
  root.append(canvas, toolbar, notice); container.append(root);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  } catch (error) { root.remove(); throw friendlyError(error, []); }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, options.pixelRatio || 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x191b20);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false; controls.screenSpacePanning = true; controls.minDistance = 0.12; controls.maxDistance = 100;
  const lights = new THREE.Group();
  lights.add(new THREE.HemisphereLight(0xe8efff, 0x555050, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 3.2); key.position.set(3, 5, 4); lights.add(key);
  const fill = new THREE.DirectionalLight(0xc7dcff, 1.6); fill.position.set(-4, 2, -3); lights.add(fill); scene.add(lights);
  const grid = new THREE.GridHelper(4, 20, 0x565b66, 0x30343c); grid.position.y = -1.02;
  scene.add(grid);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = new RoomEnvironment();
  const environmentTarget = pmrem.fromScene(environment, 0.04);
  scene.environment = environmentTarget.texture; environment.dispose(); pmrem.dispose();
  const onStatus = value => { try { options.onStatus?.(value); } catch {} };
  const render = () => { if (!disposed) renderer.render(scene, camera); };
  const resize = () => {
    if (disposed) return;
    const bounds = root.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width || container.clientWidth || 640));
    const height = Math.max(1, Math.round(bounds.height || container.clientHeight || 480));
    camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); render();
  };
  function resetView() {
    const vertical = Math.PI * camera.fov / 360;
    const aspect = Math.max(0.2, camera.aspect);
    const distance = 1.7 / Math.sin(Math.min(vertical, Math.atan(Math.tan(vertical) * aspect)));
    camera.position.copy(new THREE.Vector3(1.25, 0.8, 1.6).normalize().multiplyScalar(distance));
    controls.target.set(0, 0, 0); controls.update(); render();
  }
  function frame(timestamp) {
    animationFrame = 0;
    if (disposed || !playing || !mixer) return;
    if (!document.hidden) { mixer.update(lastFrame ? Math.min(0.1, (timestamp - lastFrame) / 1000) : 0); render(); }
    lastFrame = timestamp; animationFrame = requestAnimationFrame(frame);
  }
  function setAnimation(value) {
    playing = Boolean(value && mixer); animationButton.textContent = playing ? '暂停动画' : '播放动画';
    if (animationFrame) cancelAnimationFrame(animationFrame); animationFrame = 0; lastFrame = 0;
    if (playing) animationFrame = requestAnimationFrame(frame);
  }
  makeButton('重置视角', resetView);
  const wireButton = makeButton('线框', () => {
    const wireframe = wireButton.getAttribute('aria-pressed') !== 'true'; wireButton.setAttribute('aria-pressed', String(wireframe));
    model?.traverse(node => { for (const material of Array.isArray(node.material) ? node.material : [node.material]) if (material && 'wireframe' in material) material.wireframe = wireframe; }); render();
  }); wireButton.setAttribute('aria-pressed', 'false');
  const animationButton = makeButton('播放动画', () => setAnimation(!playing)); animationButton.hidden = true;
  controls.addEventListener('change', render);
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(container);
  const onContextLost = event => { event.preventDefault(); notice.textContent = '显卡上下文已中断，请重新打开模型'; onStatus({ state: 'error', message: notice.textContent }); };
  canvas.addEventListener('webglcontextlost', onContextLost);
  const stopEvents = event => event.stopPropagation();
  // OrbitControls observes pointerup on ownerDocument. Let releases bubble so
  // a completed drag returns to its idle state and subsequent wheel zoom works.
  for (const type of ['wheel', 'pointerdown', 'dblclick', 'contextmenu']) canvas.addEventListener(type, stopEvents);
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  resize(); resetView();

  function clear() {
    serial++; scope?.controller.abort(); scope?.manager?.abort();
    if (scope) {
      scope.draco?.dispose(); scope.ktx2?.dispose();
      for (const url of scope.blobs) URL.revokeObjectURL(url);
      scope = null;
    }
    setAnimation(false);
    if (mixer && model) { mixer.stopAllAction(); mixer.uncacheRoot(model); } mixer = null;
    if (wrapper) scene.remove(wrapper); disposeObject(model); model = null; wrapper = null; currentMetadata = null;
    animationButton.hidden = true; wireButton.setAttribute('aria-pressed', 'false'); notice.textContent = ''; render();
  }
  async function load(settings) {
    if (disposed) throw new Error('模型预览已关闭');
    clear(); const token = serial;
    const format = String(settings?.format || '').replace(/^\./, '').toLowerCase();
    if (!FORMATS.has(format)) throw new Error('此格式需要先用本机建模软件转换为 GLB、FBX 或 OBJ 后预览');
    const warnings = [];
    const warn = message => {
      if (token !== serial || disposed) return;
      const value = String(message || '').slice(0, 500);
      if (!value || warnings.includes(value) || warnings.length >= 100) return;
      warnings.push(value); notice.textContent = value;
      try { options.onWarning?.(value); } catch {}
    };
    for (const warning of settings.warnings || []) warn(warning);
    for (const missing of settings.missing || []) warn('缺少模型资源：' + (typeof missing === 'string' ? missing : missing.path || missing.reference || '未知资源'));
    const resources = modelResources({ ...settings, format }, warn);
    const controller = new AbortController();
    const tracked = textureManager(resources, warn, render);
    const current = { controller, manager: tracked.manager, blobs: tracked.blobs, draco: null, ktx2: null }; scope = current;
    let object = null, animations = [];
    notice.textContent = '正在加载模型和贴图…'; onStatus({ state: 'loading', message: notice.textContent });
    try {
      const data = await readResource(resources.url, controller.signal, format === 'obj' ? 'text' : 'arrayBuffer');
      if (token !== serial || disposed) throw cancelled();
      if (format === 'glb' || format === 'gltf') {
        const loader = new GLTFLoader(tracked.manager);
        current.draco = new DRACOLoader(); current.draco.setWorkerLimit(2);
        current.ktx2 = new OfflineKTX2Loader(tracked.manager); current.ktx2.setWorkerLimit(2).detectSupport(renderer);
        loader.setDRACOLoader(current.draco).setKTX2Loader(current.ktx2).setMeshoptDecoder(MeshoptDecoder);
        const gltf = await abortable(loader.parseAsync(data, resources.base), controller.signal,
          value => disposeObject(value.scene || value.scenes?.[0]));
        object = gltf.scene || gltf.scenes?.[0]; animations = gltf.animations || [];
      } else if (format === 'obj') {
        const materialCreators = [];
        for (const [name, url] of resources.byPath) if (/\.mtl$/i.test(name)) {
          try {
            const text = await readResource(url, controller.signal, 'text');
            const creator = new MTLLoader(tracked.manager).setMaterialOptions({ side: THREE.DoubleSide }).parse(text, virtualUrl(directory(name)));
            materialCreators.push(creator);
          } catch (error) { if (controller.signal.aborted) throw cancelled(); warn('部分材质文件无法读取，将使用默认材质'); }
        }
        const loader = new OBJLoader(tracked.manager);
        if (materialCreators.length) loader.setMaterials({ create(name) {
          const creator = materialCreators.find(item => Object.hasOwn(item.materialsInfo, name));
          return creator ? creator.create(name) : new THREE.MeshStandardMaterial({ color: 0xb9c1ce, roughness: 0.6, side: THREE.DoubleSide });
        } });
        object = loader.parse(data);
      } else if (format === 'fbx') {
        object = new FBXLoader(tracked.manager).parse(data, resources.base); animations = object.animations || [];
      } else {
        const geometry = format === 'stl' ? new STLLoader(tracked.manager).parse(data) : new PLYLoader(tracked.manager).parse(data);
        const plyHeader = format === 'ply' ? new TextDecoder().decode(data.slice(0, 65536)) : '';
        const pointCloud = format === 'ply' && !(Number(/^element\s+face\s+(\d+)/m.exec(plyHeader)?.[1]) > 0);
        if (!pointCloud && !geometry.getAttribute('normal')) geometry.computeVertexNormals();
        const vertexColors = Boolean(geometry.getAttribute('color'));
        object = pointCloud
          ? new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xb9c1ce, size: 0.012, vertexColors }))
          : new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: vertexColors ? 0xffffff : 0xb9c1ce, roughness: 0.6, metalness: 0.08, side: THREE.DoubleSide, vertexColors }));
      }
      await abortable(tracked.settle(), controller.signal);
      if (controller.signal.aborted || token !== serial || disposed) throw cancelled();
      if (!object) throw new Error('模型没有可预览的场景');
      object.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(object);
      const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
      if (bounds.isEmpty() || ![...size.toArray(), ...center.toArray()].every(Number.isFinite)) throw new Error('模型没有有效的几何体');
      let meshes = 0, vertices = 0, triangles = 0;
      object.traverse(node => {
        const geometry = node.geometry;
        if (!geometry?.getAttribute('position')) return;
        if (node.isMesh) meshes++;
        vertices += geometry.getAttribute('position').count;
        if (node.isMesh) triangles += Math.floor((geometry.index?.count || geometry.getAttribute('position').count) / 3) * (node.isInstancedMesh ? node.count : 1);
      });
      if (!vertices) throw new Error('模型没有可预览的顶点');
      const scale = 2 / Math.max(size.x, size.y, size.z, 0.000001);
      wrapper = new THREE.Group(); wrapper.scale.setScalar(scale); wrapper.position.copy(center).multiplyScalar(-scale); wrapper.add(object); scene.add(wrapper);
      grid.position.y = bounds.min.y * scale - center.y * scale - 0.02;
      model = object; object = null;
      if (animations.length) {
        mixer = new THREE.AnimationMixer(model);
        mixer.clipAction(animations[0]).play(); animationButton.hidden = false;
      }
      currentMetadata = { format, meshes, vertices, triangles, animations: animations.length, bounds: size.toArray(), warnings };
      notice.textContent = warnings.length ? warnings[0] : '左键旋转 · 滚轮缩放 · 右键平移';
      resize(); resetView(); render();
      onStatus({ state: 'ready', metadata: currentMetadata });
      return currentMetadata;
    } catch (error) {
      disposeObject(object);
      if (controller.signal.aborted || token !== serial || disposed) throw cancelled();
      const failure = friendlyError(error, warnings);
      notice.textContent = failure.message; onStatus({ state: 'error', message: failure.message });
      throw failure;
    }
  }
  function captureJPEG({ quality = 0.88 } = {}) {
    if (!model || disposed) throw new Error('模型尚未完成加载');
    render(); return canvas.toDataURL('image/jpeg', Math.max(0.1, Math.min(1, quality)));
  }
  function dispose() {
    if (disposed) return;
    clear(); disposed = true; resizeObserver.disconnect(); controls.dispose();
    canvas.removeEventListener('webglcontextlost', onContextLost);
    grid.geometry.dispose(); for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) material.dispose();
    environmentTarget.dispose(); renderer.dispose(); renderer.forceContextLoss(); root.remove();
  }
  return { load, clear, dispose, resize, resetView, captureJPEG, setAnimation,
    get metadata() { return currentMetadata; }, get canvas() { return canvas; } };
}

window.ShituModelViewer = { create };

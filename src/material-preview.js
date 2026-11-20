(() => {
  'use strict';
  let threeModule;
  async function create(container) {
    const THREE = await (threeModule ||= import('./vendor/three/three.module.js'));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#181a20');
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 0, 4.5);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.domElement.setAttribute('aria-label', '材质预览，可拖动旋转和滚轮缩放');
    renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;cursor:grab';
    container.replaceChildren(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xd9e4ff, 0x383029, 2));
    const key = new THREE.DirectionalLight(0xffedcf, 4); key.position.set(-2, 3, 4); scene.add(key);
    const rim = new THREE.DirectionalLight(0x9abaff, 3); rim.position.set(3, 1, -2); scene.add(rim);
    const material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0,
      specularIntensity: 1, side: THREE.DoubleSide, transparent: true, alphaTest: 0.01 });
    const object = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 96), material);
    scene.add(object);
    let disposed = false, shape = 'sphere', textures = [], dragging = null;
    function render() { if (!disposed) renderer.render(scene, camera); }
    function resize() {
      if (disposed) return;
      const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); render();
    }
    const observer = new ResizeObserver(resize); observer.observe(container);
    function pointerDown(event) {
      if (event.button !== 0) return;
      dragging = { x: event.clientX, y: event.clientY, id: event.pointerId };
      renderer.domElement.setPointerCapture(event.pointerId);
    }
    function pointerMove(event) {
      if (!dragging || dragging.id !== event.pointerId) return;
      object.rotation.y += (event.clientX - dragging.x) * 0.009;
      object.rotation.x += (event.clientY - dragging.y) * 0.009;
      dragging.x = event.clientX; dragging.y = event.clientY; render();
    }
    function pointerUp() { dragging = null; }
    function wheel(event) {
      event.preventDefault();
      camera.position.z = Math.max(2.3, Math.min(9, camera.position.z * Math.exp(event.deltaY * 0.001)));
      render();
    }
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointermove', pointerMove);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    renderer.domElement.addEventListener('pointercancel', pointerUp);
    renderer.domElement.addEventListener('wheel', wheel, { passive: false });
    function texture(image, color = false, intensityAlpha = false) {
      const data = new Uint8Array(image.data);
      if (intensityAlpha) for (let p = 0; p < data.length; p += 4) data[p + 3] = data[p];
      const value = new THREE.DataTexture(data, image.width, image.height, THREE.RGBAFormat);
      value.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      value.flipY = true; value.wrapS = value.wrapT = THREE.RepeatWrapping;
      value.minFilter = THREE.LinearMipmapLinearFilter; value.magFilter = THREE.LinearFilter;
      value.generateMipmaps = true; value.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      value.needsUpdate = true; textures.push(value); return value;
    }
    function update(image, options = {}) {
      if (disposed) return;
      // Preview uses a bounded texture; the editor always exports original resolution.
      let input = image;
      const scale = Math.min(1, 512 / Math.max(image.width, image.height));
      if (scale < 1) {
        const original = document.createElement('canvas'); original.width = image.width; original.height = image.height;
        original.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
        const target = document.createElement('canvas'); target.width = Math.max(1, Math.round(image.width * scale)); target.height = Math.max(1, Math.round(image.height * scale));
        target.getContext('2d').drawImage(original, 0, 0, target.width, target.height);
        input = target.getContext('2d').getImageData(0, 0, target.width, target.height);
      }
      textures.forEach(item => item.dispose()); textures = [];
      const generate = window.ShituTextureMaps.generate;
      const settings = { ...options, blur: (options.blur || 0) * scale, strength: (options.strength || 3) * scale };
      material.map = texture(generate(input, { ...options, type: 'color', brightness: 0, contrast: 1, gamma: 1, invert: false, blur: 0 }), true);
      material.normalMap = texture(generate(input, { ...settings, type: 'normal' }));
      material.normalScale.set(1, 1);
      material.displacementMap = texture(generate(input, { ...settings, type: 'displacement' }));
      material.displacementScale = 0.16; material.displacementBias = -0.08;
      material.roughnessMap = texture(generate(input, { ...settings, type: 'roughness' }));
      material.specularIntensityMap = texture(generate(input, { ...settings, type: 'specular' }), false, true);
      material.needsUpdate = true; resize();
    }
    function setShape(next) {
      if (disposed || next === shape) return;
      shape = next === 'plane' ? 'plane' : 'sphere';
      object.geometry.dispose();
      object.geometry = shape === 'plane' ? new THREE.PlaneGeometry(2.3, 2.3, 160, 160) : new THREE.SphereGeometry(1, 160, 96);
      object.rotation.set(shape === 'plane' ? -0.15 : 0, shape === 'plane' ? -0.3 : 0, 0);
      render();
    }
    function dispose() {
      if (disposed) return;
      disposed = true; observer.disconnect();
      textures.forEach(item => item.dispose()); object.geometry.dispose(); material.dispose();
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointermove', pointerMove);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointercancel', pointerUp);
      renderer.domElement.removeEventListener('wheel', wheel);
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    }
    resize();
    return { update, setShape, dispose };
  }
  window.ShituMaterialPreview = { create };
})();

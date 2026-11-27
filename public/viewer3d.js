// Visionneuse 3D de Carchon OS (three.js) : tourner, zoomer, cliquer une pièce pour voir ses cotes.
// Au clic sur « Générer la production », quatre vues sont capturées et transmises à l'assistant.
import * as THREE from 'three';
import { OrbitControls } from '/static/vendor/three/examples/jsm/controls/OrbitControls.js';

const WOOD = [0xc8a27a, 0xb08660, 0xd8b892, 0x9c7552, 0xe2c9a6, 0xa88a6a, 0xc19a6b, 0x8e6a4a];

async function mount(el) {
  const res = await fetch(el.dataset.model);
  if (!res.ok) { el.querySelector('.v3d-msg').textContent = 'Modèle 3D illisible : ' + (await res.text()); return; }
  const model = await res.json();
  const W = () => el.clientWidth, H = () => el.clientHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W(), H());
  renderer.setClearColor(0xf7f4ef);
  el.querySelector('.v3d-msg').remove();
  el.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(1, 2, 1.5); scene.add(sun);
  const root = new THREE.Group();
  // Les modèles de menuiserie sont souvent dessinés Z vers le haut : on redresse.
  root.rotation.x = -Math.PI / 2;
  scene.add(root);
  const groups = [...new Set(model.parts.map((p) => p.g || ''))];
  const meshes = [];
  for (const p of model.parts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p.p, 3));
    g.setIndex(p.i);
    g.computeVertexNormals();
    const color = WOOD[groups.indexOf(p.g || '') % WOOD.length];
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, side: THREE.DoubleSide }));
    m.userData = p;
    root.add(m);
    root.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), new THREE.LineBasicMaterial({ color: 0x3a3029, transparent: true, opacity: 0.55 })));
    meshes.push(m);
  }
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const radius = size.length() / 2 || 1;
  const camera = new THREE.PerspectiveCamera(35, W() / H(), radius / 100, radius * 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = true;
  const VIEWS = { iso: [1, 0.8, 1.2], face: [0, 0, 1], dessus: [0, 1, 0.0001], cote: [1, 0, 0] };
  const look = (k) => {
    const d = new THREE.Vector3(...VIEWS[k]).normalize();
    camera.position.copy(center).add(d.multiplyScalar(radius / Math.tan((camera.fov * Math.PI) / 360) * 1.15));
    camera.lookAt(center); controls.update();
  };
  look('iso');
  const info = el.querySelector('.v3d-info');
  info.textContent = `${model.parts.length} pièces · ${Math.round(size.x)} × ${Math.round(size.z)} × ${Math.round(size.y)} mm (L × P × H)`;
  // Clic sur une pièce : nom, ensemble, cotes.
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  let picked = null;
  renderer.domElement.addEventListener('click', (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObjects(meshes)[0];
    if (picked) picked.material.emissive.setHex(0x000000);
    picked = hit ? hit.object : null;
    if (picked) {
      picked.material.emissive.setHex(0x552200);
      const p = picked.userData;
      info.textContent = `${p.g ? p.g + ' › ' : ''}${p.n} · ${p.d.map((x) => Math.round(x)).join(' × ')} mm`;
    }
  });
  el.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => look(b.dataset.view)));
  new ResizeObserver(() => { renderer.setSize(W(), H()); camera.aspect = W() / H(); camera.updateProjectionMatrix(); }).observe(el);
  (function tick() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(tick); })();

  // Quatre vues pour l'assistant (JPEG 1280 px).
  el.capture = () => {
    const prev = [renderer.getSize(new THREE.Vector2()), camera.position.clone(), camera.aspect];
    if (picked) picked.material.emissive.setHex(0x000000);
    renderer.setSize(1280, 860, false); camera.aspect = 1280 / 860; camera.updateProjectionMatrix();
    const out = {};
    for (const k of Object.keys(VIEWS)) { look(k); renderer.render(scene, camera); out[k] = renderer.domElement.toDataURL('image/jpeg', 0.85); }
    renderer.setSize(prev[0].x, prev[0].y); camera.aspect = prev[2]; camera.updateProjectionMatrix(); camera.position.copy(prev[1]); controls.update();
    return out;
  };
}

document.querySelectorAll('.v3d[data-model]').forEach((el) => mount(el).catch((e) => { const m = el.querySelector('.v3d-msg'); if (m) m.textContent = 'Visionneuse indisponible : ' + e.message; }));

// « Générer la production » : on joint les vues du modèle 3D affiché.
document.querySelectorAll('form[data-views]').forEach((f) => f.addEventListener('submit', (e) => {
  const v = document.querySelector('.v3d[data-model]');
  if (!v || !v.capture || f.dataset.captured) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (f.dataset.confirm && !window.confirm(f.dataset.confirm)) return;
  const btn = f.querySelector('button'); if (btn) { btn.disabled = true; btn.textContent = 'Envoi du modèle à l’assistant…'; }
  try {
    const views = v.capture();
    for (const [k, data] of Object.entries(views)) { const i = document.createElement('input'); i.type = 'hidden'; i.name = 'vue_' + k; i.value = data; f.appendChild(i); }
  } catch (err) { /* sans les vues, l'assistant lit quand même la nomenclature 3D */ }
  f.dataset.captured = '1';
  f.submit();
}));

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituAssetFolderDrag = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create({ prepare, current = () => true, targetAt = () => null, outside = () => false,
    start = () => {}, move = () => {}, target = () => {}, finish = () => {}, drop = () => {}, external = () => {}, error = () => {}, threshold = 6 }) {
    let gesture = null;
    function endGesture(reason, destination) {
      const previous = gesture;
      if (!previous) return;
      gesture = null;
      if (!previous.active) return;
      target(null, previous);
      finish(reason, previous);
      if (reason === 'drop' && destination) drop(previous.payload, destination);
      else if (reason === 'external') external(previous.payload);
    }
    function begin(event, origin) {
      if (event.button !== 0 || event.isPrimary === false || event.pointerType === 'touch') return false;
      endGesture('cancel');
      gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin, active: false, payload: null, destination: null };
      return true;
    }
    function update(event) {
      if (!gesture || event.pointerId !== gesture.pointerId) return false;
      if (!(event.buttons & 1)) { endGesture('cancel'); return false; }
      try {
        if (!gesture.active) {
          if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < threshold) return false;
          const payload = prepare(gesture.origin);
          if (!payload) { endGesture('cancel'); return false; }
          gesture.payload = payload; gesture.active = true;
          start(gesture, event);
        }
        if (!current(gesture.payload)) { endGesture('cancel'); return false; }
        event.preventDefault?.();
        if (outside(event)) { endGesture('external'); return true; }
        move(event, gesture);
        gesture.destination = targetAt(event, gesture.payload);
        target(gesture.destination, gesture);
        return true;
      } catch (cause) { endGesture('cancel'); error(cause); return false; }
    }
    function release(event) {
      if (!gesture || event.pointerId !== gesture.pointerId) return false;
      if (!gesture.active) { endGesture('cancel'); return false; }
      try {
        event.preventDefault?.();
        const destination = current(gesture.payload) && !outside(event) ? targetAt(event, gesture.payload) : null;
        endGesture(destination ? 'drop' : 'cancel', destination);
        return true;
      } catch (cause) { endGesture('cancel'); error(cause); return false; }
    }
    return Object.freeze({ begin, move: update, end: release, cancel: () => endGesture('cancel'),
      get active() { return Boolean(gesture?.active); }, get pending() { return Boolean(gesture); } });
  }
  return Object.freeze({ create });
});

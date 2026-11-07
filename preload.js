const { ipcRenderer } = require('electron');

try {
  let cfg = ipcRenderer.sendSync('stretch:get');
  const active = () => cfg.enabled;

  const real = {};
  for (const name of ['innerWidth', 'innerHeight']) {
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    real[name] = () => (descriptor.get ? descriptor.get.call(window) : descriptor.value);
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      get: () => (active() ? cfg[name === 'innerWidth' ? 'width' : 'height'] : real[name]()),
      set() {},
    });
  }

  const patch = (proto, prop, key, applies) => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
    if (!descriptor || !descriptor.get) return;
    Object.defineProperty(proto, prop, {
      ...descriptor,
      get() {
        return active() && applies(this) ? cfg[key] : descriptor.get.call(this);
      },
    });
  };
  patch(Element.prototype, 'clientWidth', 'width', (el) => el === document.documentElement);
  patch(Element.prototype, 'clientHeight', 'height', (el) => el === document.documentElement);
  if (window.visualViewport) {
    patch(VisualViewport.prototype, 'width', 'width', () => true);
    patch(VisualViewport.prototype, 'height', 'height', () => true);
  }

  const ratio = (axis) => {
    if (!active() || !cfg.realWidth || !cfg.realHeight) return 1;
    return axis === 'x' ? cfg.width / cfg.realWidth : cfg.height / cfg.realHeight;
  };

  for (const proto of [MouseEvent.prototype, PointerEvent.prototype, WheelEvent.prototype]) {
    for (const [prop, axis] of [['clientX', 'x'], ['clientY', 'y'], ['x', 'x'], ['y', 'y'], ['pageX', 'x'], ['pageY', 'y']]) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
      if (!descriptor || !descriptor.get) continue;
      Object.defineProperty(proto, prop, {
        ...descriptor,
        get() {
          return descriptor.get.call(this) * ratio(axis);
        },
      });
    }
  }

  const toVirtual = (rect) => new DOMRect(rect.x * ratio('x'), rect.y * ratio('y'), rect.width * ratio('x'), rect.height * ratio('y'));
  const nativeRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const rect = nativeRect.call(this);
    return active() ? toVirtual(rect) : rect;
  };
  const nativeRects = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function () {
    const rects = nativeRects.call(this);
    return active() ? Array.from(rects, toVirtual) : rects;
  };

  for (const proto of [Document.prototype, ShadowRoot.prototype]) {
    for (const name of ['elementFromPoint', 'elementsFromPoint']) {
      const native = proto[name];
      if (!native) continue;
      proto[name] = function (x, y) {
        return native.call(this, x / ratio('x'), y / ratio('y'));
      };
    }
  }

  const STYLE_ID = 'simplicity-stretch';
  const apply = () => {
    const root = document.documentElement;
    if (!root) return false;
    let style = document.getElementById(STYLE_ID);
    if (!active()) {
      if (style) style.remove();
      return true;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      root.appendChild(style);
    }
    style.textContent = `html{position:absolute!important;left:0!important;top:0!important;width:${cfg.width}px!important;height:${cfg.height}px!important;overflow:hidden!important;transform-origin:0 0!important;transform:scale(${cfg.realWidth / cfg.width},${cfg.realHeight / cfg.height})!important}`;
    return true;
  };

  if (!apply()) {
    const observer = new MutationObserver(() => {
      if (apply()) observer.disconnect();
    });
    observer.observe(document, { childList: true });
  }

  ipcRenderer.on('stretch:update', (event, next) => {
    cfg = next;
    apply();
    window.dispatchEvent(new Event('resize'));
  });
} catch (err) {
  console.error('[stretch] could not start:', err);
}

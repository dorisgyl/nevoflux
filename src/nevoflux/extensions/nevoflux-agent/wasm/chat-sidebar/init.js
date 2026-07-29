import init, * as bindings from './chat-sidebar-41b8a1add9cc8819.js';
const wasm = await init({ module_or_path: './chat-sidebar-41b8a1add9cc8819_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
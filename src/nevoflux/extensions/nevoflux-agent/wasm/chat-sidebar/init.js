import init, * as bindings from './chat-sidebar-6bac43a869e6157d.js';
const wasm = await init({ module_or_path: './chat-sidebar-6bac43a869e6157d_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
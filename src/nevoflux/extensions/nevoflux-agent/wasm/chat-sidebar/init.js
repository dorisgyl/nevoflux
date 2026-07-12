import init, * as bindings from './chat-sidebar-ef63a6b52b918c03.js';
const wasm = await init({ module_or_path: './chat-sidebar-ef63a6b52b918c03_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));